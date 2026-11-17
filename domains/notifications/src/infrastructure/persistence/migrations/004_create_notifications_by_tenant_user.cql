-- Inbox: one partition per (tenant, user), newest first. A user in two tenants has two inboxes, and
-- every statement binds both partition-key columns (no ALLOW FILTERING, no scatter-gather).
-- notification_id is a uuidv7, and Cassandra orders non-time-based uuids byte-wise, which for v7 is
-- time order. Rows expire after 90 days (default_time_to_live = 7776000 s, NOTIFICATIONS_TTL_SEC),
-- so the partition stays bounded without deletes/tombstones. `read` is absent (null) until the
-- notification is marked read: inserts never write it, so an idempotent re-insert cannot flip a
-- read notification back to unread. No backfill from notifications_by_user (001): a user-keyed row
-- has no tenant; 005 drops that table.
CREATE TABLE IF NOT EXISTS notifications_by_tenant_user (
  tenant_id uuid,
  user_id uuid,
  notification_id uuid,
  type text,
  title text,
  body text,
  data map<text, text>,
  read boolean,
  created_at timestamp,
  PRIMARY KEY ((tenant_id, user_id), notification_id)
) WITH CLUSTERING ORDER BY (notification_id DESC)
  AND default_time_to_live = 7776000;
