export const inflowMeta = `
ALTER TABLE inflows ADD COLUMN counterparty TEXT;
ALTER TABLE inflows ADD COLUMN narration TEXT;
ALTER TABLE inflows ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_inflows_window ON inflows (merchant_id, settled_at);
`;
