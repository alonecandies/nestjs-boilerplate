import { PLATFORM_TENANT_ID } from '@platform/common';
import type Stripe from 'stripe';
import { describe, expect, it, type Mock, vi } from 'vitest';
import type { StripeService } from '../../infrastructure/stripe/stripe.service.js';
import { StripeOwnerResolver } from './stripe-owner-resolver.js';

const TENANT = '0197c500-0000-7000-8000-0000000000a0';
const USER = '0197c500-0000-7000-8000-00000000a001';
const PAYMENT = '0197c500-0000-7000-8000-0000000000f1';

/** The metadata checkout signs into the session and its PaymentIntent (B2-26). */
const signed = { tenantId: TENANT, userId: USER, paymentId: PAYMENT };
const OWNER = { tenantId: TENANT, userId: USER, paymentId: PAYMENT, unresolved: false };
const UNRESOLVED = {
  tenantId: PLATFORM_TENANT_ID,
  userId: null,
  paymentId: null,
  unresolved: true,
};

/** A resolver over a Stripe fake whose PaymentIntents are `intents` (absent = 404 → null). */
function setup(intents: Record<string, Record<string, string>> = {}): {
  resolver: StripeOwnerResolver;
  retrieve: Mock<(id: string) => Promise<Stripe.PaymentIntent | null>>;
} {
  const retrieve = vi.fn(async (id: string) => {
    const metadata = intents[id];
    return metadata === undefined
      ? null
      : ({ id, object: 'payment_intent', metadata } as unknown as Stripe.PaymentIntent);
  });
  const stripe = { retrievePaymentIntent: retrieve } as unknown as StripeService;
  return { resolver: new StripeOwnerResolver(stripe), retrieve };
}

const charge = (overrides: Record<string, unknown> = {}) => ({
  id: 'ch_1',
  object: 'charge',
  metadata: {},
  payment_intent: 'pi_1',
  ...overrides,
});
const refund = (overrides: Record<string, unknown> = {}) => ({
  id: 're_1',
  object: 'refund',
  metadata: {},
  payment_intent: 'pi_1',
  ...overrides,
});
const dispute = (overrides: Record<string, unknown> = {}) => ({
  id: 'du_1',
  object: 'dispute',
  metadata: {},
  payment_intent: 'pi_1',
  ...overrides,
});

describe('StripeOwnerResolver', () => {
  it('a charge with signed metadata costs no Stripe call', async () => {
    const { resolver, retrieve } = setup({ pi_1: signed });
    await expect(resolver.resolve(charge({ metadata: signed }))).resolves.toEqual(OWNER);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ['a charge without metadata', charge()],
    ['a refund', refund()],
    ['a dispute', dispute()],
  ])('%s costs exactly one PaymentIntent GET', async (_label, object) => {
    const { resolver, retrieve } = setup({ pi_1: signed });
    await expect(resolver.resolve(object)).resolves.toEqual(OWNER);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith('pi_1');
  });

  it('reads an expanded PaymentIntent without a GET', async () => {
    const { resolver, retrieve } = setup();
    const expanded = { id: 'pi_1', object: 'payment_intent', metadata: signed };
    await expect(resolver.resolve(refund({ payment_intent: expanded }))).resolves.toEqual(OWNER);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('a missing PaymentIntent gives PLATFORM_OWNER, unresolved', async () => {
    const { resolver, retrieve } = setup();
    await expect(resolver.resolve(refund({ payment_intent: 'pi_gone' }))).resolves.toEqual(
      UNRESOLVED,
    );
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('an object without metadata or PaymentIntent gives PLATFORM_OWNER, unresolved, no GET', async () => {
    const { resolver, retrieve } = setup();
    await expect(resolver.resolve(dispute({ payment_intent: null }))).resolves.toEqual(UNRESOLVED);
    await expect(resolver.resolve(null)).resolves.toEqual(UNRESOLVED);
    await expect(resolver.resolve('ch_1')).resolves.toEqual(UNRESOLVED);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-UUID tenant id', { ...signed, tenantId: 'tenant-a' }],
    ['the nil tenant', { ...signed, tenantId: PLATFORM_TENANT_ID }],
    ['no tenant', { userId: USER, paymentId: PAYMENT }],
  ])('%s in the metadata gives PLATFORM_OWNER, unresolved', async (_label, metadata) => {
    const { resolver, retrieve } = setup({ pi_1: metadata });
    await expect(resolver.resolve(refund())).resolves.toEqual(UNRESOLVED);
    // On the object itself it falls back to the PaymentIntent, which says the same.
    await expect(resolver.resolve(charge({ metadata }))).resolves.toEqual(UNRESOLVED);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it("falls back to the PaymentIntent when the object's own metadata names no tenant", async () => {
    const { resolver, retrieve } = setup({ pi_1: signed });
    await expect(
      resolver.resolve(charge({ metadata: { ...signed, tenantId: PLATFORM_TENANT_ID } })),
    ).resolves.toEqual(OWNER);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('a non-UUID payment id is dropped (null), the owner stays resolved', async () => {
    const { resolver } = setup();
    await expect(
      resolver.resolve(charge({ metadata: { ...signed, paymentId: 'pay_1' } })),
    ).resolves.toEqual({ ...OWNER, paymentId: null });
  });

  it('a tenant without a user is resolved with a null user (the caller takes the system path)', async () => {
    const { resolver } = setup();
    await expect(
      resolver.resolve(charge({ metadata: { tenantId: TENANT, paymentId: PAYMENT } })),
    ).resolves.toEqual({ ...OWNER, userId: null });
  });

  it('a Stripe failure other than a missing PaymentIntent propagates', async () => {
    const { resolver, retrieve } = setup();
    retrieve.mockRejectedValueOnce(new Error('Stripe is down'));
    await expect(resolver.resolve(refund())).rejects.toThrow('Stripe is down');
  });
});
