-- Ledger tables (append-only: the application user has SELECT and INSERT only).
-- Money: INTEGER (int64) minor units, always >= 0, direction by the debit/credit pair.
-- Times: INTEGER epoch microseconds. No PII: immudb cannot erase.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id              VARCHAR[36],  -- uuidv5(LEDGER_NAMESPACE, 'account:' || owner || ':' || code || ':' || currency)
  owner_tenant_id VARCHAR[36],  -- PLATFORM_TENANT_ID for platform accounts
  code            VARCHAR[64],
  currency        VARCHAR[3],
  kind            VARCHAR[16],
  created_at_us   INTEGER,
  PRIMARY KEY id
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                   VARCHAR[36],  -- uuidv5(LEDGER_NAMESPACE, source_key): the idempotency key
  source_key           VARCHAR[128],
  tenant_id            VARCHAR[36],
  kind                 VARCHAR[32],
  payment_id           VARCHAR[36],  -- '' when none
  stripe_object        VARCHAR[64],  -- '' when none
  presentment_amount   INTEGER,      -- 0 when none
  presentment_currency VARCHAR[3],   -- '' when none
  payload_hash         VARCHAR[64],
  occurred_at_us       INTEGER,
  recorded_at_us       INTEGER,
  schema_version       INTEGER,
  PRIMARY KEY id
);
CREATE INDEX IF NOT EXISTS ON ledger_entries(tenant_id);
CREATE INDEX IF NOT EXISTS ON ledger_entries(payment_id);
CREATE INDEX IF NOT EXISTS ON ledger_entries(recorded_at_us);
CREATE TABLE IF NOT EXISTS ledger_postings (
  id         VARCHAR[40],  -- entry_id || ':' || line
  entry_id   VARCHAR[36],
  line       INTEGER,
  tenant_id  VARCHAR[36],  -- = ledger_entries.tenant_id (tenant-scoped sums)
  account_id VARCHAR[36],
  currency   VARCHAR[3],
  debit      INTEGER,
  credit     INTEGER,
  PRIMARY KEY id
);
CREATE INDEX IF NOT EXISTS ON ledger_postings(entry_id);
CREATE INDEX IF NOT EXISTS ON ledger_postings(tenant_id, account_id);
CREATE INDEX IF NOT EXISTS ON ledger_postings(account_id);
