-- Mail recipients: a projection of identity's user-registered events (email + display name), so
-- receipts and digests can be mailed without a synchronous call to identity. One row per user.
CREATE TABLE IF NOT EXISTS notification_recipients (
  user_id uuid PRIMARY KEY,
  email text,
  display_name text,
  updated_at timestamp
);
