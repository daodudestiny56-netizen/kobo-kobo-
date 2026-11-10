-- Sweep Guard: record who resolved a hold, how and why.
ALTER TABLE sweep_guard_alerts
    ADD COLUMN resolved_at      TIMESTAMPTZ,
    ADD COLUMN resolved_by      VARCHAR(80),
    ADD COLUMN resolved_via     VARCHAR(10),
    ADD COLUMN resolution_note  TEXT,
    ADD CONSTRAINT chk_alert_via CHECK (resolved_via IS NULL OR resolved_via IN ('OPS','SMS')),
    ADD CONSTRAINT chk_alert_resolution CHECK ((status = 'PENDING_REVIEW') = (resolved_at IS NULL));
CREATE INDEX idx_guard_alert_open ON sweep_guard_alerts (merchant_id, created_at DESC) WHERE status = 'PENDING_REVIEW';
