# Kobo Kobo web app

Next.js (App Router, TypeScript). One font family (Bricolage Grotesque), Flexbox layout, design tokens from the team's pitch deck.

## Run it

```
cd web
npm install
npm run dev        # http://localhost:3000
```

By default the app runs on a **built-in mock API** that lives in the browser (`src/lib/api/engine.ts`). It includes a **demo bank**: when a trader signs in, the engine seeds a linked account, months of customer payments and nightly savings, pots, withdrawals and statistics, so every screen has real data. The seed follows the sandbox's fixtures (accounts `0123456789` to `0123456792`) and the PRD's rules. Data is kept in `localStorage`; to reseed, use **Demo tools, then Reset all demo data**, or clear site data.

**Demo controls** (simulate a customer paying, run tonight's saving, skip time, button phone, operations console) are on by default with the mock API and off with the live API. Turn them on or off in Settings, About, or add `?demo=1` or `?demo=0` to any URL.

To use the real backend:

```
NEXT_PUBLIC_API_MODE=live API_BASE_URL=https://team07.xtradot.co npm run dev
```

The browser always calls relative `/api/v1/...`. `API_BASE_URL` only tells the dev server where to forward them.

## Pages

| Area | Routes |
|---|---|
| Public | `/` landing, `/help`, `/terms`, `/privacy` |
| Auth | `/sign-in` (phone and text code), `/sign-up` (5 steps) |
| Trader app | `/home` (dashboard), `/savings`, `/savings/withdraw`, `/transactions`, `/transactions/[id]` (receipt), `/notifications`, `/settings/{profile,account,plan,messages,security,about}` |
| Demo | `/demo/phone` (button phone, USSD and SMS) |
| Operations | `/ops`, `/ops/sweeps`, `/ops/alerts` |

## Design rules in use

- Two colours only: white and one brand blue. `--brand` in `src/app/globals.css` is the single source; every tint, divider and hover state is derived from it. To rebrand, change `--brand` and nothing else. Text uses a neutral grey scale. The only other colours on screen are the photographs.
- No CSS Grid, gradients, shadows or glass. Flexbox only.
- Lucide icons only. Photos are the team's licensed Wikimedia Commons photos (credits in the site footer).
- Every sweep state has plain-language wording in `src/lib/activity.ts`.

## API the live mode expects

All under `/api/v1`. Items marked **new** are not in PRD section 15 yet.

| Call | Used by |
|---|---|
| `POST /auth/verify-otp` **new** (`{phone, code}` returns `{merchantId \| null}`) | sign-in, sign-up |
| `GET /identity/resolve?account=` **new** (returns `{name, tier}`) | sign-up |
| `POST /merchants/onboard` | sign-up |
| `GET /merchants/{id}/summary` | every trader screen |
| `GET /merchants/{id}/activity` **new** (all sweeps, newest first) | savings, receipt, notifications |
| `GET /merchants/{id}/feed` **new** (customer payments, savings, withdrawals, newest first) | home, transactions |
| `PATCH /merchants/{id}/settings` (adds `reactivate`) | plan, pause, stop |
| `POST /withdrawals` | withdraw |
| `POST /ussd`, `POST /sms/inbound` | button phone |
| `GET /demo/traders`, `POST /demo/sign-in`, `/demo/inflow`, `/demo/clock`, `/demo/reset` **new/demo only** | sign-in shortcuts, Demo tools |
| `GET /ops/overview`, `GET /ops/merchants`, `POST /ops/sweeps/run`, `POST /ops/sweeps/{id}/requery`, `POST /ops/alerts/{id}/resolve` | operations, button phone |

Response shapes are the types in `src/lib/api/types.ts`. `GET /merchants/{id}/summary` also returns the linked account, 30-day stats, a 30-day sales and savings series and a 90-day balance series, which the dashboard charts use. In live mode these come from the Xtradot sandbox statements (`GET /transactions`), which are seeded with October 2026 history. Money is integer kobo.

## Deploying

`next.config.mjs` uses `output: 'standalone'`. The cluster allows one public service named `app`, so the team must decide whether this app or the backend sits behind it. The simplest option is for the Next.js server to be `app` and forward `/api/v1/*` to the backend through `API_BASE_URL`.

## Still to do

- Real staff sign-in for `/ops` and the demo endpoints.
- Yoruba, Hausa and Igbo message text (falls back to English today).
- Installable PWA icons and a service worker.
