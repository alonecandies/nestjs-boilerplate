import type { CursorPage } from '@platform/common';

/** Audit event types written in a tenant's log (`<subject>.<verb>`); the edge tasks named are the writers. */
export const AUDIT_EVENT_TYPES = {
  STAFF_SWITCH_IN: 'staff.switch_in',
  STAFF_SWITCH_OUT: 'staff.switch_out',
  MEMBER_ROLES_CHANGED: 'member.roles_changed', // edge B2-13
  MEMBER_REMOVED: 'member.removed', // edge B2-13
  MEMBER_LEFT: 'member.left', // edge B2-13
  INVITATION_CREATED: 'invitation.created', // edge B2-14
  INVITATION_ACCEPTED: 'invitation.accepted', // edge B2-14
  TENANT_RENAMED: 'tenant.renamed', // edge B2-12
} as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[keyof typeof AUDIT_EVENT_TYPES];

export interface AuditEventRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly actorId: string | null;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface NewAuditEvent {
  tenantId: string;
  id: string;
  actorId: string | null;
  type: AuditEventType;
  data: Record<string, unknown>;
  createdAt: Date;
}

/** Append-only tenant audit log (`identity.audit_events`, distributed by tenant_id). */
export abstract class AuditEventsRepository {
  abstract append(event: NewAuditEvent): Promise<void>;

  /** Keyset page on the uuidv7 id within the tenant, newest first. */
  abstract listForTenant(
    tenantId: string,
    criteria: { limit: number; cursor?: string | undefined },
  ): Promise<CursorPage<AuditEventRecord>>;
}
