-- PIN for money-out actions (emergency withdrawal) and for changing the PIN itself.
-- Only a salted scrypt hash is stored. Wrong guesses are counted and lock the PIN.
ALTER TABLE merchants
    ADD COLUMN pin_hash            TEXT,
    ADD COLUMN pin_set_at          TIMESTAMPTZ,
    ADD COLUMN pin_failed_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN pin_locked_until    TIMESTAMPTZ,
    ADD CONSTRAINT chk_pin_attempts CHECK (pin_failed_attempts >= 0);
