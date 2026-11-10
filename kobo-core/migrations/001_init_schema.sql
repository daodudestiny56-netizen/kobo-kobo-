-- Kobo Kobo canonical schema (PostgreSQL 14+)
-- Source of truth: PRD v2 naming. Resolves v1/v2 drift (see header notes).
--   v1 inflow `reference`            -> `bank_reference`
--   v1 inflow `status SETTLED/EXCLUDED` -> `is_excluded_from_sweep` + `exclusion_reason`
-- All money is NUMERIC(14,2) naira. Split math is done in integer kobo in app code.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- merchants
CREATE TABLE merchants (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number       VARCHAR(20)  NOT NULL UNIQUE,
    full_name          VARCHAR(100) NOT NULL,
    bvn_hash           VARCHAR(64)  NOT NULL,
    nin_hash           VARCHAR(64),
    access_nuban       VARCHAR(10)  NOT NULL UNIQUE,
    access_wallet_id   VARCHAR(50),
    preferred_language VARCHAR(10)  NOT NULL DEFAULT 'pidgin',
    sweep_percentage   NUMERIC(4,2) NOT NULL DEFAULT 2.00,
    daily_cap          NUMERIC(12,2) NOT NULL DEFAULT 5000.00,
    min_buffer_balance NUMERIC(12,2) NOT NULL DEFAULT 1000.00,
    is_paused          BOOLEAN      NOT NULL DEFAULT FALSE,
    paused_until       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_language CHECK (preferred_language IN ('pidgin','yoruba','hausa','igbo','en')),
    CONSTRAINT chk_rate     CHECK (sweep_percentage BETWEEN 1.00 AND 5.00),
    CONSTRAINT chk_cap      CHECK (daily_cap >= 0),
    CONSTRAINT chk_buffer   CHECK (min_buffer_balance >= 0)
);

-- A merchant is effectively paused iff:
--   is_paused AND (paused_until IS NULL OR paused_until > now)
CREATE VIEW merchant_sweep_state AS
SELECT m.*,
       (m.is_paused AND (m.paused_until IS NULL OR m.paused_until > NOW())) AS effectively_paused
FROM merchants m;

-- --------------------------------------------------------- pension_accounts
CREATE TABLE pension_accounts (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id           UUID NOT NULL UNIQUE REFERENCES merchants(id) ON DELETE CASCADE,
    rsa_pin               VARCHAR(30) NOT NULL UNIQUE,
    pfa_code              VARCHAR(20) NOT NULL DEFAULT 'ACCESS_ARM',
    emergency_balance     NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    retirement_balance    NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    first_contribution_at TIMESTAMPTZ,
    last_withdrawal_at    TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_emergency_nonneg  CHECK (emergency_balance  >= 0),
    CONSTRAINT chk_retirement_nonneg CHECK (retirement_balance >= 0)
);

-- ------------------------------------------------------ inflow_transactions
CREATE TABLE inflow_transactions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id           UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    bank_reference        VARCHAR(100) NOT NULL UNIQUE,   -- idempotency key for inflows
    amount                NUMERIC(14,2) NOT NULL,
    channel               VARCHAR(30)  NOT NULL,
    is_excluded_from_sweep BOOLEAN     NOT NULL DEFAULT FALSE,
    exclusion_reason      VARCHAR(100),
    settled_at            TIMESTAMPTZ  NOT NULL,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_inflow_amount  CHECK (amount > 0),
    CONSTRAINT chk_inflow_channel CHECK (channel IN ('POS','NIP_TRANSFER','QR')),
    CONSTRAINT chk_exclusion      CHECK (is_excluded_from_sweep OR exclusion_reason IS NULL)
);
CREATE INDEX idx_inflow_merchant_settled ON inflow_transactions (merchant_id, settled_at);

-- -------------------------------------------------------------- daily_sweeps
CREATE TABLE daily_sweeps (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id       UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    sweep_date        DATE NOT NULL,                       -- WAT calendar date
    total_takings     NUMERIC(14,2) NOT NULL,
    applied_rate      NUMERIC(4,2)  NOT NULL,
    sweep_amount      NUMERIC(14,2) NOT NULL,
    emergency_amount  NUMERIC(14,2) NOT NULL,
    retirement_amount NUMERIC(14,2) NOT NULL,
    -- NULL for sweeps that moved no money (skipped / held / failed).
    -- UNIQUE still enforced for real references (NULLs are distinct in Postgres).
    pension_reference VARCHAR(50) UNIQUE,
    status            VARCHAR(20) NOT NULL,
    failure_reason    TEXT,
    executed_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_merchant_sweep_per_day UNIQUE (merchant_id, sweep_date),
    CONSTRAINT chk_sweep_status CHECK (status IN
        ('PENDING','EXECUTED','SKIPPED_ZERO_SALES','SKIPPED_PAUSED','SKIPPED_BUFFER','FAILED','HELD_GUARD')),
    CONSTRAINT chk_sweep_split  CHECK (emergency_amount + retirement_amount = sweep_amount),
    CONSTRAINT chk_executed_ref CHECK (status <> 'EXECUTED' OR (pension_reference IS NOT NULL AND sweep_amount > 0))
);
CREATE INDEX idx_sweeps_date_status ON daily_sweeps (sweep_date, status);

-- ------------------------------------------------------------ ledger_entries
-- Immutable, double-entry. One journal per executed sweep:
--   DEBIT  MERCHANT_CASH    S
--   CREDIT EMERGENCY_POT    e
--   CREDIT RETIREMENT_POT   r        (e + r = S, odd kobo goes to retirement)
CREATE TABLE ledger_entries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_id   UUID NOT NULL,
    sweep_id     UUID REFERENCES daily_sweeps(id),
    merchant_id  UUID NOT NULL REFERENCES merchants(id),
    account_type VARCHAR(30) NOT NULL,
    entry_type   VARCHAR(10) NOT NULL,
    amount       NUMERIC(14,2) NOT NULL,
    reference    VARCHAR(100) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ledger_account CHECK (account_type IN
        ('MERCHANT_CASH','EMERGENCY_POT','RETIREMENT_POT','PFA_ESCROW')),
    CONSTRAINT chk_ledger_type    CHECK (entry_type IN ('DEBIT','CREDIT')),
    CONSTRAINT chk_ledger_amount  CHECK (amount > 0),
    CONSTRAINT uq_ledger_line     UNIQUE (journal_id, account_type, entry_type)
);
CREATE INDEX idx_ledger_merchant ON ledger_entries (merchant_id, created_at);
CREATE INDEX idx_ledger_sweep    ON ledger_entries (sweep_id);

CREATE FUNCTION ledger_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is immutable (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_immutable
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

-- Debits must equal credits per journal; checked at commit.
CREATE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
DECLARE d NUMERIC; c NUMERIC;
BEGIN
    SELECT COALESCE(SUM(amount) FILTER (WHERE entry_type='DEBIT'),0),
           COALESCE(SUM(amount) FILTER (WHERE entry_type='CREDIT'),0)
      INTO d, c FROM ledger_entries WHERE journal_id = NEW.journal_id;
    IF d <> c THEN
        RAISE EXCEPTION 'unbalanced journal %: debits % vs credits %', NEW.journal_id, d, c;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_ledger_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

-- ----------------------------------------------------- emergency_withdrawals
CREATE TABLE emergency_withdrawals (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pension_account_id UUID NOT NULL REFERENCES pension_accounts(id),
    amount             NUMERIC(14,2) NOT NULL,
    destination_nuban  VARCHAR(10) NOT NULL,
    status             VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    disbursed_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_wd_amount CHECK (amount > 0),
    CONSTRAINT chk_wd_status CHECK (status IN ('PENDING','APPROVED','DISBURSED','REJECTED'))
);

-- --------------------------------------------------------- sweep_guard_alerts
CREATE TABLE sweep_guard_alerts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    sweep_id    UUID REFERENCES daily_sweeps(id),
    alert_type  VARCHAR(50) NOT NULL,
    details     JSONB,
    status      VARCHAR(20) NOT NULL DEFAULT 'PENDING_REVIEW',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_alert_type   CHECK (alert_type IN ('ANOMALOUS_INFLOW','LOW_BUFFER','SUSPECTED_DUPLICATE','NAME_MISMATCH')),
    CONSTRAINT chk_alert_status CHECK (status IN ('PENDING_REVIEW','DISMISSED','CONFIRMED'))
);

COMMIT;
