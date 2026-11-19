import { LEDGER_POSTING_REQUESTED_EVENT } from '@domain/billing-contracts';
import { PLATFORM_TENANT_ID } from '@platform/common';
import { parseEventEnvelope } from '@platform/contracts';
import { InMemoryOutbox } from '@platform/outbox/testing';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { describe, expect, it } from 'vitest';
import { PLATFORM_OWNER } from '../../domain/stripe-owner.js';
import { BILLING_OUTBOX } from '../../infrastructure/persistence/billing-outbox.js';
import {
  ledgerPostingEnvelopeId,
  ledgerPostingRecord,
  ledgerPostingRequest,
} from './ledger-posting-request.js';

const TENANT = '0197c500-0000-7000-8000-0000000000a0';
const USER = '0197c500-0000-7000-8000-00000000a001';
const PAYMENT = '0197c500-0000-7000-8000-0000000000f1';
const CREATED = 1_790_000_000;

const outbox = new InMemoryOutbox(BILLING_OUTBOX, {
  kafka: new FakeKafkaProducer({ source: 'billing-test' }),
});
const event = (id: string, type = 'charge.succeeded') => ({
  id,
  type,
  livemode: false,
  created: CREATED,
});
const owner = { tenantId: TENANT, userId: USER, paymentId: PAYMENT };
const platform = { ...PLATFORM_OWNER, paymentId: null };

describe('ledgerPostingEnvelopeId', () => {
  it('is uuidv5(LEDGER_NAMESPACE, <Stripe event id>) (pinned golden value)', () => {
    // Computed independently: node -e "require('uuid').v5('evt_ledger_golden', LEDGER_NAMESPACE)".
    expect(ledgerPostingEnvelopeId('evt_ledger_golden')).toBe(
      'a9d6a529-7cc2-59c6-a7e9-70c781bb898b',
    );
  });

  it('is deterministic per event and differs between events', () => {
    expect(ledgerPostingEnvelopeId('evt_1')).toBe(ledgerPostingEnvelopeId('evt_1'));
    expect(ledgerPostingEnvelopeId('evt_1')).not.toBe(ledgerPostingEnvelopeId('evt_2'));
  });
});

describe('ledgerPostingRequest / ledgerPostingRecord ("Envelope ids")', () => {
  it('a tenant posting: payload field for field, key = tenant, actor = user, id from the event', () => {
    const request = ledgerPostingRequest(event('evt_ch_1'), owner, 'charge', 'ch_1');
    expect(request.payload).toEqual({
      source: 'stripe',
      stripeEventId: 'evt_ch_1',
      stripeEventType: 'charge.succeeded',
      objectType: 'charge',
      objectId: 'ch_1',
      tenantId: TENANT,
      userId: USER,
      paymentId: PAYMENT,
      livemode: false,
    });
    expect(request.options).toEqual({
      eventId: ledgerPostingEnvelopeId('evt_ch_1'),
      key: TENANT,
      tenantId: TENANT,
      actorId: USER,
      occurredAt: new Date(CREATED * 1_000),
    });

    const record = ledgerPostingRecord(outbox, event('evt_ch_1'), owner, 'charge', 'ch_1');
    expect(record).toMatchObject({
      tenantId: TENANT,
      id: ledgerPostingEnvelopeId('evt_ch_1'),
      topic: LEDGER_POSTING_REQUESTED_EVENT.topic,
      key: TENANT,
    });
    expect(parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, record.envelope)).toMatchObject({
      id: record.id,
      type: 'billing.ledger-posting.v1',
      tenantId: TENANT,
      actorId: USER,
      occurredAt: new Date(CREATED * 1_000).toISOString(),
      payload: request.payload,
    });
  });

  it('a platform posting: tenant and key = the nil UUID, user and actor null, no payment', () => {
    const record = ledgerPostingRecord(
      outbox,
      { ...event('evt_po_1', 'payout.paid'), livemode: true },
      platform,
      'payout',
      'po_1',
    );
    expect(record).toMatchObject({
      tenantId: PLATFORM_TENANT_ID,
      id: ledgerPostingEnvelopeId('evt_po_1'),
      key: PLATFORM_TENANT_ID,
    });
    expect(parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, record.envelope)).toMatchObject({
      tenantId: PLATFORM_TENANT_ID,
      actorId: null,
      payload: {
        stripeEventType: 'payout.paid',
        objectType: 'payout',
        objectId: 'po_1',
        tenantId: PLATFORM_TENANT_ID,
        userId: null,
        paymentId: null,
        livemode: true,
      },
    });
  });

  it('the same event always yields the same record id, whoever builds it', () => {
    const other = new InMemoryOutbox(BILLING_OUTBOX);
    expect(ledgerPostingRecord(other, event('evt_same'), owner, 'refund', 're_1').id).toBe(
      ledgerPostingRecord(outbox, event('evt_same'), owner, 'refund', 're_1').id,
    );
  });
});
