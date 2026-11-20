import { Injectable } from '@nestjs/common';
import {
  assertRowsAffected,
  type DrizzleTransactionalAdapter,
  inUnitOfWork,
  TransactionHost,
} from '@platform/database';
import type { UsageRepository } from '../../application/repositories/usage.repository.js';
import type { UsageRecord } from '../../domain/ai.types.js';
import { type AiSchema, usage } from './ai.schema.js';

/** The usage log on the runtime pool under RLS: a plain INSERT in the caller's unit of work. */
@Injectable()
export class DrizzleUsageRepository implements UsageRepository {
  constructor(private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<AiSchema>>) {}

  async record(entry: UsageRecord): Promise<void> {
    const result = await inUnitOfWork(this.txHost, (tx) => tx.insert(usage).values({ ...entry }));
    assertRowsAffected(result, 1, 'usage.record');
  }
}
