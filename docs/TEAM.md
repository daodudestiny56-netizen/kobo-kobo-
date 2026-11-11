# Kobo Kobo engine: what each teammate needs

The deployed app is one process: root `src/server.ts` mounts the engine routes and scheduler from `server/src/integration/root-runtime.ts`, using the root SQLite database and shared sandbox bank client. Run root checks with `npm ci && npm test && npm run build`; engine typechecks/tests are `cd server && npm ci && npm run typecheck && npm test`.
`server/src/index.ts` remains a standalone engine test harness using `SimulatedBank`; do not deploy it in place of the root app. Seed the seven demo traders only through the integrated app's `POST /api/v1/demo/reset`.

## Environment

| Variable | Meaning |
|---|---|
| `DB_PATH` | SQLite file (`/data/kobo.sqlite` in the container; mount durable storage) |
| `OPS_TOKEN` | Secret for engine ops and demo-control routes. Production refuses to boot without it. |
| `DEMO_MODE` | `true` enables demo routes and demo sign-up. Defaults off in production. |
| `DEMO_SECRET` | Secret sent in `X-Demo-Key` for protected root demo actions when `DEMO_MODE=true`. |
| `IDENTITY_HMAC_KEY` | Stable secret used to hash identity data; configure it before onboarding merchants. |
| `DEMO_BANK_ACCOUNTS` | Optional, comma-separated: bank accounts for the seven demo traders (the sandbox individuals). |
| `GUARD_HOLD_ABOVE_NAIRA` | Placeholder guard: hold any single credit at or above this amount. Demo uses `1000000`. |
| `SCHEDULER_ENABLED`, `SWEEP_CRON`, `SWEEP_RETRY_CRON`, `REQUERY_CRON` | Defaults: 23:00 and 23:30 WAT, requery every minute. |

Never commit `GATEWAY_KEY`, the webhook secret, kubeconfig or `.env`.

## Kubernetes storage and secrets

`k8s/app.yaml` mounts the `app-data` 1 GiB PVC at `/data`; the cluster must have a default StorageClass to provision it. Confirm the claim is `Bound` before rolling out the app. Keep `DB_PATH` on that mount and back up the PVC before replacing or migrating the database. In `team07`, the `huawei-gateway` Secret provides `GATEWAY_KEY`; `kobo-secrets` must provide `OPS_TOKEN`, `DEMO_SECRET`, and `IDENTITY_HMAC_KEY`. Create or rotate these through the approved secret-management workflow, never in source control or chat.

## Abiodun: bank client, webhooks, onboarding

1. **`BankPort`** (`server/src/bank/port.ts`) is the only thing the engine knows about the bank. The deployed app uses `server/src/integration/root-bank.ts` to adapt the root `HttpBankClient`; the adapter uses the shared limiter, preserves idempotency, and maps unknown transfer outcomes to requery rather than a resend. `server/src/index.ts` uses `SimulatedBank` only in the standalone test harness.
   - `transfer` must be idempotent on `idempotencyKey` and throw `BankError('TIMEOUT')` on a 504. The engine then requeries and never blind-resends.
   - `getTransfer` returns `null` only for HTTP 404 (the bank has no record). Only then does the engine resend, with the same key and reference.
   - `BankError` codes map every sandbox failure; see the comments in `port.ts`.
   - `SimulatedBank` reproduces the sandbox trigger digits and DUP- rule. Run `npm test` against your client's mapping if you can.
2. **Rate budget:** the engine runs at most 3 merchants at once (`SWEEP_BATCH_CONCURRENCY`). Put your shared `limiter.acquire()` inside the client so bank and model calls share one 40 per minute budget.
3. **Webhooks** (`POST /hooks/forge`): verify the signature, then
   - credit received: `recordInflow(deps, {merchantId, amount, channel, eventId, bankReference, settledAt})` (`src/inflows/service.ts`). It is idempotent on `eventId` and `bankReference`. Pass `counted: false` for loans, own transfers and reversals.
   - transfer result for a sweep: `applyResult(deps, sweepId, result)` (`src/sweeps/engine.ts`), find the sweep with `getSweepByReference`.
   - transfer result for a withdrawal: `applyWithdrawalResult(deps, id, result)` (`src/withdrawals/service.ts`).
   The integrated runtime subscribes to transfer events and applies a fresh bank requery to matching sweep/withdrawal rows. Incoming sales remain sourced from the bank transaction poll. The updates are idempotent and share the same database as the sweep engine.
4. **Onboarding:** the bank app's `src/onboarding/service.ts` runs registered `onOnboard(merchantId)` hooks inside its merchant/consent transaction. The hook registered by root `src/server.ts` creates the simulated pension account and RSA PIN; a failure rolls the entire enrolment back. The root migrations add the engine tables and shared inflow metadata, including `src/migrations/0011_engine_runtime.ts`. The `/api/v1/merchants` helper also creates its pension account in the same root database.
5. Production startup requires `OPS_TOKEN` and `BANK_API_KEY` (or `GATEWAY_KEY`). The webhook secret is registered with the bank on boot and kept in memory; transaction polling and requery remain the recovery path if webhook registration is unavailable.

## Tomiwa: SweepGuard, SmartRate, message copy

In-process TypeScript, no second service (agreed).

- **SweepGuard** implements `SweepGuard` from `src/guard/port.ts`: `evaluate(ctx)` receives `ctx.inflows` (`{id, bankReference, amount: bigint kobo, settledAt}`) plus the merchant, and returns one `GuardFlag` per suspicious credit: `{inflowId, type: 'ANOMALY' | 'DUPLICATE' | 'NAME_MISMATCH', details}`.
  - Only flagged credits are held out of takings. If every credit is held the sweep is `HELD_GUARD`.
  - Ops resolve a hold at `POST /api/v1/ops/alerts/:id/resolve`: `DISMISS` counts the credit from that moment (next window), `CONFIRM` excludes it for good.
  - Wire it in `src/index.ts` instead of `AllowAllGuard`.
- **SmartRate** computes the suggestion, then calls `createSuggestion(deps, {merchantId, suggestedBps (100-500), reason})` (`src/smart-rate/service.ts`) or `POST /api/v1/ops/suggestions`. The module sends the SMS, enforces one open suggestion per trader, a 72-hour expiry and a 14-day pause after a NO, and changes the rate only on an explicit YES or accept. Never write `rate_bps` yourself.
- **Messages:** all texts live in `src/messages/templates.ts`, English and Pidgin. Other languages fall back to English. Keep the withdrawal refusal wording in `withdrawalRefusal` so the app, USSD and SMS stay identical.
- Cache any model output by template and language, keep these static strings as the fallback, and never call a model on page load.

## Destiny: PWA, simulators, ops dashboard

Set `NEXT_PUBLIC_API_MODE=live`. Base path `/api/v1`. Success is `{status: "success", data}`; errors are `{status: "error", error: {code, message}}`. Keys are camelCase, money is integer kobo, and every time the web types declare as `number` is epoch milliseconds. The shapes are `web/src/lib/api/types.ts`; the mappers are `server/src/web/mappers.ts`.

| Call | Notes |
|---|---|
| `GET /demo/traders`, `POST /demo/sign-in {account}` | the four sandbox traders; sign-in enrols on first use |
| `POST /auth/verify-otp {phone, code}` | code `123456`; returns `{merchantId \| null}` |
| `GET /identity/resolve?account=` | `{name, tier}` from the bank's name enquiry |
| `POST /merchants/onboard` | `{bankAccount, bvn, nin, phone, language, rateBps, consent}`; BVN + name match; returns a Merchant |
| `GET /merchants/:id/summary` | the whole home screen (pots, takings, eligibility with the refusal sentence, `smartRate`, `account`, `stats`, `series`, `balanceSeries`) |
| `GET /merchants/:id/activity`, `/feed` | sweeps; payments + savings + withdrawals, newest first |
| `PATCH /merchants/:id/settings` | `{rateBps, language, pauseHours (0 resumes), cancel, reactivate}`; returns the Summary |
| `POST /withdrawals` | `{merchantId, amountKobo}`; a refusal is HTTP 200 `{ok:false, message}` (same wording as USSD and SMS) |
| `POST /ussd` | `{phoneNumber, sessionId, text}` returns `{type: "CON"\|"END", body}`; `?format=text` returns the raw string |
| `POST /sms/inbound` | `{from, text}` returns `{reply}` |
| `GET /merchants/:id/messages` | the SMS simulator's conversation |

Ops (also open with `DEMO_OPEN=1` in demo mode): `GET /ops/overview`, `GET /ops/merchants`, `POST /ops/sweeps/run {forceOutcome: none\|failed\|timeout\|reversed}` (runs today's Lagos-date sweep, before the cutoff too in demo mode), `POST /ops/sweeps/:id/requery`, `POST /ops/alerts/:id/resolve {decision: DISMISSED\|CONFIRMED}`. These return the OpsOverview. Extra: `GET /ops/reconciliation`, `POST /ops/requery`, `POST /ops/suggestions`.

Demo: `GET /demo/clock`, `POST /demo/clock {days}` (moves only the withdrawal-eligibility clock), `POST /demo/inflow {merchantId, amountKobo, count?}` (a real bank transfer from `DEMO_PAYER_ACCOUNT` when a bank is connected, otherwise recorded directly), `POST /demo/reset`.

**Auth:** the web app sends no token yet. Either set `DEMO_OPEN=1` (demo only: opens ops and the demo controls to anyone), or have the Next.js server add `Authorization: Bearer $OPS_TOKEN` (or `x-demo-key`) to `/api/v1/ops/*` and the changing `/api/v1/demo/*` calls.

## Branches and PRs (stacked, in this order)

`feat/server-scaffold` then `feat/ledger-arm-simulator` then `feat/sweep-engine` then `feat/withdrawals-eligibility` then `feat/ussd-sms-channels` then `feat/api-routes` (this one). Open each PR against the previous branch, or squash them into one PR if the team prefers.

## Not verified yet

Nothing here has run against the real sandbox (it is reachable only from inside the cluster), and the Docker image build has not been run (no daemon where this was written).
