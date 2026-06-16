# Night Void Store (NVS)

A Discord-services store I built and shipped: people browse services, order from the site, and pay either by card/Apple Pay or local transfer. It's a static front-end on Firebase with a Cloudflare Worker doing the part that actually has to be trusted — confirming payments.

Heads up before you clone: this isn't a one-command deploy. The front-end is plain HTML/JS and will open in any browser, but the working store depends on *my* Firebase project, *my* Moyasar merchant account, a deployed Worker holding secrets, and Firestore rules locked to specific user UIDs. So treat this as a reference build you read and adapt, not a template you `git clone` and run. I'll point out every place you'd have to swap in your own values.

## What it does

- Customers register, browse services by category, add to cart, and place an order.
- Payment runs through Moyasar (mada, cards, Apple Pay) or local bank transfer via a Discord ticket.
- A Cloudflare Worker listens to Moyasar's webhook, re-fetches the payment from Moyasar's API, checks the amount against the real order total in Firestore, and only then marks the order paid. The browser never gets to say "this is paid."
- Admins manage products, categories, order status, and team assignment from an in-site panel. Every status/payment/assignment change is written to an append-only audit log.
- An owner-only panel handles maintenance mode, a full site lockdown with a custom message, a site-wide announcement bar, and the post-order thank-you text.
- A scheduled Worker job deletes unpaid "under review" orders older than 4 days.

## Files

| File | What it is |
|------|-----------|
| `index.html` | Landing page |
| `night-void-store.html` | The actual store — auth, cart, checkout, admin + owner panels, all logic |
| `tos.html` | Terms of service (Arabic) |
| `worker.js` | Cloudflare Worker: Moyasar webhook verification, new-order Discord notify, daily cleanup cron |
| `firestore-rules.txt` | Firestore security rules — the real access control |
| `.github/workflows/` | GitHub Actions (Discord push notifications) |

## How the pieces fit

```
Browser (Firebase Auth + Firestore)
   │  places order  → Firestore  → notifies Worker (order id only)
   │  pays via Moyasar widget
   ▼
Moyasar  → webhook → Cloudflare Worker
                        │ re-fetches payment from Moyasar API
                        │ checks amount vs Firestore order total
                        │ marks order paid (only fields it's allowed to touch)
                        ▼
                     Firestore  → Discord webhook ("paid")
```

The design rule across the whole thing: the browser is never trusted with anything that matters. It can create an order, but it can't mark it paid, can't set its own total past the rules, and can't see other people's orders. That's enforced in `firestore-rules.txt`, which is where you should look first if you want to understand the security model — not the JS.

## Stack

- **Front-end:** vanilla HTML/CSS/JS, no framework, no build step
- **Auth + DB:** Firebase Auth, Firestore
- **Payments:** Moyasar (Web registration for Apple Pay)
- **Server-side trust:** Cloudflare Worker (webhook verification + cron cleanup)
- **Notifications:** Discord webhooks, GitHub Actions

## If you actually want to run your own version

You'd need to replace, at minimum:

1. **Firebase** — your own project. Swap `firebaseConfig` in `night-void-store.html`. The `apiKey` there is public by design (Firebase keys aren't secrets), but the project is yours.
2. **Admin/owner UIDs** — `ADMIN_UIDS`, `OWNER_UID`, and the `TEAM` list in the HTML, plus the matching UIDs in `firestore-rules.txt`. These are hard-coded to my accounts. Nothing works as admin until you put yours in both places.
3. **Moyasar** — your publishable key (`MOYASAR_PK`). Right now it's a **test** key (`pk_test_...`), so payments are fake until you change it. You also need a real merchant account and Apple Pay web-registration done on your domain.
4. **The Worker** — deploy `worker.js` yourself and set its secrets as Worker environment variables (Moyasar secret + webhook secret, Firebase project id + a service account login, Discord webhook, the shared new-order secret). Then point `WORKER_NEW_ORDER_URL` in the HTML at your deployed Worker.
5. **Firestore rules** — publish `firestore-rules.txt` to your project. Without these, the front-end's security guarantees don't exist.

## A note on secrets

Some values currently live in the front-end source: the shared new-order secret and the Worker URL. The new-order secret only exists to slow down blind bots hitting the endpoint — it's visible in page source, so the real protection is rate-limiting at Cloudflare, not the secret itself. The genuinely sensitive keys (Moyasar secret, Firebase admin login, Discord webhook) live only in the Worker's environment and never touch the browser. If you fork this, keep it that way — don't move any of those into the HTML.

## Status

Built, deployed, and running on Firebase Hosting with Apple Pay registered. Front-end, admin tooling, payment verification, and cleanup are all live. Open to issues if something's unclear.

## Links
[Web](https://night-void-store.web.app)
[Discord Server](https://discord.gg/sAakXRRudu)
[Moyasar](https://dashboard.moyasar.com/)
[CloudFare](https://www.cloudflare.com/)
[Firebase](https://firebase.google.com/)

