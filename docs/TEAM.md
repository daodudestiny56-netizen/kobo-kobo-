# Kobo Kobo engine: what each teammate needs

The deployed app is one process: root `src/server.ts` mounts the engine routes and scheduler from `server/src/integration/root-runtime.ts`, using the root SQLite database and shared sandbox bank client. Run root checks with `npm ci && npm test && npm run build`; engine typechecks/tests are `cd server && npm ci && npm run typecheck && npm test`.
`server/src/index.ts` remains a standalone engine test harness using `SimulatedBank`; do not deploy it in place of the root app. Seed the seven demo traders only through the integrated app's `POST /api/v1/demo/reset`.

## Environment

| Variable | Meaning |
|---|---|
| `DB_PATH` | SQLite file (`/data/kobo.sqlite` in the container; mount a volume) |
| `OPS_TOKEN` | Secret for `/api/v1/ops/*` and `/api/v1/demo/*`. Production refuses to boot without it. |
| `DEMO_MODE` | `true` enables demo routes and demo sign-up. Defaults off in production; demo routes also require the ops token. |
| `DEMO_BANK_ACCOUNTS` | Optional, comma-separated: bank accounts for the seven demo traders (the sandbox individuals). |
| `GUARD_HOLD_ABOVE_NAIRA` | Placeholder guard: hold any single credit at or above this amount. Demo uses `1000000`. |
| `SCHEDULER_ENABLED`, `SWEEP_CRON`, `SWEEP_RETRY_CRON`, `REQUERY_CRON` | Defaults: 23:00 and 23:30 WAT, requery every minute. |

Never commit `GATEWAY_KEY`, the webhook secret, kubeconfig or `.env`.

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

Base path `/api/v1`. Success is `{status: "success", data}`; errors are `{status: "error", error: {code, message}}`. JSON keys are snake_case; money is integer kobo (divide by 100 for naira). Merchant ids are UUIDs.

| Call | Use |
|---|---|
| `POST /merchants` | Sign up: `phone, full_name, bvn, bank_account, language?, rate_bps?` |
| `GET /merchants/:id/summary` | Everything the home screen shows: pots, today's takings, estimated sweep, `eligibility` (with the refusal reason and open date), `open_suggestion`, `demo_clock_offset_days` |
| `PATCH /merchants/:id/settings` | `rate_bps`, `paused` (+ `pause_hours`), `language`, `cancel: true` |
| `GET /merchants/:id/messages` | SMS simulator conversation (inbound and outbound) |
| `GET /merchants/:id/sweeps`, `/inflows`, `/withdrawals` | History |
| `POST /withdrawals` | `{merchant_id, amount_naira}`. A refusal is HTTP 200 with `accepted:false` and `message` (same wording as USSD and SMS) |
| `GET /merchants/:id/suggestion`, `POST .../suggestion/respond` | `{decision: "accept" \| "decline"}` |
| `POST /ussd` | `{phoneNumber, text}` (JSON or form). Reply is plain text starting `CON ` or `END `. `text` is the whole path so far, e.g. `5*500*1`. |
| `POST /sms/inbound` | `{from, text}`, reply `{reply}`. Commands: BAL, PAUSE, RESUME, RATE n, CASHOUT n, STOP, HELP, YES, NO |

Ops (header `Authorization: Bearer <OPS_TOKEN>`):
`GET /ops/merchants`, `GET /ops/sweeps?date=&status=`, `POST /ops/sweeps/run {as_of?, allow_early?, force_outcome?, merchant_id?}`, `POST /ops/requery`, `GET /ops/alerts`, `POST /ops/alerts/:id/resolve {action: DISMISS|CONFIRM, note?}`, `GET /ops/reconciliation` (`ok` is true when the books balance).

Demo (needs `DEMO_MODE=true` and the ops token):
`POST /demo/inflow {phone | merchant_id, amount_naira, channel?}` (a customer pays), `GET|POST /demo/clock {offset_days}` (moves only the withdrawal-eligibility clock), `POST /demo/reset`.

Demo run: reset, show the Emergency Pot closed for Chidi, pay Ngozi, `POST /ops/sweeps/run {allow_early: true}`, open the SMS simulator, set the clock to 100 days to open a withdrawal.

## Branches and PRs (stacked, in this order)

`feat/server-scaffold` then `feat/ledger-arm-simulator` then `feat/sweep-engine` then `feat/withdrawals-eligibility` then `feat/ussd-sms-channels` then `feat/api-routes` (this one). Open each PR against the previous branch, or squash them into one PR if the team prefers.

## Not verified yet

Nothing here has run against the real sandbox (it is reachable only from inside the cluster), and the Docker image build has not been run (no daemon where this was written).
