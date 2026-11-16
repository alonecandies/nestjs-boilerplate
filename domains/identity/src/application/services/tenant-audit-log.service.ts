import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@platform/common';
import {
  AuditEventsRepository,
  type AuditEventType,
} from '../persistence/audit-events.repository.js';

export interface TenantAuditEntry {
  tenantId: string;
  actorId: string | null;
  type: AuditEventType;
  data?: Record<string, unknown>;
  now?: Date;
}

/**
 * The tenant-visible audit trail (spec §5.1): one `identity.audit_events` row in the caller's unit of
 * work, then one structured log line (logger `IdentityAudit`, `audit: <type>`) for the operators'
 * pipeline. `data` must never hold secrets or tokens. Replaces the log-only role audit (AUDIT-F16).
 */
@Injectable()
export class TenantAuditLog {
  private readonly logger = new Logger('IdentityAudit');

  constructor(private readonly events: AuditEventsRepository) {}

  /** @returns the id of the appended row */
  async record(entry: TenantAuditEntry): Promise<string> {
    const id = generateId();
    const data = entry.data ?? {};
    await this.events.append({
      tenantId: entry.tenantId,
      id,
      actorId: entry.actorId,
      type: entry.type,
      data,
      createdAt: entry.now ?? new Date(),
    });
    this.logger.log(
      {
        audit: entry.type,
        auditEventId: id,
        tenantId: entry.tenantId,
        actorId: entry.actorId,
        data,
      },
      'Audit event recorded',
    );
    return id;
  }
}
