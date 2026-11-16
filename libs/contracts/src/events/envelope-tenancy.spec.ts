import { generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEventEnvelope, defineEventContract, parseEventEnvelope } from './event-contract.js';

const payload = z.object({ orderId: z.uuid() });
const ORDER_PLACED = defineEventContract('orders.order-placed.v1', payload, { tenantScoped: true });
const CATALOG_SYNCED = defineEventContract('catalog.catalog-synced.v1', payload);
const meta = { id: generateId(), source: 'orders-service' };
const body = { orderId: generateId() };

describe('envelope tenancy', () => {
  it('records whether a contract is tenant-scoped (default false)', () => {
    expect(ORDER_PLACED.tenantScoped).toBe(true);
    expect(CATALOG_SYNCED.tenantScoped).toBe(false);
  });

  it('carries tenantId and actorId', () => {
    const tenantId = generateId();
    const actorId = generateId();
    expect(createEventEnvelope(ORDER_PLACED, body, { ...meta, tenantId, actorId })).toMatchObject({
      tenantId,
      actorId,
    });
  });

  it('refuses to produce a tenant-scoped event without a tenant', () => {
    expect(() => createEventEnvelope(ORDER_PLACED, body, meta)).toThrow(z.ZodError);
    expect(() => createEventEnvelope(CATALOG_SYNCED, body, meta)).not.toThrow();
  });

  it('accepts the platform tenant and a null actor (system work)', () => {
    expect(
      createEventEnvelope(ORDER_PLACED, body, {
        ...meta,
        tenantId: PLATFORM_TENANT_ID,
        actorId: null,
      }),
    ).toMatchObject({ tenantId: PLATFORM_TENANT_ID, actorId: null });
  });

  it('parses legacy envelopes without tenantId/actorId (in flight during a deploy)', () => {
    const legacy = {
      ...meta,
      type: ORDER_PLACED.topic,
      version: 1,
      occurredAt: new Date().toISOString(),
      payload: body,
    };
    expect(parseEventEnvelope(ORDER_PLACED, legacy)).not.toHaveProperty('tenantId');
  });

  it('rejects a tenantId that is not a UUID', () => {
    const bad = {
      ...meta,
      type: ORDER_PLACED.topic,
      version: 1,
      occurredAt: new Date().toISOString(),
      tenantId: 'acme',
      payload: body,
    };
    expect(() => parseEventEnvelope(ORDER_PLACED, bad)).toThrow(z.ZodError);
  });
});
