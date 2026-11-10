-- Smart Rate: the AI suggests a higher rate; nothing changes until the trader confirms (SMS YES, or in the app).
CREATE TABLE rate_suggestions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id    UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    current_rate   NUMERIC(4,2) NOT NULL,
    suggested_rate NUMERIC(4,2) NOT NULL,
    reason         TEXT,
    status         VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    responded_via  VARCHAR(10),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL,
    responded_at   TIMESTAMPTZ,
    CONSTRAINT chk_suggestion_status CHECK (status IN ('PENDING','ACCEPTED','DECLINED','EXPIRED','SUPERSEDED')),
    CONSTRAINT chk_suggestion_range  CHECK (suggested_rate BETWEEN 1.00 AND 5.00),
    CONSTRAINT chk_suggestion_differs CHECK (suggested_rate <> current_rate)
);
-- At most one open suggestion per trader, so "YES" is never ambiguous.
CREATE UNIQUE INDEX uq_rate_suggestion_open ON rate_suggestions (merchant_id) WHERE status = 'PENDING';
CREATE INDEX idx_rate_suggestion_merchant ON rate_suggestions (merchant_id, created_at DESC);
