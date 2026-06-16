// This's the worker source code.
export default {
  async fetch(request, env, ctx) {
    // ١) POST فقط
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    // مسار منفصل: إشعار "طلب جديد" من المتصفح — يرسل رقم الطلب فقط، والووركر يجيب التفاصيل ويبلّغ ديسكورد
    if (new URL(request.url).pathname === "/new-order") {
      return handleNewOrder(request, env);
    }

    // ٢) نقرأ الإشعار
    let event;
    try { event = await request.json(); }
    catch { return new Response("Bad Request", { status: 400 }); }

    // ٣) تحقق أمني: هل الإشعار من Moyasar؟
    if (!event || event.secret_token !== env.MOYASAR_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // ٤) حدث الدفع الناجح فقط
    if (event.type !== "payment_paid") return new Response("Ignored", { status: 200 });

    // معرّف الدفعة فقط هو ما نأخذه من الجسم — الباقي نتحقق منه من واجهة ميسر
    const paymentId = event.data?.id;
    if (!paymentId || !/^[A-Za-z0-9-]{6,60}$/.test(paymentId)) {
      return new Response("Bad payment id", { status: 200 });
    }

    // ٥) نعيد جلب الدفعة من ميسر نفسها (لا نثق بجسم الإشعار)
    const payment = await fetchMoyasarPayment(paymentId, env);
    if (!payment) return new Response("Payment lookup failed", { status: 500 });

    if (payment.status !== "paid") return new Response("Not paid", { status: 200 });
    if (payment.currency !== "SAR") return new Response("Bad currency", { status: 200 });

    // معرّف الطلب يؤخذ من رد ميسر الموثوق، مع التحقق من صيغته (يمنع حقن المسار)
    const orderId = payment.metadata?.order_id;
    if (!orderId || !/^[A-Za-z0-9]{6,40}$/.test(orderId)) {
      return new Response("Bad order id", { status: 200 });
    }

    // ٦) تسجيل دخول حساب الووركر
    const idToken = await getAdminToken(env);
    if (!idToken) return new Response("Auth failed", { status: 500 });

    // ٧) جلب الطلب الحقيقي
    const docUrl =
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents/orders/${orderId}`;

    const orderRes = await fetch(docUrl, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!orderRes.ok) return new Response("Order not found", { status: 200 });
    const orderDoc = await orderRes.json();

    // ٨) عدم التكرار: إذا الطلب مدفوع مسبقاً نتوقف
    if (orderDoc.fields?.paid?.booleanValue === true) {
      return new Response("Already paid", { status: 200 });
    }

    // ٩) التحقق من المبلغ مقابل إجمالي الطلب الحقيقي
    const t = orderDoc.fields?.total;
    const orderTotal = Number(t?.integerValue ?? t?.doubleValue ?? 0);
    const expectedAmount = Math.round(orderTotal * 100);
    if (orderTotal <= 0 || payment.amount !== expectedAmount) {
      console.log(`Amount mismatch: paid ${payment.amount}, expected ${expectedAmount}`);
      return new Response("Amount mismatch", { status: 200 });
    }

    // ١٠) كل شيء سليم — نعلّم الطلب مدفوعاً (حقول محددة فقط)
    const patchUrl = docUrl +
      "?updateMask.fieldPaths=paid" +
      "&updateMask.fieldPaths=paidAt" +
      "&updateMask.fieldPaths=moyasarPaymentId" +
      "&currentDocument.exists=true";

    const patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          paid: { booleanValue: true },
          paidAt: { timestampValue: new Date().toISOString() },
          moyasarPaymentId: { stringValue: payment.id },
        },
      }),
    });

    if (!patchRes.ok) {
      console.log("Firestore write failed:", await patchRes.text());
      return new Response("Write failed", { status: 500 });
    }

    // إشعار ديسكورد بحالة "مدفوع" — في الخلفية حتى لا نؤخر رد 200 لميسر
    ctx.waitUntil(sendDiscordOrder(env, orderFromFields(orderId, orderDoc.fields || {}), true));

    return new Response("OK", { status: 200 });
  },

  // مهمة يومية مجدولة (Cron) — تحذف الطلبات غير المدفوعة "قيد المراجعة" الأقدم من 4 أيام
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupUnpaidOrders(env));
  },
};

// إشعار "طلب جديد" (غير مدفوع) — يُستدعى من المتصفح برقم الطلب فقط
async function handleNewOrder(request, env) {
  // الطبقة 1: سر مشترك في الهيدر — يوقف السبام العشوائي والبوتات اللي تضرب المسار مباشرة.
  // (السر مرئي في كود المتجر، فهو يصدّ الضرب الأعمى لا المهاجم اللي يقرأ المصدر — لذلك الطبقة 2 (rate limit) ضرورية.)
  if (request.headers.get("x-nv-secret") !== env.NEW_ORDER_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response("Bad Request", { status: 400 }); }

  const orderId = body?.orderId;
  if (!orderId || !/^[A-Za-z0-9]{6,40}$/.test(orderId)) {
    return new Response("Bad order id", { status: 400 });
  }

  const idToken = await getAdminToken(env);
  if (!idToken) return new Response("Auth failed", { status: 500 });

  const docUrl =
    `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}` +
    `/databases/(default)/documents/orders/${orderId}`;
  const orderRes = await fetch(docUrl, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!orderRes.ok) return new Response("Order not found", { status: 200 });

  const f = (await orderRes.json()).fields || {};
  // نبلّغ فقط للطلبات الجديدة غير المدفوعة — يمنع إعادة تحفيز إشعار لطلب قديم أو مدفوع
  if (f.paid?.booleanValue === true) return new Response("Already paid", { status: 200 });
  if ((f.status?.stringValue || "") !== "قيد المراجعة") return new Response("Ignored", { status: 200 });

  await sendDiscordOrder(env, orderFromFields(orderId, f), false);
  return new Response("OK", { status: 200 });
}

async function fetchMoyasarPayment(id, env) {
  // مصادقة Basic: المفتاح السري كاسم مستخدم وكلمة المرور فارغة
  const auth = btoa(`${env.MOYASAR_SECRET_KEY}:`);
  const res = await fetch(`https://api.moyasar.com/v1/payments/${id}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// ===== توكن الووركر مع cache — نعيد استخدامه بدل تسجيل دخول جديد مع كل طلب =====
let _tok = null, _exp = 0;
async function getAdminToken(env) {
  const now = Date.now();
  if (_tok && now < _exp - 5 * 60 * 1000) return _tok;  // صالح لساعة — نعيد استخدامه حتى يتبقى أقل من 5 دقائق
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: env.WORKER_ADMIN_EMAIL,
      password: env.WORKER_ADMIN_PASSWORD,
      returnSecureToken: true,
    }),
  });
  if (!res.ok) return null;
  const d = await res.json();
  _tok = d.idToken || null;
  _exp = now + Number(d.expiresIn || 3600) * 1000;
  return _tok;
}

// ===== إشعارات ديسكورد =====
// ننظّف القيم اللي تروح لديسكورد (عشان ما يكسر التنسيق ولا أحد يلعب بالـ markdown/المنشن)
const cleanForDiscord = (s, max = 100) => String(s ?? "").replace(/[`@\\]/g, "").replace(/[<>]/g, "").slice(0, max);

// نفس تنسيق رقم الطلب في المتجر
function fmtId(id) {
  const s = String(id).replace(/[^A-Za-z0-9]/g, "").slice(0, 16).toUpperCase();
  return s.slice(0, 8) + "-" + s.slice(8, 16);
}

// نحوّل حقول Firestore REST لكائن طلب بسيط نستخدمه في الإشعار
function orderFromFields(orderId, f) {
  return {
    id: fmtId(orderId),
    username: f.username?.stringValue || "",
    email: f.email?.stringValue || "",
    discord: f.discord?.stringValue || "",
    total: Number(f.total?.integerValue ?? f.total?.doubleValue ?? 0),
    items: (f.items?.arrayValue?.values || []).map(v => {
      const it = v.mapValue?.fields || {};
      return {
        icon: it.icon?.stringValue || "",
        name: it.name?.stringValue || "",
        qty: Number(it.qty?.integerValue || 0),
        price: Number(it.price?.integerValue || 0),
      };
    }),
  };
}

// إشعار موحّد: paid=false → "طلب جديد" (بنفسجي)، paid=true → "تم الدفع" (أخضر)
async function sendDiscordOrder(env, o, paid = false) {
  if (!env.DISCORD_ORDER_WEBHOOK) return;
  try {
    await fetch(env.DISCORD_ORDER_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: paid
          ? "<@&1514779833253630083> ✅ تم الدفع!"
          : "<@&1514779833253630083> 🔔 طلب جديد!",
        allowed_mentions: { roles: ["1514779833253630083"] },
        embeds: [{
          title: paid ? "✅ تم الدفع — طلب Night Void" : "🛒 طلب جديد في متجر Night Void!",
          color: paid ? 0x34d399 : 0x8b5cf6,
          fields: [
            { name: "رقم الطلب",      value: cleanForDiscord("#" + o.id),            inline: true },
            { name: "اسم الحساب",     value: cleanForDiscord(o.username),            inline: true },
            { name: "يوزر الديسكورد", value: "`" + cleanForDiscord(o.discord) + "`", inline: true },
            { name: "البريد",         value: cleanForDiscord(o.email),               inline: true },
            { name: "الإجمالي",       value: cleanForDiscord(o.total) + " ر.س",      inline: true },
            { name: "حالة الدفع",     value: paid ? "✅ مدفوع" : "⏳ بانتظار الدفع", inline: true },
            { name: "المنتجات",       value: cleanForDiscord(o.items.map(it => `${it.icon} ${it.name} × ${it.qty} — ${Number(it.price) * Number(it.qty)} ر.س`).join("\n"), 1000) },
          ],
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (e) {
    console.log("Discord notify failed:", e);
  }
}

// ===== تنظيف الطلبات غير المدفوعة بعد 4 أيام =====
async function cleanupUnpaidOrders(env) {
  const idToken = await getAdminToken(env);
  if (!idToken) return;
  const base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const cutoff = new Date(Date.now() - 4 * 86400 * 1000).toISOString();

  // فلتر على createdAt فقط (حقل واحد = فهرس تلقائي، بدون الحاجة لـ composite index)
  const res = await fetch(`${base}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "orders" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "createdAt" },
            op: "LESS_THAN",
            value: { timestampValue: cutoff },
          },
        },
      },
    }),
  });
  if (!res.ok) { console.log("cleanup query failed:", await res.text()); return; }

  const rows = await res.json();
  for (const row of rows) {
    const d = row.document;
    if (!d) continue;
    const f = d.fields || {};
    if (f.paid?.booleanValue === true) continue;                    // مدفوع → لا يُحذف
    if ((f.status?.stringValue || "") !== "قيد المراجعة") continue;  // ليس "قيد المراجعة" → لا يُحذف
    // قاعدة الحذف في Firestore تفرض نفس الشرطين (دفاع متعدد الطبقات)
    await fetch(`https://firestore.googleapis.com/v1/${d.name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${idToken}` },
    });
  }
}
