-- 003: bookkeeping an emergency withdrawal needs to be retried or undone safely.
--   PENDING   = funds reserved in the ledger, bank credit not yet confirmed
--   DISBURSED = bank credit confirmed
--   REJECTED  = bank refused; the reservation was reversed in the ledger
ALTER TABLE emergency_withdrawals
    ADD COLUMN previous_last_withdrawal_at TIMESTAMPTZ,
    ADD COLUMN attempts         INT NOT NULL DEFAULT 0,
    ADD COLUMN last_error       TEXT,
    ADD COLUMN failure_reason   TEXT,
    ADD COLUMN credit_reference VARCHAR(100);

CREATE INDEX idx_withdrawals_pending ON emergency_withdrawals (created_at) WHERE status = 'PENDING';
