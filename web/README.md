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

## Live mode (the real backend)

```
NEXT_PUBLIC_API_MODE=live API_BASE_URL=http://localhost:8080 npm run dev
```

The browser always calls relative `/api/v1/...`; `API_BASE_URL` tells the Next.js server where to forward them.

**Both variables are read when the app is built, not when it starts.** `NEXT_PUBLIC_API_MODE` is inlined into the browser code, and the rewrite target is fixed in the build. For a production image, pass them as build arguments (`next build`), not container environment variables.

In live mode the demo controls are off by default. Open the site once with `?demo=1` to show Demo tools, Button phone and Operations (it is remembered in that browser, and can be turned off in Settings, About).

The ops and demo endpoints need access: either the server runs with `DEMO_OPEN=1`, or the person types the shared key into the **Demo key** box the app shows when the server answers 401. It is sent as `x-demo-key` and kept for that browser tab only.

Connection hiccups: reads are retried once, and settings updates too (they only set a value). Anything that moves money is never retried.

## Pages

| Area | Routes |
|---|---|
| Public | `/` landing, `/help`, `/terms`, `/privacy` |
| Auth | `/sign-in` (phone and text code), `/sign-up` (2 steps: details, then review and agree) |
| Trader app | `/home` (dashboard), `/savings`, `/savings/withdraw`, `/transactions`, `/transactions/[id]` (receipt), `/notifications`, `/settings/{profile,account,plan,messages,security,about}` |
| Demo | `/demo/phone` (button phone, USSD and SMS) |
| Operations | `/ops`, `/ops/sweeps`, `/ops/alerts` |

## Design rules in use

- Two colours only: white and one brand blue. `--brand` in `src/app/globals.css` is the single source; every tint, divider and hover state is derived from it. To rebrand, change `--brand` and nothing else. Text uses a neutral grey scale. The only other colours on screen are the photographs.
- No CSS Grid, gradients, shadows or glass. Flexbox only.
- Lucide icons only. Photos are the team's licensed Wikimedia Commons photos (credits in the site footer).
- Every sweep state has plain-language wording in `src/lib/activity.ts`.

## API the live mode calls

All under `/api/v1`. Success is `{ status: "success", data }` and failure is `{ status: "error", error: { code, message, field? } }` (onboarding answers `{ error: { code, message, field? } }`); both become an `ApiError`. Money is integer kobo and every time is epoch milliseconds. Verified end to end against the real backend (`main` plus the web-contract patch) using the mock bank.

| Call | Used by |
|---|---|
| `GET /consent`, `POST /merchants/onboard` | sign-up. The response is the whole trader (`id`, `fullName`, `rsaPin`, ...), and the app accepts that or `{merchantId}` |
| `POST /auth/verify-otp` (code `123456`) | sign-in |
| `GET /demo/traders`, `POST /demo/sign-in {account}` | demo accounts on the sign-in and sign-up pages |
| `GET /merchants/{id}/summary`, `/activity`, `/feed` | every trader screen |
| `PATCH /merchants/{id}/settings` (returns the summary) | plan, pause, stop, language, suggestion |
| `POST /withdrawals {merchantId, amountKobo}` | withdraw |
| `POST /ussd`, `POST /sms/inbound` | button phone |
| `GET /ops/overview`, `GET /ops/merchants`, `POST /ops/sweeps/run {forceOutcome}`, `POST /ops/sweeps/{id}/requery`, `POST /ops/alerts/{id}/resolve {decision}` | operations, button phone |
| `GET /demo/clock`, `POST /demo/clock {days}`, `POST /demo/inflow {merchantId, amountKobo}`, `POST /demo/reset` | Demo tools |

Onboarding error codes and what the person sees: `IDENTITY_NOT_VERIFIED`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_NOT_ACTIVE`, `NAME_MISMATCH`, `NAME_NEEDS_REVIEW`, `ALREADY_ENROLLED`, `CONSENT_REQUIRED`, `CONSENT_VERSION_MISMATCH`, `INVALID_REQUEST`, `RATE_LIMITED`, `BANK_UNAVAILABLE`. The mapping is in `src/lib/onboarding.ts`, and the mock in `src/lib/api/engine.ts` returns the same codes.

One summary request serves the whole app (`src/lib/session.tsx`), because each summary costs the server a bank balance call and the server's bank limiter is 40 a minute. It reloads after actions and when the tab comes back into view.

## Deploying

`next.config.mjs` uses `output: 'standalone'`. The cluster allows one public service named `app`, so the team must decide whether this app or the backend sits behind it. The simplest option is for the Next.js server to be `app` and forward `/api/v1/*` to the backend through `API_BASE_URL`.

## Still to do

- Real staff sign-in for `/ops` (today: `DEMO_OPEN=1` or the shared demo key).
- Yoruba, Hausa and Igbo message text (falls back to English today).
- Installable PWA icons and a service worker.
