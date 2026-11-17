SELECT app.make_reference('identity.users');--> statement-breakpoint
SELECT app.make_reference('identity.tenants');--> statement-breakpoint
SELECT app.make_reference('identity.memberships');--> statement-breakpoint
SELECT app.distribute_by_tenant('identity.invitations');--> statement-breakpoint
SELECT app.distribute_by_tenant('identity.audit_events');--> statement-breakpoint
SELECT app.distribute_by_user('identity.sessions');
