import {
  LEDGER_POSTING_REQUESTED_EVENT,
  type LedgerPostingRequestedPayload,
} from '@domain/billing-contracts';
import { type ArgumentsHost, type ExecutionContext, Logger } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA, INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
import type { CommandBus } from '@nestjs/cqrs';
import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import {
  DomainValidationException,
  ExternalServiceException,
  getPrincipal,
  PLATFORM_TENANT_ID,
  ServiceUnavailableException,
  SystemContext,
} from '@platform/common';
import { createEventEnvelope, type EventEnvelope } from '@platform/contracts';
import { ImmudbError } from '@platform/immudb';
import {
  DEFAULT_KAFKA_RETRY_OPTIONS,
  InvalidEventException,
  isRetriableKafkaHandlerError,
  KafkaDeadLetterFilter,
  KafkaRetryInterceptor,
} from '@platform/transport';
import { register } from 'prom-client';
import { catchError, defer, lastValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEDGER_TEST_TENANT as TENANT_A } from '../../../test/ledger-fixtures.js';
import { PostLedgerEntryCommand } from '../../application/commands/post-ledger-entry/post-ledger-entry.command.js';
import { PostLedgerEntryHandler } from '../../application/commands/post-ledger-entry/post-ledger-entry.handler.js';
import { ProcessLedgerPostingCommand } from '../../application/commands/process-ledger-posting/process-ledger-posting.command.js';
import { ProcessLedgerPostingHandler } from '../../application/commands/process-ledger-posting/process-ledger-posting.handler.js';
import { LedgerService } from '../../application/ledger/ledger.service.js';
import type { PostingBalanceTransaction } from '../../application/ledger/posting-rules.js';
import { BillingErrorCode } from '../../billing.constants.js';
import { LedgerUnbalancedException } from '../../domain/ledger/ledger.errors.js';
import { LEDGER_POSTINGS_TOTAL } from '../../infrastructure/ledger/ledger-metrics.js';
import type { LedgerSource, StripeService } from '../../infrastructure/stripe/stripe.service.js';
import { InMemoryLedger } from '../../testing/in-memory-ledger.js';
import { InMemoryLedgerStore } from '../../testing/in-memory-ledger-store.js';
import { LedgerPostingConsumer } from './ledger-posting.consumer.js';

const USER_A1 = '0192f0c1-0000-7000-8000-00000000a001';
const USER_A2 = '0192f0c1-0000-7000-8000-00000000a002';
const TENANT_B = '0192f0c1-0000-7000-8000-000000000002';
const PAYMENT = '0192f0c1-0000-7000-8000-0000000000aa';
const ENVELOPE_ID = '0192f0c1-0000-5000-8000-00000000e001';

const payload = (
  overrides: Partial<LedgerPostingRequestedPayload> = {},
): LedgerPostingRequestedPayload => ({
  source: 'stripe',
  stripeEventId: 'evt_1',
  stripeEventType: 'charge.succeeded',
  objectType: 'charge',
  objectId: 'ch_1',
  tenantId: TENANT_A,
  userId: USER_A1,
  paymentId: PAYMENT,
  livemode: false,
  ...overrides,
});

/** The envelope as the relay publishes it: tenant and actor from the payload unless overridden. */
const envelope = (
  body: LedgerPostingRequestedPayload,
  meta: { tenantId?: string; actorId?: string | null } = {},
): EventEnvelope<LedgerPostingRequestedPayload> => {
  const tenantId = 'tenantId' in meta ? meta.tenantId : body.tenantId;
  const actorId = 'actorId' in meta ? meta.actorId : body.userId;
  return {
    ...createEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, body, {
      id: ENVELOPE_ID,
      source: 'billing',
      tenantId: tenantId ?? TENANT_A,
      actorId: actorId ?? null,
    }),
    ...(tenantId === undefined ? { tenantId: undefined } : {}),
  };
};

const txn = (overrides: Partial<PostingBalanceTransaction> = {}): PostingBalanceTransaction => ({
  id: 'txn_1',
  amount: 2_500,
  fee: 103,
  currency: 'usd',
  created: 1_794_182_400,
  reporting_category: 'charge',
  source: 'ch_1',
  ...overrides,
});

const counted = async (name: string, labels: Record<string, string>) => {
  const metric = register.getSingleMetric(name);
  const values = metric === undefined ? [] : (await metric.get()).values;
  return (
    values.find((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value ?? 0
  );
};

describe('LedgerPostingConsumer', () => {
  let ledger: InMemoryLedger;
  let store: InMemoryLedgerStore;
  let ledgerSource: ReturnType<typeof vi.fn<StripeService['ledgerSource']>>;
  /** Who each ProcessLedgerPostingCommand ran as. */
  let dispatched: { principal: unknown; system: string | undefined; request: unknown }[];
  let consumer: LedgerPostingConsumer;

  const source = (value: Partial<LedgerSource> = {}): LedgerSource => ({
    transactions: [txn()],
    pending: false,
    presentment: { amount: 2_500n, currency: 'usd' },
    ...value,
  });

  beforeEach(() => {
    register.resetMetrics();
    ledger = new InMemoryLedger();
    store = new InMemoryLedgerStore();
    dispatched = [];
    ledgerSource = vi.fn<StripeService['ledgerSource']>().mockResolvedValue(source());
    const stripe = { ledgerSource } as unknown as StripeService;
    const post = new PostLedgerEntryHandler(
      new LedgerService(ledger),
      store.receipts,
      store.system,
    );
    const commandBus = {
      execute: (command: unknown): Promise<unknown> => {
        if (command instanceof PostLedgerEntryCommand) return post.execute(command);
        if (command instanceof ProcessLedgerPostingCommand) {
          dispatched.push({
            principal: getPrincipal(),
            system: SystemContext.current()?.reason,
            request: command.request,
          });
          return process.execute(command);
        }
        throw new Error('unexpected command');
      },
    } as unknown as CommandBus;
    const process = new ProcessLedgerPostingHandler(
      commandBus,
      stripe,
      store.receipts,
      store.system,
    );
    consumer = new LedgerPostingConsumer(commandBus);
  });

  it('actor and tenant in the envelope → the command runs under that principal', async () => {
    await consumer.onLedgerPosting(envelope(payload()));

    expect(dispatched).toEqual([
      {
        principal: { userId: USER_A1, tenantId: TENANT_A, roles: [], staff: false },
        system: undefined,
        request: payload(),
      },
    ]);
    expect(store.entryRefs).toEqual([expect.objectContaining({ tenantId: TENANT_A })]);
  });

  it.each([
    [
      'the nil tenant',
      payload({
        tenantId: PLATFORM_TENANT_ID,
        userId: null,
        paymentId: null,
        objectType: 'payout',
        objectId: 'po_1',
      }),
    ],
    ['a null actor', payload({ userId: null })],
  ])("%s → SystemContext with reason 'billing.ledger-posting'", async (_label, body) => {
    ledgerSource.mockResolvedValue(
      source({
        transactions: [
          body.objectType === 'payout'
            ? txn({ reporting_category: 'payout', amount: -10_000, fee: 0, source: 'po_1' })
            : txn(),
        ],
      }),
    );

    await consumer.onLedgerPosting(envelope(body));

    expect(dispatched).toEqual([
      { principal: undefined, system: 'billing.ledger-posting', request: body },
    ]);
    expect(store.entryRefs).toEqual([expect.objectContaining({ tenantId: body.tenantId })]);
  });

  it.each([
    ['envelope tenant ≠ payload tenant', payload({ tenantId: TENANT_B }), { tenantId: TENANT_A }],
    [
      'the platform payload inside a tenant envelope',
      payload({ tenantId: PLATFORM_TENANT_ID, userId: null }),
      { tenantId: TENANT_A, actorId: null },
    ],
    ['an envelope without a tenant', payload(), { tenantId: undefined }],
    ['envelope actor ≠ payload user', payload(), { actorId: USER_A2 }],
    ['a null envelope actor with a payload user', payload(), { actorId: null }],
    ['an envelope actor with a null payload user', payload({ userId: null }), { actorId: USER_A1 }],
  ])('%s is thrown (dead-lettered) without dispatching the command', async (_label, body, meta) => {
    const error = await consumer.onLedgerPosting(envelope(body, meta)).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(InvalidEventException);
    expect(error).not.toBeInstanceOf(KafkaRetriableException);
    expect(dispatched).toEqual([]);
    expect(ledgerSource).not.toHaveBeenCalled();
  });

  type FailingStep = 'post' | 'stripe' | 'ref';
  it.each<[string, FailingStep, () => Error]>([
    ['immudb unavailable', 'post', () => new ImmudbError('unavailable', 'no session found')],
    [
      'a Stripe 5xx or network error',
      'stripe',
      () =>
        new ExternalServiceException('The payment provider request failed', {
          code: BillingErrorCode.PAYMENT_PROVIDER_ERROR,
        }),
    ],
    [
      'a Stripe 429',
      'stripe',
      () =>
        new ServiceUnavailableException('busy', {
          code: BillingErrorCode.PAYMENT_PROVIDER_RATE_LIMITED,
        }),
    ],
    [
      'a Postgres connection error wrapped by drizzle, after the post',
      'ref',
      () =>
        new Error('Failed query: insert …', {
          cause: Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' }),
        }),
    ],
    [
      'a Postgres statement timeout, after the post',
      'ref',
      () =>
        Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014',
        }),
    ],
  ])(
    '%s → KafkaRetriableException (redelivered, never dead-lettered)',
    async (_label, step, make) => {
      const failure = make();
      if (step === 'post') vi.spyOn(ledger, 'post').mockRejectedValue(failure);
      else if (step === 'ref')
        vi.spyOn(store.receipts, 'recordEntryRef').mockRejectedValue(failure);
      else ledgerSource.mockRejectedValue(failure);

      const error = await consumer.onLedgerPosting(envelope(payload())).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(KafkaRetriableException);
      expect((error as Error).cause).toBe(failure);
    },
  );

  describe('deadlocks and serialization failures: the bounded Kafka retry budget, then the DLQ (G2)', () => {
    const DLQ = `${LEDGER_POSTING_REQUESTED_EVENT.topic}.dlq`;
    const contention: [string, () => Error][] = [
      [
        'a deadlock (40P01)',
        () => Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      ],
      [
        'a deadlock (40P01) wrapped by drizzle',
        () =>
          new Error('Failed query: insert …', {
            cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
          }),
      ],
      [
        'a serialization failure (40001)',
        () =>
          Object.assign(new Error('could not serialize access due to concurrent update'), {
            code: '40001',
          }),
      ],
      [
        'a serialization failure (40001) wrapped by drizzle',
        () =>
          new Error('Failed query: insert …', {
            cause: Object.assign(new Error('could not serialize access'), { code: '40001' }),
          }),
      ],
    ];
    let sent: { topic: string }[];

    /**
     * One Kafka delivery through what `@KafkaConsumerController()` wraps the handler in: the retry
     * interceptor (the default attempt budget, short delays) and the dead-letter filter.
     */
    const deliver = (message: EventEnvelope<LedgerPostingRequestedPayload>) => {
      sent = [];
      const producer = {
        send: async (record: { topic: string }) => {
          sent.push(record);
          return [];
        },
      };
      const context = new KafkaContext([
        { key: TENANT_A, value: message, headers: {}, offset: '9' } as never,
        0,
        LEDGER_POSTING_REQUESTED_EVENT.topic,
        {} as never,
        () => Promise.resolve(),
        producer as never,
      ]);
      const rpc = {
        getType: () => 'rpc',
        switchToRpc: () => ({ getContext: () => context, getData: () => message }),
      } as unknown as ExecutionContext & ArgumentsHost;
      const retry = new KafkaRetryInterceptor({ minDelayMs: 1, maxDelayMs: 2 });
      return lastValueFrom(
        retry
          .intercept(rpc, { handle: () => defer(() => consumer.onLedgerPosting(message)) })
          .pipe(catchError((error: unknown) => new KafkaDeadLetterFilter().catch(error, rpc))),
      );
    };

    beforeEach(() => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    it('the consumer is wrapped in the Kafka retry interceptor and the dead-letter filter', () => {
      const interceptors: unknown[] = Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        LedgerPostingConsumer,
      );
      const filters: unknown[] = Reflect.getMetadata(
        EXCEPTION_FILTERS_METADATA,
        LedgerPostingConsumer,
      );
      expect(interceptors.some((i) => i instanceof KafkaRetryInterceptor)).toBe(true);
      expect(filters).toContain(KafkaDeadLetterFilter);
    });

    it.each(contention)(
      '%s is thrown as is: retriable in-process, never KafkaRetriableException',
      async (_label, make) => {
        const failure = make();
        vi.spyOn(store.receipts, 'recordEntryRef').mockRejectedValue(failure);

        const error = await consumer.onLedgerPosting(envelope(payload())).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(error).toBe(failure);
        expect(isRetriableKafkaHandlerError(error)).toBe(true);
      },
    );

    it.each(contention)(
      '%s within the budget: retried, then posted, nothing dead-lettered',
      async (_label, make) => {
        const record = vi.spyOn(store.receipts, 'recordEntryRef');
        const attempts = DEFAULT_KAFKA_RETRY_OPTIONS.attempts;
        for (let i = 1; i < attempts; i++) record.mockRejectedValueOnce(make());

        await expect(deliver(envelope(payload()))).resolves.toBeUndefined();

        expect(record).toHaveBeenCalledTimes(attempts);
        expect(sent).toEqual([]);
        expect(store.entryRefs).toEqual([expect.objectContaining({ tenantId: TENANT_A })]);
      },
    );

    it.each(contention)(
      '%s over the budget: dead-lettered, the partition moves on',
      async (_label, make) => {
        const record = vi.spyOn(store.receipts, 'recordEntryRef').mockRejectedValue(make());

        await expect(deliver(envelope(payload()))).resolves.toBeNull();

        expect(record).toHaveBeenCalledTimes(DEFAULT_KAFKA_RETRY_OPTIONS.attempts);
        expect(sent).toEqual([expect.objectContaining({ topic: DLQ })]);
        expect(store.discrepancies).toEqual([]);
      },
    );
  });

  it('a Postgres outage after the post is retriable, and the redelivery records the ref as replayed', async () => {
    vi.spyOn(store.receipts, 'recordEntryRef').mockRejectedValueOnce(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );

    await expect(consumer.onLedgerPosting(envelope(payload()))).rejects.toBeInstanceOf(
      KafkaRetriableException,
    );
    await consumer.onLedgerPosting(envelope(payload()));

    expect(store.entryRefs).toEqual([
      expect.objectContaining({ tenantId: TENANT_A, immudbTxId: null }),
    ]);
  });

  it.each([
    [
      'a tenant mismatch from LedgerService',
      () => {
        ledgerSource.mockResolvedValue(
          source({ transactions: [txn({ reporting_category: 'fee', amount: -200, fee: 0 })] }),
        );
        return { code: 'LEDGER_TENANT_MISMATCH' };
      },
    ],
    [
      'an unbalanced draft',
      () => {
        const unbalanced = new LedgerUnbalancedException('stripe:txn:txn_1', ['debit ≠ credit']);
        vi.spyOn(ledger, 'post').mockRejectedValue(unbalanced);
        return unbalanced;
      },
    ],
    [
      'a Stripe 404',
      () => {
        const missing = new DomainValidationException('No such charge', {
          code: BillingErrorCode.PAYMENT_REQUEST_INVALID,
        });
        ledgerSource.mockRejectedValue(missing);
        return missing;
      },
    ],
    [
      'an RLS refusal (42501)',
      () => {
        const denied = Object.assign(new Error('new row violates row-level security policy'), {
          code: '42501',
        });
        vi.spyOn(store.receipts, 'recordEntryRef').mockRejectedValue(denied);
        return denied;
      },
    ],
  ])('%s is thrown as is (dead-lettered, no discrepancy)', async (_label, arrange) => {
    const expected = arrange();

    const error = await consumer.onLedgerPosting(envelope(payload())).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).not.toBeInstanceOf(KafkaRetriableException);
    if (expected instanceof Error) expect(error).toBe(expected);
    else expect(error).toMatchObject(expected);
    expect(store.discrepancies).toEqual([]);
  });

  it('the same envelope delivered twice → the second run is all replayed', async () => {
    ledgerSource.mockResolvedValue(
      source({
        transactions: [
          txn({
            id: 'txn_d1',
            reporting_category: 'dispute',
            amount: -2_500,
            fee: 1_500,
            source: 'du_1',
          }),
          txn({
            id: 'txn_d2',
            reporting_category: 'dispute_reversal',
            amount: 2_500,
            fee: 0,
            source: 'du_1',
          }),
        ],
      }),
    );
    const message = envelope(payload({ objectType: 'dispute', objectId: 'du_1' }));

    await consumer.onLedgerPosting(message);
    const refs = structuredClone(store.entryRefs);
    const accounts = structuredClone(store.accounts);
    await consumer.onLedgerPosting(message);

    expect(await counted(LEDGER_POSTINGS_TOTAL, { outcome: 'posted' })).toBe(2);
    expect(await counted(LEDGER_POSTINGS_TOTAL, { outcome: 'replayed' })).toBe(2);
    expect(await counted(LEDGER_POSTINGS_TOTAL, { outcome: 'conflict' })).toBe(0);
    expect(store.entryRefs).toEqual(refs);
    expect(store.accounts).toEqual(accounts);
    expect(store.discrepancies).toEqual([]);
  });
});
