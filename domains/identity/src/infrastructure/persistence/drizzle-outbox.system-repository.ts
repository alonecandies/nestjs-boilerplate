import { Injectable } from '@nestjs/common';
import { InjectSystemDatabase, SystemDatabase } from '@platform/database';
import { OutboxSystemRepository } from '@platform/outbox';
import type { IdentitySchema } from './identity.schema.js';
import { IDENTITY_OUTBOX } from './identity-outbox.js';

/**
 * `identity.outbox` on the app_system pool: the relay's poll, mark and purge (the shared
 * `OutboxSystemRepository`, one pinned `outbox.*` system method per call, inside
 * `SystemContext`). Identity pins those three (`IDENTITY_SYSTEM_METHODS.outbox`); it writes no
 * platform-tenant rows, so the inherited `insertAsPlatform` is neither pinned nor called.
 */
@Injectable()
export class IdentityOutboxSystemRepository extends OutboxSystemRepository {
  constructor(@InjectSystemDatabase() system: SystemDatabase<IdentitySchema>) {
    super(IDENTITY_OUTBOX, system);
  }
}
