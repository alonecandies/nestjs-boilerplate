-- Inbox: one partition per user, newest first. notification_id is a uuidv7, and Cassandra orders
-- non-time-based uuids byte-wise, which for v7 is time order (verified). Rows expire after 90 days
-- (default_time_to_live = 7776000 s), so the partition stays bounded without deletes/tombstones.
-- `read` is absent (null) until the notification is marked read: inserts never write it, so an
-- idempotent re-insert cannot flip a read notification back to unread.
CREATE TABLE IF NOT EXISTS notifications_by_user (
  user_id uuid,
  notification_id uuid,
  type text,
  title text,
  body text,
  data map<text, text>,
  read boolean,
  created_at timestamp,
  PRIMARY KEY ((user_id), notification_id)
) WITH CLUSTERING ORDER BY (notification_id DESC)
  AND default_time_to_live = 7776000;
