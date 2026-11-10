# kobo-core

Core backend for Kobo Kobo (Access Youth Tech Forge 2026, Payments): nightly 11 PM auto-sweep, 50/50 double-entry ledger,
emergency withdrawals, USSD and two-way SMS, SMS outbox, PFA simulator and reconciliation.

```
cp .env.example .env
docker compose up -d db        # or any Postgres 16
npm install
npm run migrate
npm run dev
npm test                       # needs TEST_DATABASE_URL, e.g. postgres://postgres:postgres@localhost:5432/kobo_test
```

## Run in Docker

```
docker compose up --build      # Postgres + core on :3000, migrations run on boot (RUN_MIGRATIONS=true)
```

Defaults are safe for a laptop: mock bank, console SMS/voice. Real values go in a `.env` next to the compose file
(`SERVICE_TOKEN`, `WEBHOOK_TOKEN`, `PIN_PEPPER`, `EXECUTOR_MODE=http`, `RAILS_BASE_URL`, `AT_*`). `/health` checks the database.

## Demo

```
cp .env.example .env     # set DATABASE_URL, EXECUTOR_MODE=mock, MOCK_DEFAULT_BALANCE_NAIRA=500000, GUARD_HOLD_ABOVE_NAIRA=1000000
npm run demo:seed        # resets the (local) database and replays months of REAL sweeps for 7 demo traders
npm run dev              # core on :3000 (SCHEDULER_ENABLED=false if you want to trigger the sweep yourself)
npm run demo:ussd -- +2348031230001     # dial the USSD menu as Mama Ngozi (PIN 7391)
npm run demo:sms  -- +2348031230001 BAL # text the service
npm run demo:sweep       # run tonight's 11 PM sweep now and print what happened to each trader
```

Each trader shows a different outcome (normal sweep, young account, cooldown, paused, below buffer, Sweep Guard hold
released by texting `OK`, pending Smart Rate suggestion). The seed refuses to wipe a non-local database without `--force`.

Integration contract for the Rails service: [docs/RAILS_HANDOFF.md](docs/RAILS_HANDOFF.md). Every endpoint: [docs/openapi.yaml](docs/openapi.yaml).
`EXECUTOR_MODE=mock` runs without Rails; `http` uses `RAILS_BASE_URL`.

Layout: `src/split` (allocation), `src/ledger`, `src/sweeps` (service, batch, scheduler), `src/withdrawals`,
`src/channels` (USSD, SMS; en + Pidgin), `src/security` (PIN), `src/smart-rate`, `src/voice` (IVR), `src/sms` (outbox, dispatcher), `src/pfa`, `src/reconciliation`, `src/routes`.

## Tests

`npm test` creates and **drops** the database named in `TEST_DATABASE_URL` (default `postgres://postgres@localhost:5433/kobo_test`),
so never point it at real data. It runs against a real Postgres, including a 1,500-trader batch and a full-day end-to-end run.
CI (`.github/workflows/ci.yml`) runs typecheck, the suite and a Docker build on every PR.
