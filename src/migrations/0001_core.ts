export const core = `
CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  bvn_hash TEXT NOT NULL UNIQUE,
  bank_account TEXT UNIQUE NOT NULL,
  virtual_account TEXT UNIQUE,
  language TEXT NOT NULL DEFAULT 'pidgin',
  rate_bps INTEGER NOT NULL DEFAULT 200,
  daily_cap_kobo INTEGER NOT NULL DEFAULT 500000,
  buffer_kobo INTEGER NOT NULL DEFAULT 100000,
  paused_until TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL
);

CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  text_version TEXT NOT NULL,
  given_at TEXT NOT NULL,
  withdrawn_at TEXT
);

CREATE TABLE inflows (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  event_id TEXT UNIQUE,
  bank_reference TEXT UNIQUE NOT NULL,
  amount_kobo INTEGER NOT NULL,
  channel TEXT NOT NULL,
  counted INTEGER NOT NULL DEFAULT 1,
  hold_status TEXT,
  settled_at TEXT NOT NULL
);

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT,
  received_at TEXT NOT NULL
);
`;