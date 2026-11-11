export const engineRuntime = `
ALTER TABLE inflows ADD COLUMN released_at TEXT;
ALTER TABLE inflows ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
UPDATE inflows SET created_at = settled_at WHERE created_at = '';

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
`;
