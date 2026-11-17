-- B4-1: the user-keyed tables are replaced by notifications_by_tenant_user (004) and
-- notification_recipients_by_tenant (003). Their rows carry no tenant, so nothing is copied: old
-- inbox rows (90-day TTL, best effort) and old recipients are dropped, and recipients come back
-- from membership events. Dev resets its volumes (docker compose down -v).
DROP TABLE IF EXISTS notifications_by_user;
DROP TABLE IF EXISTS notification_recipients;
