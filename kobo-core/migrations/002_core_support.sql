-- 002: tables and columns the core service needs on top of the canonical schema (001).
-- Ledger sign convention (documented once, used everywhere):
--   DEBIT  = the account's balance goes DOWN, CREDIT = the account's balance goes UP.
--   A sweep:      DEBIT MERCHANT_CASH S | CREDIT EMERGENCY_POT e | CREDIT RETIREMENT_POT r   (e + r = S)
--   A withdrawal: DEBIT EMERGENCY_POT w | CREDIT MERCHANT_CASH w

-- Bank-side reference of the confirmed debit, plus retry bookkeeping for the nightly engine.
ALTER TABLE daily_sweeps
    ADD COLUMN debit_reference VARCHAR(100),
    ADD COLUMN attempts        INT NOT NULL DEFAULT 0,
    ADD COLUMN last_error      TEXT;

-- PenCom-style contribution references: PEN-YYYYMMDD-NNNNNN, sequential per sweep date.
CREATE TABLE pen_reference_counters (
    ref_date   DATE PRIMARY KEY,
    last_value INT  NOT NULL
);

-- One reference per (merchant, sweep date), reserved before the debit so the bank narration can carry it.
CREATE TABLE pension_references (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    sweep_date  DATE        NOT NULL,
    reference   VARCHAR(50) NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_pension_ref_merchant_date UNIQUE (merchant_id, sweep_date)
);

-- Transactional outbox for SMS: rows are written in the same transaction as the event that caused them.
CREATE TABLE sms_outbox (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id         UUID REFERENCES merchants(id) ON DELETE SET NULL,
    to_phone            VARCHAR(20)  NOT NULL,
    kind                VARCHAR(30)  NOT NULL,
    body                TEXT         NOT NULL,
    dedupe_key          VARCHAR(100) UNIQUE,
    status              VARCHAR(10)  NOT NULL DEFAULT 'QUEUED',
    attempts            INT          NOT NULL DEFAULT 0,
    next_attempt_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    provider_message_id VARCHAR(100),
    last_error          TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    sent_at             TIMESTAMPTZ,
    CONSTRAINT chk_sms_status CHECK (status IN ('QUEUED','SENDING','SENT','FAILED'))
);
CREATE INDEX idx_sms_outbox_due ON sms_outbox (next_attempt_at) WHERE status IN ('QUEUED','SENDING');

-- USSD option 6 (spoken balance): queue for the IVR/voice service to consume.
CREATE TABLE voice_callback_requests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    language    VARCHAR(10) NOT NULL,
    status      VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_voice_status CHECK (status IN ('PENDING','DONE','FAILED'))
);
CREATE INDEX idx_voice_pending ON voice_callback_requests (merchant_id) WHERE status = 'PENDING';
