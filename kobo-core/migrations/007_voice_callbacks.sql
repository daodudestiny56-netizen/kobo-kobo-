-- IVR spoken balance: USSD option 6 queues a request; the voice dispatcher places the call, the telco's webhook
-- fetches the script. Retries are bounded; a call that never connects falls back to a text message.
ALTER TABLE voice_callback_requests DROP CONSTRAINT chk_voice_status;
ALTER TABLE voice_callback_requests
    ADD COLUMN attempts         INT          NOT NULL DEFAULT 0,
    ADD COLUMN next_attempt_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    ADD COLUMN last_error       TEXT,
    ADD COLUMN provider_call_id VARCHAR(100),
    ADD COLUMN served_at        TIMESTAMPTZ,
    ADD COLUMN completed_at     TIMESTAMPTZ,
    ADD CONSTRAINT chk_voice_status CHECK (status IN ('PENDING','CALLING','DONE','FAILED'));
DROP INDEX idx_voice_pending;
-- One open request per trader, enforced by the database.
CREATE UNIQUE INDEX uq_voice_open ON voice_callback_requests (merchant_id) WHERE status IN ('PENDING','CALLING');
CREATE INDEX idx_voice_due ON voice_callback_requests (next_attempt_at) WHERE status IN ('PENDING','CALLING');
