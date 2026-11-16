import { Injectable } from '@nestjs/common';
import type { CursorPage } from '@platform/common';
import {
  type DrizzleTransactionalAdapter,
  keysetFetchLimit,
  keysetOrder,
  keysetPage,
  keysetWhere,
  TransactionHost,
} from '@platform/database';
import { and, eq } from 'drizzle-orm';
import type {
  AuditEventRecord,
  AuditEventsRepository,
  NewAuditEvent,
} from '../../application/persistence/audit-events.repository.js';
import { auditEvents, type IdentitySchema } from './identity.schema.js';

@Injectable()
export class DrizzleAuditEventsRepository implements AuditEventsRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>,
  ) {}

  async append(event: NewAuditEvent): Promise<void> {
    await this.txHost.tx.insert(auditEvents).values(event);
  }

  async listForTenant(
    tenantId: string,
    criteria: { limit: number; cursor?: string | undefined },
  ): Promise<CursorPage<AuditEventRecord>> {
    const rows = await this.txHost.tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), keysetWhere(auditEvents.id, criteria.cursor)))
      .orderBy(keysetOrder(auditEvents.id))
      .limit(keysetFetchLimit(criteria.limit));
    return keysetPage(rows, criteria.limit);
  }
}
