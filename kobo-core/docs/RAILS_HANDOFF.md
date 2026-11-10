# Kobo Kobo core: handoff to the Rails service

Full machine-readable contract: [`docs/openapi.yaml`](openapi.yaml) (import it into Postman or Swagger UI; a test keeps it in step with the code).

Base URL: core service (`PORT`, default 3000). Internal routes need `Authorization: Bearer $SERVICE_TOKEN`
(open if unset, dev only). Money is a decimal string in naira (`"900.00"`); never a float.

## 1. Schema

`migrations/001..007_*.sql`, applied in order by `npm run migrate` (tracked in `kobo_core_migrations`, deliberately not Rails' `schema_migrations`, so both can share one database).
Canonical naming follows PRD v2 (`bank_reference`, `is_excluded_from_sweep`). **Core owns every migration for these tables** (one owner). Rails does not run its own DDL against them: if you need a column or index, open a PR adding the next numbered file in `kobo-core/migrations/`. Rails keeps its own migrations for Rails-only tables (users, sessions, etc.).
Key constraints: `UNIQUE (merchant_id, sweep_date)` on `daily_sweeps`; `merchant_id` is unique on `pension_accounts`;
`ledger_entries` is append-only (triggers block UPDATE/DELETE and reject unbalanced journals).
Rails writes `merchants` and `inflow_transactions`; core writes `daily_sweeps`, `ledger_entries`, `pension_accounts` balances.

## 2. Split engine

`POST /api/v1/split` `{ merchant_id, sweep_date, sweep_amount }` returns:
`allocations.emergency_pot` (floor of half), `allocations.retirement_pot` (remainder), `pension_reference`
(`PEN-YYYYMMDD-NNNNNN`, reserved idempotently per merchant/date) and `ledger_entries`
(DEBIT MERCHANT_CASH, CREDIT EMERGENCY_POT, CREDIT RETIREMENT_POT).
Errors (`{ error: { code, message } }`): 400 `INVALID_AMOUNT` or bad date, 404 `MERCHANT_NOT_FOUND`,
422 `PENSION_ACCOUNT_MISSING` (issue an RSA PIN first), 422 `AMOUNT_EXCEEDS_DAILY_CAP`,
409 `SWEEP_ALREADY_EXECUTED` / `SWEEP_ALREADY_RESOLVED`, 409 `SWEEP_AMOUNT_CONFLICT` (a pending sweep for that date has a different amount). It does not move money.

## 3. Cron contract and retries

Core owns the schedule. At 23:00 Africa/Lagos it runs the nightly batch itself: for each merchant it computes
`min(floor(takings x rate), daily_cap)` over the PRD v2 window [00:00 D, 23:00 D) WAT (takings in the 23:00-24:00 hour are in no window; reconciliation reports them as `unswept_late_inflows`), skips paused / zero-sales / below-buffer,
asks the guard, persists the sweep as PENDING, then calls **your executor endpoints**:

| Call | Contract |
|---|---|
| `GET /api/v1/executor/balance?nuban=` | `{ available_balance }` |
| `POST /api/v1/executor/debit` + `Idempotency-Key: sweep:<merchantId>:<date>` | body `{ merchant_id, nuban, amount, narration, pension_reference }` -> `{ debit_reference, amount }` |
| `POST /api/v1/executor/credit` + `Idempotency-Key: withdrawal:<id>` | body `{ nuban, amount, narration }` -> `{ credit_reference }` |
| `GET /api/v1/executor/debits?sweep_date=` | `{ debits: [{ idempotency_key, nuban, amount, debit_reference }] }` |

Rules for Rails: the same idempotency key must never move money twice (replay returns the original result; a different
amount is `IDEMPOTENCY_CONFLICT`). Errors are non-2xx `{ error: { code, message } }` with code one of `TIMEOUT`,
`UNAVAILABLE` (retryable, outcome unknown), `INSUFFICIENT_FUNDS`, `REJECTED`, `ACCOUNT_BLOCKED`, `IDEMPOTENCY_CONFLICT` (final).
408/429/5xx are treated as retryable.

**Retry/backoff is owned by core:** 3 in-run tries with exponential backoff (`SWEEP_BACKOFF_BASE_MS`), a re-run at 23:30
(`SWEEP_RETRY_CRON`), up to 6 attempts total. Re-runs are idempotent. Rails does not retry sweeps.
Manual triggers: `POST /api/v1/sweeps/nightly-batch { target_date, allow_early? }` and
`POST /api/v1/sweeps/execute { merchant_id, target_date, allow_early? }` (409 `WINDOW_STILL_OPEN` before 23:00 WAT unless `allow_early`).
Batch summary matches PRD 6.1 (processed, successful, zero_sales, paused, buffer, guard held, failed, pending_retry, total swept).

Alternative if Rails performs the debit itself: after a confirmed debit call
`POST /api/v1/sweeps/settle { merchant_id, sweep_date, sweep_amount, debit_reference }`. It posts the ledger, credits both pots,
queues the SMS receipt, and is idempotent (`already_settled: true` on repeat).

## 4. PFA simulator and SMS receipt

- Onboarding: `POST /api/v1/pfa/rsa-pin { merchant_id }` returns a mock ECRS RSA PIN (201 new, 200 if one exists).
- Receipt: you do not call a hook. Core queues the SMS in a transactional outbox in the same transaction that settles the
  sweep, so a receipt exists if and only if the sweep settled. A dispatcher sends it via Africa's Talking with retries.
- `GET /api/v1/merchants/:id/pension` gives balances and whether the Emergency Pot is open. `POST /api/v1/withdrawals { merchant_id, amount }` pays it back to the trader's own account (3 months after first contribution, then 60-day cooldown).

## 5. Pause and rate fields

USSD (`4`, `3`) and SMS (`PAUSE`/`STOP`, `RESUME`/`START`, `RATE n`) write exactly:
`merchants.is_paused`, `merchants.paused_until` (now + 48h on pause; cleared on resume), `merchants.sweep_percentage` (1 to 5, up to 2 decimals).
A sweep is skipped when `is_paused AND (paused_until IS NULL OR paused_until > now)`. Covered by `tests/channels.test.ts`.

## 5b. PIN (money-out security)

4-digit PIN, stored only as a salted scrypt hash (peppered with `PIN_PEPPER`). Three wrong tries lock it for 30 minutes
(`PIN_MAX_ATTEMPTS`, `PIN_LOCK_MINUTES`), the trader is texted, and the counter is race-safe under parallel guessing.
PINs are set from an authenticated app session, never from USSD (a SIM swapper could otherwise create the PIN meant to stop them).

| Call | Notes |
|---|---|
| `POST /api/v1/merchants/:id/pin { pin, reset? }` | onboarding; 204. 409 `PIN_ALREADY_SET` unless `reset: true` (use after ops identity check) |
| `POST /api/v1/merchants/:id/pin/verify { pin }` | 200 `{ valid }`, 401 `PIN_INVALID` (`details.attempts_remaining`), 423 `PIN_LOCKED`, 422 `PIN_NOT_SET` |
| `POST /api/v1/merchants/:id/pin/change { old_pin, new_pin }` | 204 |
| `GET /api/v1/merchants/:id/pin` | `{ pin_set }` |

`POST /api/v1/withdrawals` now needs `pin` (set `WITHDRAWAL_PIN_REQUIRED=false` only for local demos). USSD withdrawal asks for it last;
USSD option 7 changes it. Weak PINs (1111, 1234, 4321, end of the phone number) are refused with 422 `PIN_TOO_WEAK`.

## 5c. Smart Rate

The AI service proposes, the trader decides. `POST /api/v1/smart-rate/suggestions { merchant_id, suggested_rate, reason? }` records the
suggestion and texts the trader; **it never changes `sweep_percentage`**. The rate changes only on SMS `YES` or an in-app accept:
`POST /api/v1/smart-rate/suggestions/:id/respond { merchant_id, decision: ACCEPT|DECLINE }` (409 `SUGGESTION_NOT_OPEN` if answered/expired/replaced).
`GET /api/v1/merchants/:id/smart-rate` returns the open suggestion for the app banner. Rules: 1-5%, must differ from the current rate,
one open suggestion per trader (409 `SUGGESTION_PENDING`), 72h expiry, 14-day quiet period after a `NO` (409 `SUGGESTION_COOLDOWN`),
and a rate the trader sets themselves (USSD/SMS `RATE n`) supersedes an open suggestion.

## 5d. Sweep Guard holds

A held sweep (`HELD_GUARD`) moves no money and creates a `PENDING_REVIEW` alert. Ops queue: `GET /api/v1/sweep-guard/alerts?status=PENDING_REVIEW`.
`POST /api/v1/sweep-guard/alerts/:id/resolve { decision: RELEASE|CONFIRM, resolved_by, note? }`:
- `RELEASE` re-plans from current facts (paused? rate? buffer?), then debits with the normal idempotent flow (alert -> `DISMISSED`).
- `CONFIRM` keeps it unswept, reason `GUARD_CONFIRMED:<type>` (alert -> `CONFIRMED`).
Repeating a decision returns 200 with `changed:false`; the opposite one is 409 `ALERT_ALREADY_RESOLVED`; releases are refused
after `GUARD_RELEASE_WINDOW_DAYS` (409 `RELEASE_WINDOW_PASSED`); bank down at release time is 503 `EXECUTOR_UNAVAILABLE` with nothing changed.
Traders can self-release only `ANOMALOUS_INFLOW` holds by texting `OK`; duplicates and name mismatches need ops.
Sweeps left PENDING on a past date are resumed every minute with the same idempotency key.

## 5e. IVR spoken balance

USSD option 6 queues one call request per trader (DB-enforced). A dispatcher places the call through Africa's Talking Voice
(`VOICE_PROVIDER=africastalking`, `AT_VOICE_NUMBER`), passing our request id as `clientRequestId`. Set the telco's voice callback URL to
`POST /api/v1/voice/callback?token=$WEBHOOK_TOKEN`: on answer (`isActive=1`) it returns `<Response><Say>` with the balance in English or
Pidgin; on hang-up (`isActive=0`) an unanswered call is retried with backoff (3 attempts, `VOICE_*`), then the trader is texted the
balance instead. Traders can also dial the number in: they are recognised by caller number. No action is needed from Rails.

## 6. Reconciliation

`GET /api/v1/reconciliation?date=YYYY-MM-DD` compares core, the bank (`/executor/debits`) and the ledger and returns
`{ ok, totals, flags[] }` with flags `MISSING_DEBIT`, `AMOUNT_MISMATCH`, `ORPHAN_DEBIT`, `LEDGER_MISMATCH`, `STUCK_SWEEP`,
`FAILED_SWEEP`, `HELD_FOR_REVIEW`, `POT_DRIFT`, `PENDING_WITHDRAWAL`.

## Telco webhooks (Africa's Talking)

`POST /api/v1/ussd` and `POST /api/v1/sms/inbound` accept form or JSON, guarded by `?token=$WEBHOOK_TOKEN`.
