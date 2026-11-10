-- Kobo Kobo schema (PRD v3 section 14). Money is INTEGER kobo everywhere. Times are ISO-8601 UTC text.
-- Ledger balances (pots) are never stored: they are SUM(amount_kobo) over ledger_entries.

CREATE TABLE merchants (
  id             TEXT PRIMARY KEY,
  phone          TEXT NOT NULL UNIQUE,
  full_name      TEXT NOT NULL,
  bvn_hash       TEXT NOT NULL UNIQUE,
  bank_account   TEXT NOT NULL UNIQUE,
  virtual_account TEXT UNIQUE,
  language       TEXT NOT NULL DEFAULT 'pidgin' CHECK (language IN ('en','pidgin','yoruba','hausa','igbo')),
  rate_bps       INTEGER NOT NULL DEFAULT 200 CHECK (rate_bps BETWEEN 100 AND 500),
  daily_cap_kobo INTEGER NOT NULL DEFAULT 500000 CHECK (daily_cap_kobo >= 0),
  buffer_kobo    INTEGER NOT NULL DEFAULT 100000 CHECK (buffer_kobo >= 0),
  paused_until   TEXT,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  created_at     TEXT NOT NULL
);

CREATE TABLE consents (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  text_version TEXT NOT NULL,
  given_at     TEXT NOT NULL,
  withdrawn_at TEXT
);

CREATE TABLE pension_accounts (
  id                    TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL UNIQUE REFERENCES merchants(id),
  rsa_pin               TEXT NOT NULL UNIQUE,
  pfa                   TEXT NOT NULL DEFAULT 'ACCESS_ARM_SIMULATED',
  first_contribution_at TEXT,
  last_withdrawal_at    TEXT,
  created_at            TEXT NOT NULL
);

CREATE TABLE inflows (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  event_id       TEXT UNIQUE,
  bank_reference TEXT NOT NULL UNIQUE,
  amount_kobo    INTEGER NOT NULL CHECK (amount_kobo > 0),
  channel        TEXT NOT NULL,
  counted        INTEGER NOT NULL DEFAULT 1 CHECK (counted IN (0,1)),       -- 0: loan, own transfer, reversal
  hold_status    TEXT CHECK (hold_status IN ('HELD','DISMISSED','CONFIRMED')),
  released_at    TEXT,                                                      -- set when ops dismiss a hold: the credit then counts from here
  settled_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_inflows_merchant_settled ON inflows (merchant_id, settled_at);

CREATE TABLE sweeps (
  id                    TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL REFERENCES merchants(id),
  sweep_date            TEXT NOT NULL,
  window_start          TEXT NOT NULL,
  window_end            TEXT NOT NULL,
  takings_kobo          INTEGER NOT NULL CHECK (takings_kobo >= 0),
  rate_bps              INTEGER NOT NULL,
  sweep_kobo            INTEGER NOT NULL DEFAULT 0 CHECK (sweep_kobo >= 0),
  emergency_kobo        INTEGER NOT NULL DEFAULT 0 CHECK (emergency_kobo >= 0),
  retirement_kobo       INTEGER NOT NULL DEFAULT 0 CHECK (retirement_kobo >= 0),
  status                TEXT NOT NULL CHECK (status IN (
                          'PLANNED','HELD_GUARD','SKIPPED_ZERO_SALES','SKIPPED_PAUSED','SKIPPED_LOW_BALANCE',
                          'SUBMITTED','UNKNOWN','SETTLED','FAILED','REVERSED')),
  idempotency_key       TEXT NOT NULL,
  bank_reference        TEXT NOT NULL,
  pension_reference     TEXT UNIQUE,
  failure_reason        TEXT,
  last_error            TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  next_check_at         TEXT,                  -- when the requery loop should look at this sweep again
  watch_until           TEXT,                  -- keep checking a settled sweep until here, in case the bank reverses it
  bank_fee_kobo         INTEGER NOT NULL DEFAULT 0,
  bank_total_debit_kobo INTEGER,
  settled_at            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (merchant_id, sweep_date),
  CHECK (sweep_kobo = emergency_kobo + retirement_kobo),
  CHECK (status NOT IN ('SUBMITTED','UNKNOWN','SETTLED','REVERSED') OR (sweep_kobo > 0 AND pension_reference IS NOT NULL))
);
CREATE INDEX idx_sweeps_open ON sweeps (status, next_check_at);

CREATE TABLE withdrawals (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  amount_kobo         INTEGER NOT NULL CHECK (amount_kobo > 0),
  destination_account TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('REQUESTED','UNKNOWN','DISBURSED','REJECTED','FAILED')),
  reject_reason       TEXT,
  bank_reference      TEXT UNIQUE,
  last_error          TEXT,
  next_check_at       TEXT,
  effective_at        TEXT NOT NULL,         -- the eligibility clock at request time (real time plus any demo offset)
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE ledger_entries (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL,                  -- entries in a group sum to zero
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  sweep_id      TEXT REFERENCES sweeps(id),
  withdrawal_id TEXT REFERENCES withdrawals(id),
  account       TEXT NOT NULL CHECK (account IN ('MERCHANT_BANK','PFA_COLLECTION','EMERGENCY_POT','RETIREMENT_POT')),
  amount_kobo   INTEGER NOT NULL CHECK (amount_kobo <> 0),   -- signed: debit negative, credit positive
  reference     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (group_id, account)                    -- posting the same group twice is impossible
);
CREATE INDEX idx_ledger_merchant ON ledger_entries (merchant_id, account);

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;

CREATE TABLE guard_alerts (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  inflow_id   TEXT REFERENCES inflows(id),
  sweep_id    TEXT REFERENCES sweeps(id),
  type        TEXT NOT NULL CHECK (type IN ('ANOMALY','DUPLICATE','NAME_MISMATCH')),
  details     TEXT,
  status      TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW','DISMISSED','CONFIRMED')),
  resolved_at TEXT,
  resolved_by TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  CHECK ((status = 'PENDING_REVIEW') = (resolved_at IS NULL))
);

CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, type TEXT, received_at TEXT NOT NULL);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants(id),
  channel     TEXT NOT NULL CHECK (channel IN ('SMS','USSD','APP')),
  direction   TEXT NOT NULL DEFAULT 'OUT' CHECK (direction IN ('IN','OUT')),
  kind        TEXT,
  language    TEXT,
  body        TEXT NOT NULL,
  dedupe_key  TEXT UNIQUE,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_messages_merchant ON messages (merchant_id, created_at);

CREATE TABLE pen_counters (day TEXT PRIMARY KEY, last INTEGER NOT NULL);

CREATE TABLE rate_suggestions (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  current_bps   INTEGER NOT NULL,
  suggested_bps INTEGER NOT NULL CHECK (suggested_bps BETWEEN 100 AND 500),
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACCEPTED','DECLINED','EXPIRED','SUPERSEDED')),
  expires_at    TEXT NOT NULL,
  responded_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_rate_suggestion_open ON rate_suggestions (merchant_id) WHERE status = 'OPEN';

CREATE TABLE demo_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
