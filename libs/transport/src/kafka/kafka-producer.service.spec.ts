import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { ExternalServiceException, generateId, isUuidV7 } from '@platform/common';
import { CLS_ID, CLS_REQ, ClsService } from 'nestjs-cls';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_PAYMENT_SUCCEEDED_EVENT,
  FIXTURE_USER_REGISTERED_EVENT,
  type FixtureUserRegisteredPayload,
} from '../../test/fixtures/fixture.events.js';
import { RPC_CLS_KEYS } from '../context/transport-context.js';
import { KAFKA_ERROR_CODES } from './kafka.constants.js';
import { InvalidEventException } from './kafka.errors.js';
import {
  type KafkaEventEmitter,
  type KafkaOutgoingRecord,
  KafkaProducer,
} from './kafka-producer.service.js';
import { FakeKafkaProducer } from './testing/fake-kafka-producer.js';

/** Stand-in for `ClientKafka`: records emits and answers with a configurable observable. */
class FakeClientKafka implements KafkaEventEmitter {
  readonly emitted: { topic: string; record: KafkaOutgoingRecord }[] = [];
  reply: () => Observable<unknown> = () => of([{ topicName: 't', partition: 0, errorCode: 0 }]);
  readonly connect = vi.fn(() => Promise.resolve());

  emit(topic: string, record: KafkaOutgoingRecord): Observable<unknown> {
    this.emitted.push({ topic, record });
    return this.reply();
  }
}

const userRegistered = (): FixtureUserRegisteredPayload => ({
  userId: generateId(),
  email: 'ada@example.com',
  displayName: 'Ada',
  registeredAt: new Date('2026-09-01T10:00:00.000Z').toISOString(),
});

const newCls = (): ClsService => new ClsService(new AsyncLocalStorage());

describe('KafkaProducer', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('emits a validated envelope with key and headers', async () => {
    const client = new FakeClientKafka();
    const producer = new KafkaProducer(client, { source: 'fixture-service' });
    const payload = userRegistered();

    const envelope = await producer.publish(FIXTURE_USER_REGISTERED_EVENT, payload, {
      key: payload.userId,
      correlationId: 'corr-1',
    });

    expect(client.emitted).toHaveLength(1);
    const [{ topic, record } = { topic: '', record: undefined }] = client.emitted;
    expect(topic).toBe('fixture.user-registered.v1');
    expect(record).toEqual({
      key: payload.userId,
      value: envelope,
      headers: { 'x-event-type': 'fixture.user-registered.v1', 'x-correlation-id': 'corr-1' },
    });
    expect(envelope).toMatchObject({
      type: 'fixture.user-registered.v1',
      version: 1,
      source: 'fixture-service',
      correlationId: 'corr-1',
      payload,
    });
    expect(isUuidV7(envelope.id)).toBe(true);
    expect(Number.isNaN(Date.parse(envelope.occurredAt))).toBe(false);
  });

  it('honours explicit event id and occurredAt, and sends a null key by default', async () => {
    const client = new FakeClientKafka();
    const producer = new KafkaProducer(client, { source: 'svc' });
    const eventId = generateId();
    const envelope = await producer.publish(FIXTURE_USER_REGISTERED_EVENT, userRegistered(), {
      eventId,
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    expect(envelope.id).toBe(eventId);
    expect(envelope.occurredAt).toBe('2026-09-02T00:00:00.000Z');
    expect(client.emitted[0]?.record.key).toBeNull();
    expect(client.emitted[0]?.record.headers).toEqual({
      'x-event-type': 'fixture.user-registered.v1',
    });
  });

  it('rejects an invalid payload before anything is sent', async () => {
    const client = new FakeClientKafka();
    const producer = new KafkaProducer(client, { source: 'svc' });
    const invalid = { ...userRegistered(), email: 'not-an-email' };

    const error: unknown = await producer
      .publish(FIXTURE_USER_REGISTERED_EVENT, invalid)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidEventException);
    expect(error).toMatchObject({
      code: KAFKA_ERROR_CODES.INVALID_EVENT,
      httpStatus: 422,
      details: { topic: 'fixture.user-registered.v1' },
    });
    expect((error as InvalidEventException).issues).toEqual([
      expect.objectContaining({ path: 'payload.email' }),
    ]);
    expect(client.emitted).toHaveLength(0);
  });

  it('wraps broker failures in ExternalServiceException', async () => {
    const client = new FakeClientKafka();
    client.reply = () => throwError(() => new Error('KafkaJSNumberOfRetriesExceeded'));
    const producer = new KafkaProducer(client, { source: 'svc' });

    const error: unknown = await producer
      .publish(FIXTURE_USER_REGISTERED_EVENT, userRegistered())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceException);
    expect(error).toMatchObject({
      code: KAFKA_ERROR_CODES.PUBLISH_FAILED,
      details: { topic: 'fixture.user-registered.v1', eventId: expect.any(String) as string },
    });
  });

  it('resolves only once the broker acknowledged the record', async () => {
    const client = new FakeClientKafka();
    const ack = new Subject<unknown>();
    client.reply = () => ack;
    const producer = new KafkaProducer(client, { source: 'svc' });
    let settled = false;
    const publishing = producer
      .publish(FIXTURE_USER_REGISTERED_EVENT, userRegistered())
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    ack.next([]);
    ack.complete();
    await publishing;
    expect(settled).toBe(true);
  });

  describe('correlation id from nestjs-cls', () => {
    it('uses the correlation id adopted by an RPC interceptor', async () => {
      const cls = newCls();
      const client = new FakeClientKafka();
      const producer = new KafkaProducer(client, { source: 'svc' }, cls);
      const envelope = await cls.run(async () => {
        cls.set(CLS_ID, 'req-1');
        cls.set(RPC_CLS_KEYS.CORRELATION_ID, 'corr-rpc');
        return producer.publish(FIXTURE_USER_REGISTERED_EVENT, userRegistered());
      });
      expect(envelope.correlationId).toBe('corr-rpc');
      expect(client.emitted[0]?.record.headers['x-correlation-id']).toBe('corr-rpc');
    });

    it('falls back to the HTTP x-correlation-id header, then to the request id', async () => {
      const cls = newCls();
      const producer = new KafkaProducer(new FakeClientKafka(), { source: 'svc' }, cls);
      const fromHeader = await cls.run(async () => {
        cls.set(CLS_ID, 'req-2');
        cls.set(CLS_REQ, { headers: { 'x-correlation-id': 'corr-http' } });
        return producer.publish(FIXTURE_USER_REGISTERED_EVENT, userRegistered());
      });
      expect(fromHeader.correlationId).toBe('corr-http');

      const fromRequestId = await cls.run(async () => {
        cls.set(CLS_ID, 'req-3');
        return producer.publish(FIXTURE_USER_REGISTERED_EVENT, userRegistered());
      });
      expect(fromRequestId.correlationId).toBe('req-3');
    });

    it('omits the correlation id outside a CLS context', async () => {
      const producer = new KafkaProducer(new FakeClientKafka(), { source: 'svc' }, newCls());
      const envelope = await producer.publish(FIXTURE_USER_REGISTERED_EVENT, userRegistered());
      expect(envelope).not.toHaveProperty('correlationId');
    });
  });

  it('retries the connect and resolves false (never rejects) when the broker stays down', async () => {
    const client = new FakeClientKafka();
    client.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const producer = new KafkaProducer(client, {
      source: 'svc',
      connectRetry: { retries: 2, minDelayMs: 1, maxDelayMs: 2 },
    });
    await expect(producer.connect()).resolves.toBe(false);
    expect(client.connect).toHaveBeenCalledTimes(3);
  });

  it('connects in the background at bootstrap', async () => {
    const client = new FakeClientKafka();
    const producer = new KafkaProducer(client, { source: 'svc' });
    expect(() => producer.onApplicationBootstrap()).not.toThrow();
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));
    await expect(producer.connect()).resolves.toBe(true);
  });

  it('does not connect at bootstrap when eagerConnect is false', () => {
    const client = new FakeClientKafka();
    new KafkaProducer(client, { source: 'svc', eagerConnect: false }).onApplicationBootstrap();
    expect(client.connect).not.toHaveBeenCalled();
  });
});

describe('FakeKafkaProducer', () => {
  it('records validated envelopes per topic', async () => {
    const fake = new FakeKafkaProducer({ source: 'test-svc' });
    const payload = userRegistered();
    await fake.publish(FIXTURE_USER_REGISTERED_EVENT, payload, { key: payload.userId });

    expect(fake.records).toHaveLength(1);
    expect(fake.published(FIXTURE_USER_REGISTERED_EVENT)[0]).toMatchObject({
      topic: FIXTURE_USER_REGISTERED_EVENT.topic,
      key: payload.userId,
    });
    expect(fake.envelopes(FIXTURE_USER_REGISTERED_EVENT)[0]).toMatchObject({
      source: 'test-svc',
      payload,
    });
    expect(fake.published(FIXTURE_PAYMENT_SUCCEEDED_EVENT)).toEqual([]);
  });

  it('still validates payloads, can simulate a broker failure, and clears', async () => {
    const fake = new FakeKafkaProducer();
    await expect(
      fake.publish(FIXTURE_USER_REGISTERED_EVENT, { ...userRegistered(), userId: 'x' }),
    ).rejects.toBeInstanceOf(InvalidEventException);

    fake.failNextWith(new Error('down'));
    await expect(
      fake.publish(FIXTURE_USER_REGISTERED_EVENT, userRegistered()),
    ).rejects.toBeInstanceOf(ExternalServiceException);
    await fake.publish(FIXTURE_USER_REGISTERED_EVENT, userRegistered());
    expect(fake.records).toHaveLength(1);
    fake.clear();
    expect(fake.records).toHaveLength(0);
  });

  it('is a KafkaProducer (drop-in for overrideProvider)', () => {
    expect(new FakeKafkaProducer()).toBeInstanceOf(KafkaProducer);
  });
});
