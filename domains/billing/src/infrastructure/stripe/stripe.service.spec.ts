import { DomainValidationException, ExternalServiceException } from '@platform/common';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { stripeConfig } from './stripe.config.js';
import { STRIPE_API_VERSION } from './stripe.constants.js';
import { createStripeClient } from './stripe.module.js';
import { StripeService } from './stripe.service.js';

const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests';
const cfg = stripeConfig.parse({
  STRIPE_SECRET_KEY: 'sk_test_unit',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
});

const event = {
  id: 'evt_test_1',
  object: 'event',
  type: 'checkout.session.completed',
  api_version: Stripe.API_VERSION,
  created: 1_700_000_000,
  livemode: false,
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  data: { object: { id: 'cs_test_1', object: 'checkout.session', client_reference_id: 'pay_1' } },
};
const payload = JSON.stringify(event);

function createService(): StripeService {
  return new StripeService(createStripeClient(cfg), cfg);
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the function to throw');
}

describe('StripeService.constructWebhookEvent', () => {
  it('accepts a correctly signed raw payload', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const parsed = createService().constructWebhookEvent(Buffer.from(payload), header);

    expect(parsed.id).toBe('evt_test_1');
    expect(parsed.type).toBe('checkout.session.completed');
  });

  it('rejects a signature made with another secret', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' });

    const error = catchError(() =>
      createService().constructWebhookEvent(Buffer.from(payload), header),
    );

    expect(error).toBeInstanceOf(DomainValidationException);
    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE', httpStatus: 422 });
    expect((error as Error).cause).toBeInstanceOf(Stripe.errors.StripeSignatureVerificationError);
  });

  it('rejects a stale timestamp (replay protection, 5 min tolerance)', () => {
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });

    const error = catchError(() =>
      createService().constructWebhookEvent(Buffer.from(payload), header),
    );

    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('rejects a re-serialized body (signature covers the exact bytes)', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const reserialized = JSON.stringify(JSON.parse(payload), null, 2);

    const error = catchError(() =>
      createService().constructWebhookEvent(Buffer.from(reserialized), header),
    );

    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('rejects a missing signature header', () => {
    const error = catchError(() =>
      createService().constructWebhookEvent(Buffer.from(payload), undefined),
    );

    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('rejects a correctly signed body that is not JSON', () => {
    const garbage = 'not-json';
    const header = Stripe.webhooks.generateTestHeaderString({
      payload: garbage,
      secret: WEBHOOK_SECRET,
    });

    const error = catchError(() =>
      createService().constructWebhookEvent(Buffer.from(garbage), header),
    );

    expect(error).toMatchObject({ code: 'INVALID_WEBHOOK_PAYLOAD' });
  });
});

describe('StripeService.createCheckoutSession', () => {
  const input = {
    customerEmail: 'jane@example.com',
    priceId: 'price_123',
    quantity: 2,
    successUrl: 'https://app.test/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://app.test/cancel',
    clientReferenceId: 'pay_1',
    metadata: { paymentId: 'pay_1', userId: 'user_1' },
  };

  it('creates a one-off payment session with the idempotency key as a request option', async () => {
    const service = createService();
    const create = vi
      .spyOn(service.client.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' } as never);

    const session = await service.createCheckoutSession(input, 'checkout-pay_1');

    expect(session.id).toBe('cs_1');
    expect(create).toHaveBeenCalledWith(
      {
        mode: 'payment',
        customer_email: 'jane@example.com',
        client_reference_id: 'pay_1',
        line_items: [{ price: 'price_123', quantity: 2 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: input.metadata,
        payment_intent_data: { metadata: input.metadata },
      },
      { idempotencyKey: 'checkout-pay_1' },
    );
  });

  it('passes no request options without an idempotency key', async () => {
    const service = createService();
    const create = vi
      .spyOn(service.client.checkout.sessions, 'create')
      .mockResolvedValue({ id: 'cs_2' } as never);

    await service.createCheckoutSession(input);

    expect(create.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('maps SDK errors to DomainExceptions', async () => {
    const service = createService();
    vi.spyOn(service.client.checkout.sessions, 'create').mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        message: "No such price: 'price_123'",
        param: 'line_items[0][price]',
        code: 'resource_missing',
        type: 'invalid_request_error',
      }),
    );

    await expect(service.createCheckoutSession(input)).rejects.toMatchObject({
      code: 'PAYMENT_REQUEST_INVALID',
      httpStatus: 422,
      message: "No such price: 'price_123'",
    });
  });

  it('hides upstream failures behind ExternalServiceException', async () => {
    const service = createService();
    vi.spyOn(service.client.checkout.sessions, 'create').mockRejectedValue(
      new Stripe.errors.StripeConnectionError({ message: 'socket hang up', type: 'api_error' }),
    );

    const promise = service.createCheckoutSession(input);

    await expect(promise).rejects.toBeInstanceOf(ExternalServiceException);
    await expect(promise).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
  });

  it('rethrows non-Stripe errors unchanged', async () => {
    const service = createService();
    const boom = new TypeError('boom');
    vi.spyOn(service.client.checkout.sessions, 'create').mockRejectedValue(boom);

    await expect(service.createCheckoutSession(input)).rejects.toBe(boom);
  });
});

describe('StripeService.retrieveCheckoutSession and the pinned API version', () => {
  it('retrieves a session by id and translates SDK errors', async () => {
    const service = createService();
    const retrieve = vi
      .spyOn(service.client.checkout.sessions, 'retrieve')
      .mockResolvedValueOnce({ id: 'cs_1', status: 'open' } as never)
      .mockRejectedValueOnce(
        Stripe.errors.StripeError.generate({ statusCode: 500, message: 'down', type: 'api_error' }),
      );
    await expect(service.retrieveCheckoutSession('cs_1')).resolves.toMatchObject({ id: 'cs_1' });
    expect(retrieve).toHaveBeenCalledWith('cs_1');
    await expect(service.retrieveCheckoutSession('cs_1')).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_ERROR',
    });
  });

  it('retrievePaymentIntent: one GET by id; a missing PaymentIntent (404) is null', async () => {
    const service = createService();
    const retrieve = vi
      .spyOn(service.client.paymentIntents, 'retrieve')
      .mockResolvedValueOnce({ id: 'pi_1', object: 'payment_intent', metadata: {} } as never)
      .mockRejectedValueOnce(
        Stripe.errors.StripeError.generate({
          statusCode: 404,
          message: "No such payment_intent: 'pi_gone'",
          type: 'invalid_request_error',
          code: 'resource_missing',
        }),
      );

    await expect(service.retrievePaymentIntent('pi_1')).resolves.toMatchObject({ id: 'pi_1' });
    expect(retrieve).toHaveBeenNthCalledWith(1, 'pi_1');
    await expect(service.retrievePaymentIntent('pi_gone')).resolves.toBeNull();
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it('retrievePaymentIntent: other failures are translated and thrown (the webhook is retried)', async () => {
    const service = createService();
    vi.spyOn(service.client.paymentIntents, 'retrieve')
      .mockRejectedValueOnce(
        Stripe.errors.StripeError.generate({ statusCode: 500, message: 'down', type: 'api_error' }),
      )
      .mockRejectedValueOnce(
        new Stripe.errors.StripeRateLimitError({ message: 'slow down', type: 'rate_limit_error' }),
      )
      .mockRejectedValueOnce(
        Stripe.errors.StripeError.generate({
          statusCode: 400,
          message: 'Invalid id',
          type: 'invalid_request_error',
        }),
      );

    await expect(service.retrievePaymentIntent('pi_1')).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_ERROR',
    });
    await expect(service.retrievePaymentIntent('pi_1')).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_RATE_LIMITED',
    });
    await expect(service.retrievePaymentIntent('pi_1')).rejects.toMatchObject({
      code: 'PAYMENT_REQUEST_INVALID',
    });
  });

  it('pins the API version the SDK was built for', () => {
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
  });
});

describe('StripeService.ledgerSource (L-12: the balance transactions of a money object)', () => {
  const bt = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    object: 'balance_transaction',
    amount: 2_500,
    fee: 103,
    net: 2_397,
    currency: 'usd',
    created: 1_794_182_400,
    reporting_category: 'charge',
    source: 'ch_1',
    status: 'pending',
    type: 'charge',
    ...overrides,
  });
  /** What the poster keeps of a balance transaction (`PostingBalanceTransaction`). */
  const posting = (id: string, overrides: Record<string, unknown> = {}) => {
    const {
      id: _id,
      amount,
      fee,
      currency,
      created,
      reporting_category,
      source,
    } = bt(id, overrides);
    return { id, amount, fee, currency, created, reporting_category, source };
  };

  it("a charge: its expanded balance transaction and the charge's presentment", async () => {
    const service = createService();
    const retrieve = vi.spyOn(service.client.charges, 'retrieve').mockResolvedValue({
      id: 'ch_1',
      object: 'charge',
      amount: 2_600,
      currency: 'EUR',
      balance_transaction: bt('txn_1'),
    } as never);

    await expect(service.ledgerSource('charge', 'ch_1')).resolves.toEqual({
      transactions: [posting('txn_1')],
      pending: false,
      presentment: { amount: 2_600n, currency: 'eur' },
    });
    expect(retrieve).toHaveBeenCalledWith('ch_1', { expand: ['balance_transaction'] });
  });

  it('a charge Stripe has no balance transaction for yet is pending', async () => {
    const service = createService();
    vi.spyOn(service.client.charges, 'retrieve').mockResolvedValue({
      id: 'ch_1',
      object: 'charge',
      amount: 2_500,
      currency: 'usd',
      balance_transaction: null,
    } as never);

    await expect(service.ledgerSource('charge', 'ch_1')).resolves.toEqual({
      transactions: [],
      pending: true,
      presentment: { amount: 2_500n, currency: 'usd' },
    });
  });

  it('a refund: its balance transaction and, after refund.failed, the failure one', async () => {
    const service = createService();
    const retrieve = vi
      .spyOn(service.client.refunds, 'retrieve')
      .mockResolvedValueOnce({
        id: 're_1',
        object: 'refund',
        amount: 1_000,
        currency: 'usd',
        balance_transaction: bt('txn_r', { amount: -1_000, fee: 0, reporting_category: 'refund' }),
        failure_balance_transaction: null,
      } as never)
      .mockResolvedValueOnce({
        id: 're_1',
        object: 'refund',
        amount: 1_000,
        currency: 'usd',
        balance_transaction: bt('txn_r', { amount: -1_000, fee: 0, reporting_category: 'refund' }),
        failure_balance_transaction: bt('txn_rf', {
          amount: 1_000,
          fee: 0,
          reporting_category: 'refund_failure',
        }),
      } as never);

    await expect(service.ledgerSource('refund', 're_1')).resolves.toEqual({
      transactions: [posting('txn_r', { amount: -1_000, fee: 0, reporting_category: 'refund' })],
      pending: false,
      presentment: { amount: 1_000n, currency: 'usd' },
    });
    await expect(service.ledgerSource('refund', 're_1')).resolves.toMatchObject({
      transactions: [
        { id: 'txn_r', reporting_category: 'refund' },
        { id: 'txn_rf', reporting_category: 'refund_failure' },
      ],
      pending: false,
    });
    expect(retrieve).toHaveBeenCalledWith('re_1', {
      expand: ['balance_transaction', 'failure_balance_transaction'],
    });
  });

  it('a dispute: every entry of balance_transactions; none yet is pending', async () => {
    const service = createService();
    const retrieve = vi
      .spyOn(service.client.disputes, 'retrieve')
      .mockResolvedValueOnce({
        id: 'du_1',
        object: 'dispute',
        amount: 2_500,
        currency: 'usd',
        balance_transactions: [
          bt('txn_d1', { amount: -2_500, fee: 1_500, reporting_category: 'dispute' }),
          bt('txn_d2', { amount: 2_500, fee: -1_500, reporting_category: 'dispute_reversal' }),
        ],
      } as never)
      .mockResolvedValueOnce({
        id: 'du_2',
        object: 'dispute',
        amount: 2_500,
        currency: 'usd',
        balance_transactions: [],
      } as never);

    await expect(service.ledgerSource('dispute', 'du_1')).resolves.toEqual({
      transactions: [
        posting('txn_d1', { amount: -2_500, fee: 1_500, reporting_category: 'dispute' }),
        posting('txn_d2', { amount: 2_500, fee: -1_500, reporting_category: 'dispute_reversal' }),
      ],
      pending: false,
      presentment: { amount: 2_500n, currency: 'usd' },
    });
    await expect(service.ledgerSource('dispute', 'du_2')).resolves.toMatchObject({
      transactions: [],
      pending: true,
    });
    expect(retrieve).toHaveBeenCalledWith('du_1');
  });

  it('a payout: its balance transaction (and the failure one once it failed), no presentment', async () => {
    const service = createService();
    const retrieve = vi.spyOn(service.client.payouts, 'retrieve').mockResolvedValue({
      id: 'po_1',
      object: 'payout',
      amount: 10_000,
      currency: 'usd',
      balance_transaction: bt('txn_po', { amount: -10_000, fee: 0, reporting_category: 'payout' }),
      failure_balance_transaction: bt('txn_pf', {
        amount: 10_000,
        fee: 0,
        reporting_category: 'payout_reversal',
      }),
    } as never);

    await expect(service.ledgerSource('payout', 'po_1')).resolves.toEqual({
      transactions: [
        posting('txn_po', { amount: -10_000, fee: 0, reporting_category: 'payout' }),
        posting('txn_pf', { amount: 10_000, fee: 0, reporting_category: 'payout_reversal' }),
      ],
      pending: false,
      presentment: null,
    });
    expect(retrieve).toHaveBeenCalledWith('po_1', {
      expand: ['balance_transaction', 'failure_balance_transaction'],
    });
  });

  it("a balance transaction (R4): itself, with its expanded source's presentment", async () => {
    const service = createService();
    const source = { id: 'ch_1', object: 'charge', amount: 2_600, currency: 'eur' };
    const retrieve = vi
      .spyOn(service.client.balanceTransactions, 'retrieve')
      .mockResolvedValue(bt('txn_1', { source }) as never);

    await expect(service.ledgerSource('balance_transaction', 'txn_1')).resolves.toEqual({
      transactions: [posting('txn_1', { source })],
      pending: false,
      presentment: { amount: 2_600n, currency: 'eur' },
    });
    expect(retrieve).toHaveBeenCalledWith('txn_1', { expand: ['source'] });
  });

  it('a balance transaction id that is not expanded is fetched with one more GET', async () => {
    const service = createService();
    vi.spyOn(service.client.charges, 'retrieve').mockResolvedValue({
      id: 'ch_1',
      object: 'charge',
      amount: 2_500,
      currency: 'usd',
      balance_transaction: 'txn_1',
    } as never);
    const retrieve = vi
      .spyOn(service.client.balanceTransactions, 'retrieve')
      .mockResolvedValue(bt('txn_1') as never);

    await expect(service.ledgerSource('charge', 'ch_1')).resolves.toMatchObject({
      transactions: [posting('txn_1')],
      pending: false,
    });
    expect(retrieve).toHaveBeenCalledWith('txn_1');
  });

  it('a missing object (404) is thrown as PAYMENT_REQUEST_INVALID; 5xx and 429 are translated', async () => {
    const service = createService();
    vi.spyOn(service.client.charges, 'retrieve')
      .mockRejectedValueOnce(
        Stripe.errors.StripeError.generate({
          statusCode: 404,
          message: "No such charge: 'ch_gone'",
          type: 'invalid_request_error',
          code: 'resource_missing',
        }),
      )
      .mockRejectedValueOnce(
        Stripe.errors.StripeError.generate({ statusCode: 500, message: 'down', type: 'api_error' }),
      )
      .mockRejectedValueOnce(
        new Stripe.errors.StripeRateLimitError({ message: 'slow down', type: 'rate_limit_error' }),
      );

    await expect(service.ledgerSource('charge', 'ch_gone')).rejects.toMatchObject({
      code: 'PAYMENT_REQUEST_INVALID',
      httpStatus: 422,
    });
    await expect(service.ledgerSource('charge', 'ch_1')).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_ERROR',
    });
    await expect(service.ledgerSource('charge', 'ch_1')).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_RATE_LIMITED',
    });
  });
});

describe('StripeService.listBalanceTransactions (R4: the balance transactions of a window)', () => {
  // Milliseconds inside a second: Stripe's `created` is whole seconds.
  const FROM = new Date('2026-11-16T11:45:00.400Z');
  const TO = new Date('2026-11-19T11:45:00.600Z');
  const txn = (id: string) => ({
    id,
    object: 'balance_transaction',
    amount: 2_500,
    fee: 103,
    net: 2_397,
    currency: 'usd',
    created: 1_794_000_000,
    reporting_category: 'charge',
    source: { id: `ch_${id}`, object: 'charge', metadata: {} },
    status: 'available',
    type: 'charge',
  });
  const page = (ids: readonly string[], hasMore: boolean) => ({
    object: 'list',
    url: '/v1/balance_transactions',
    has_more: hasMore,
    data: ids.map(txn),
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_unit' },
    });

  /** A service whose real SDK client talks to `answers` (one per request) instead of Stripe. */
  function serviceOver(answers: Response[]): { service: StripeService; requests: URL[] } {
    const requests: URL[] = [];
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      requests.push(new URL(input instanceof Request ? input.url : String(input)));
      return answers.shift() ?? json(500, { error: { type: 'api_error', message: 'no answer' } });
    };
    const client = new Stripe(cfg.secretKey, {
      apiVersion: STRIPE_API_VERSION,
      httpClient: Stripe.createFetchHttpClient(fetchFn),
      maxNetworkRetries: 0,
      telemetry: false,
    });
    return { service: new StripeService(client, cfg), requests };
  }

  const collect = async (service: StripeService) => {
    const ids: string[] = [];
    for await (const row of service.listBalanceTransactions({ from: FROM, to: TO })) {
      ids.push(row.id);
    }
    return ids;
  };

  it('reads every page, created in [from, to) in whole seconds, with the source expanded', async () => {
    const { service, requests } = serviceOver([
      json(200, page(['txn_1', 'txn_2'], true)),
      json(200, page(['txn_3'], true)),
      json(200, page(['txn_4'], false)),
    ]);

    await expect(collect(service)).resolves.toEqual(['txn_1', 'txn_2', 'txn_3', 'txn_4']);

    expect(requests).toHaveLength(3);
    for (const url of requests) {
      expect(url.pathname).toBe('/v1/balance_transactions');
      expect(url.searchParams.get('created[gte]')).toBe(String(Math.ceil(FROM.getTime() / 1000)));
      expect(url.searchParams.get('created[lt]')).toBe(String(Math.ceil(TO.getTime() / 1000)));
      expect(url.searchParams.getAll('expand[0]')).toEqual(['data.source']);
      expect(url.searchParams.get('limit')).toBe('100');
    }
    expect(requests.map((url) => url.searchParams.get('starting_after'))).toEqual([
      null,
      'txn_2',
      'txn_3',
    ]);
  });

  it('a whole-second window maps exactly: gte = from, lt = to', async () => {
    const { service, requests } = serviceOver([json(200, page([], false))]);

    for await (const _ of service.listBalanceTransactions({
      from: new Date(1_794_000_000_000),
      to: new Date(1_794_003_600_000),
    })) {
      expect.fail('no row expected');
    }

    expect(requests[0]?.searchParams.get('created[gte]')).toBe('1794000000');
    expect(requests[0]?.searchParams.get('created[lt]')).toBe('1794003600');
  });

  it('a failing page is translated and thrown after the rows already read', async () => {
    const { service } = serviceOver([
      json(200, page(['txn_1'], true)),
      json(500, { error: { type: 'api_error', message: 'down' } }),
    ]);
    const seen: string[] = [];

    const failure = await (async () => {
      for await (const row of service.listBalanceTransactions({ from: FROM, to: TO })) {
        seen.push(row.id);
      }
    })().catch((error: unknown) => error);

    expect(seen).toEqual(['txn_1']);
    expect(failure).toBeInstanceOf(ExternalServiceException);
    expect(failure).toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
  });

  it('a rate-limited listing is PAYMENT_PROVIDER_RATE_LIMITED', async () => {
    const { service } = serviceOver([
      json(429, { error: { type: 'rate_limit_error', message: 'slow down' } }),
    ]);

    await expect(collect(service)).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_RATE_LIMITED',
    });
  });
});

describe('StripeService.livemode (the mode of the configured key)', () => {
  const serviceWith = (key: string) => {
    const keyed = stripeConfig.parse({
      STRIPE_SECRET_KEY: key,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    return new StripeService(createStripeClient(keyed), keyed);
  };

  it('is true for live secret and restricted keys only', () => {
    expect(serviceWith('sk_test_unit').livemode).toBe(false);
    expect(serviceWith('rk_test_unit').livemode).toBe(false);
    expect(serviceWith('sk_live_unit').livemode).toBe(true);
    expect(serviceWith('rk_live_unit').livemode).toBe(true);
  });
});
