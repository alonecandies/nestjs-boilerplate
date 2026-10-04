import { type DrizzleTransactionalAdapter, TransactionHost } from '@app/database';
import { Injectable } from '@nestjs/common';
import type { TransactionRunner } from '../../application/persistence/transaction-runner.js';
import type { IdentitySchema } from './identity.schema.js';

/**
 * `TransactionRunner` on @nestjs-cls/transactional (registered by `DatabaseModule`):
 * `withTransaction` uses `Propagation.Required`, so nested calls join the outer transaction, and
 * it opens its own CLS context when none is active (crons, Kafka, gRPC handlers).
 */
@Injectable()
export class DrizzleTransactionRunner implements TransactionRunner {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>,
  ) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.txHost.withTransaction(work);
  }
}
