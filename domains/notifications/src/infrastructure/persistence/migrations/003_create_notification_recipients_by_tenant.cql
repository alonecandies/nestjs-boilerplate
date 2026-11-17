-- Mail recipients per membership: a projection of identity's membership-created / membership-removed
-- events (email + display name), so receipts and digests can be mailed without a synchronous call to
-- identity. One row per (tenant, user): a user in two tenants has two rows, and removing one
-- membership leaves the other. Writes carry USING TIMESTAMP = the event's time, so replays converge.
-- No backfill from notification_recipients (002): a user-keyed row has no tenant.
CREATE TABLE IF NOT EXISTS notification_recipients_by_tenant (
  tenant_id uuid,
  user_id uuid,
  email text,
  display_name text,
  updated_at timestamp,
  PRIMARY KEY ((tenant_id, user_id))
);
