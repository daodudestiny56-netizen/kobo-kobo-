export const engine = `
CREATE TABLE pension_accounts (
  id                    TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL UNIQUE REFERENCES merchants(id),
  rsa_pin               TEXT NOT NULL UNIQUE,
  pfa                   TEXT NOT NULL DEFAULT 'ACCESS_ARM_SIMULATED',
  first_contribution_at TEXT,
  last_withdrawal_at    TEXT,
  created_at            TEXT NOT NULL
);

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
  next_check_at         TEXT,
  watch_until           TEXT,
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
  effective_at        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE ledger_entries (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  sweep_id      TEXT REFERENCES sweeps(id),
  withdrawal_id TEXT REFERENCES withdrawals(id),
  account       TEXT NOT NULL CHECK (account IN ('MERCHANT_BANK','PFA_COLLECTION','EMERGENCY_POT','RETIREMENT_POT')),
  amount_kobo   INTEGER NOT NULL CHECK (amount_kobo <> 0),
  reference     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (group_id, account)
);
CREATE INDEX idx_ledger_merchant ON ledger_entries (merchant_id, account);

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;

CREATE TABLE pen_counters (day TEXT PRIMARY KEY, last INTEGER NOT NULL);
`;
