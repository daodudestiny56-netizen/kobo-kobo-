# Kobo Kobo: integration guide for the AI/ML service (Sweep Guard + Smart Rate)

From Caleb (core backend). Two integrations. Core never lets the AI move money directly: the AI only advises, core decides and executes.

Core base URL: `http://<core-host>:3000`. Calls from you to core carry `Authorization: Bearer $SERVICE_TOKEN`. Money in JSON is a decimal naira string (`"12000.00"`). Full contract: `docs/openapi.yaml`.

## 1. Sweep Guard (core calls YOU, before every sweep)

You expose one endpoint. Core calls it for each trader just before debiting.

`POST $GUARD_URL`   (header `Authorization: Bearer $GUARD_TOKEN` if set)

Request:
```json
{
  "merchant_id": "uuid",
  "sweep_date": "2026-11-08",
  "takings": "12000.00",
  "inflows": [
    { "bank_reference": "NIP-123", "amount": "7000.00", "settled_at": "2026-11-08T10:15:00.000Z" }
  ]
}
```
`takings` is the total of `inflows` in the sweep window (00:00 to 23:00 WAT of `sweep_date`).

Response, within 3 seconds (`GUARD_TIMEOUT_MS`):
```json
{ "verdict": "CLEAR" }
{ "verdict": "HOLD", "alert_type": "ANOMALOUS_INFLOW", "details": { "score": 0.93, "reason": "10x the 30-day average" } }
```
`alert_type` must be one of: `ANOMALOUS_INFLOW`, `SUSPECTED_DUPLICATE`, `NAME_MISMATCH`, `LOW_BUFFER`. `details` is free-form JSON shown to ops.

What a HOLD does: the sweep is stored as `HELD_GUARD`, an alert goes to the ops queue (`GET /api/v1/sweep-guard/alerts`), and the trader is texted. Ops release or confirm it. For `ANOMALOUS_INFLOW` the trader can also text `OK` to release it themselves. Nothing is debited while held.

Failure behaviour: timeout, non-200 or an invalid body means core allows the sweep (fail open) and logs it. Set `GUARD_FAIL_CLOSED=true` to hold instead. So keep the endpoint fast and always return one of the two shapes above. A false HOLD costs a trader one night of savings, so tune for precision.

Turn it on in core's `.env`: `GUARD_URL=http://<your-host>/evaluate`, `GUARD_TOKEN=...`. Leave `GUARD_URL` empty and core uses a simple threshold rule (`GUARD_HOLD_ABOVE_NAIRA`) or allows everything.

You can reach the held-sweep data later via `GET /api/v1/sweep-guard/alerts?status=PENDING_REVIEW&merchant_id=...`.

## 2. Smart Rate (YOU call core)

When your model thinks a trader should save a different percentage, propose it. This never changes the rate by itself. The trader gets an SMS (Pidgin or English) and the rate changes only when they reply YES, or accept in the app.

`POST /api/v1/smart-rate/suggestions`
```json
{ "merchant_id": "uuid", "suggested_rate": "3", "reason": "Takings up 40% over 60 days" }
```
- `suggested_rate`: percent, 1 to 5, up to 2 decimals, and different from the current rate.
- `reason`: optional, up to 500 characters, kept for audit.
- 201 returns the suggestion. Errors: 409 `SUGGESTION_PENDING` (one open at a time) or `SUGGESTION_COOLDOWN` (14 days after a NO; `details.retry_after` says when), 422 `RATE_UNCHANGED`, 404 unknown merchant.
- Open suggestions expire after 72 hours. A rate the trader sets manually cancels the open suggestion.

To check before proposing: `GET /api/v1/merchants/{id}/smart-rate` returns the open suggestion or `null`.

## 3. Try it locally

```
npm run demo:seed && npm run dev
curl -X POST localhost:3000/api/v1/smart-rate/suggestions -H 'content-type: application/json' -d '{"merchant_id":"<uuid>","suggested_rate":"3","reason":"test"}'
```
In demo mode (no `SERVICE_TOKEN`) auth is open. Texts print in the core terminal. Reply with `npm run demo:sms -- <phone> YES`.

For the guard, run a small stub of your service and point `GUARD_URL` at it. Then `npm run demo:sweep` to see HOLDs appear.
