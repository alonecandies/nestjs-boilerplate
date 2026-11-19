import {
  LEDGER_POSTING_REQUESTED_EVENT,
  type LedgerPostingRequestedPayload,
} from '@domain/billing-contracts';
import { CommandBus } from '@nestjs/cqrs';
import { KafkaRetriableException, Payload } from '@nestjs/microservices';
import {
  createPrincipal,
  isDomainException,
  isPlatformTenantId,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import type { EventEnvelope } from '@platform/contracts';
import { isTransientConnectionError } from '@platform/database';
import { ImmudbError } from '@platform/immudb';
import {
  InvalidEventException,
  KafkaConsumerController,
  KafkaEventPattern,
  ParseEventEnvelopePipe,
} from '@platform/transport';
import { ProcessLedgerPostingCommand } from '../../application/commands/process-ledger-posting/process-ledger-posting.command.js';
import { BillingErrorCode } from '../../billing.constants.js';

/** `SystemContext` reason of platform-tenant and user-less postings. */
export const LEDGER_POSTING_SYSTEM_REASON = 'billing.ledger-posting';

/** Stripe failures worth a redelivery: 5xx, network and authentication (translated), and 429. */
const RETRIABLE_STRIPE_CODES: readonly string[] = [
  BillingErrorCode.PAYMENT_PROVIDER_ERROR,
  BillingErrorCode.PAYMENT_PROVIDER_RATE_LIMITED,
];

/**
 * Postgres failures worth a redelivery besides the connection codes of `isTransientConnectionError`:
 * statement, lock and idle-in-transaction timeouts.
 */
const POSTGRES_TIMEOUT_CODES: readonly string[] = ['57014', '55P03', '25P03'];

/**
 * `billing.ledger-posting.v1` → ledger entries (outbox plan Task 13, LG §3). The envelope must
 * agree with the payload: its tenant is the payload's and its actor the payload's user (`null` with
 * `null`); a disagreement is a forged or broken record and is thrown as `InvalidEventException`
 * before anything runs (dead-lettered). Then `ProcessLedgerPostingCommand` runs as
 * `{ userId, tenantId, roles: [] }`, or inside `SystemContext.run('billing.ledger-posting', …)`
 * when the tenant is `PLATFORM_TENANT_ID` or the user is null.
 * Failures (the outcomes table): immudb `unavailable`, a Stripe 5xx, 429 or network error and a
 * Postgres connection or timeout error (also after a post) become `KafkaRetriableException`, so
 * kafkajs redelivers the record and it is never dead-lettered; the deterministic entry ids make the
 * redelivery `replayed`. Everything else (a tenant mismatch, an unbalanced draft, a Stripe 404,
 * `42501`) is thrown as is and `@KafkaConsumerController()` dead-letters it to
 * `billing.ledger-posting.v1.dlq` without a discrepancy.
 */
@KafkaConsumerController()
export class LedgerPostingConsumer {
  constructor(private readonly commandBus: CommandBus) {}

  @KafkaEventPattern(LEDGER_POSTING_REQUESTED_EVENT)
  async onLedgerPosting(
    @Payload(new ParseEventEnvelopePipe(LEDGER_POSTING_REQUESTED_EVENT))
    event: EventEnvelope<LedgerPostingRequestedPayload>,
  ): Promise<void> {
    const request = event.payload;
    assertEnvelopeMatchesPayload(event);
    const run = () => this.commandBus.execute(new ProcessLedgerPostingCommand(request));
    try {
      if (isPlatformTenantId(request.tenantId) || request.userId === null) {
        await SystemContext.run(LEDGER_POSTING_SYSTEM_REASON, run);
      } else {
        const principal = createPrincipal({
          userId: request.userId,
          tenantId: request.tenantId,
          roles: [],
        });
        await runWithPrincipal(principal, run);
      }
    } catch (error) {
      if (isRetriableLedgerPostingError(error)) {
        // RpcException takes no options: the original error rides along as `cause` for the logs.
        throw Object.assign(
          new KafkaRetriableException(error instanceof Error ? error.message : String(error)),
          { cause: error },
        );
      }
      throw error;
    }
  }
}

/** @throws InvalidEventException when the envelope's tenant or actor is not the payload's */
function assertEnvelopeMatchesPayload(event: EventEnvelope<LedgerPostingRequestedPayload>): void {
  const { payload } = event;
  const issues = [
    ...(event.tenantId === payload.tenantId
      ? []
      : [{ path: ['tenantId'], message: 'The envelope tenantId must be the payload tenantId' }]),
    ...((event.actorId ?? null) === payload.userId
      ? []
      : [{ path: ['actorId'], message: 'The envelope actorId must be the payload userId' }]),
  ];
  if (issues.length > 0) {
    throw InvalidEventException.forTopic(LEDGER_POSTING_REQUESTED_EVENT.topic, issues);
  }
}

/**
 * True for the failures a redelivery can heal: immudb `unavailable`, a retriable Stripe failure,
 * and a Postgres connection or timeout error anywhere in the cause chain (drizzle wraps the
 * driver's error).
 */
export function isRetriableLedgerPostingError(error: unknown): boolean {
  if (error instanceof ImmudbError) return error.kind === 'unavailable';
  if (isDomainException(error)) return RETRIABLE_STRIPE_CODES.includes(error.code);
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 5; depth++) {
    if (isTransientConnectionError(current)) return true;
    const code = field(current, 'code');
    if (typeof code === 'string' && POSTGRES_TIMEOUT_CODES.includes(code)) return true;
    current = field(current, 'cause');
  }
  return false;
}

function field(value: unknown, name: 'code' | 'cause'): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}
