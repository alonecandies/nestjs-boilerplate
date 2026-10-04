import { isUuidV7 } from '@app/common';
import { observabilityConfig } from '@app/config';
import { Registry, Summary } from 'prom-client';
import { describe, expect, it } from 'vitest';
import {
  buildObserveOptions,
  isObserveEnabled,
  ObserveInstrument,
  observeInstrument,
  observeTraceIdGenerator,
} from './observe.js';

const credentials = {
  OBSERVE_APP_KEY: 'key',
  OBSERVE_APP_SECRET: 'secret',
  SERVICE_NAME: 'orders',
};

describe('observeInstrument', () => {
  it('is undefined unless both credentials are configured (no provider gets proxied)', () => {
    expect(observeInstrument({})).toBeUndefined();
    expect(observeInstrument({ OBSERVE_APP_KEY: 'key' })).toBeUndefined();
    expect(isObserveEnabled({ OBSERVE_APP_SECRET: 'secret' })).toBe(false);
  });

  it('returns the shared ObserveInstrument when configured', () => {
    expect(isObserveEnabled(credentials)).toBe(true);
    expect(observeInstrument(credentials)).toBe(ObserveInstrument);
    expect(typeof ObserveInstrument?.instanceDecorator).toBe('function');
  });

  it('never instruments the metrics plumbing', () => {
    const summary = new Summary({ name: 'test_summary', help: 'x', registers: [new Registry()] });
    expect(ObserveInstrument?.instanceDecorator(summary)).toBe(summary);
  });
});

describe('observeTraceIdGenerator', () => {
  it('prefers the Fastify request id so traces and logs share one id', () => {
    expect(observeTraceIdGenerator({ id: 'req-1', headers: { 'x-request-id': 'other' } })).toBe(
      'req-1',
    );
  });

  it('falls back to a valid x-request-id header, then to a UUIDv7', () => {
    expect(observeTraceIdGenerator({ headers: { 'x-request-id': 'hdr-7' } })).toBe('hdr-7');
    expect(isUuidV7(observeTraceIdGenerator({ id: 'bad id', headers: {} }))).toBe(true);
    expect(isUuidV7(observeTraceIdGenerator(undefined))).toBe(true);
  });
});

describe('buildObserveOptions', () => {
  it('maps the observability namespace and keeps probes out of traces', () => {
    const options = buildObserveOptions(observabilityConfig.parse(credentials));
    expect(options).toMatchObject({
      appKey: 'key',
      appSecret: 'secret',
      serviceId: 'orders',
      forwardLogs: false,
    });
    const ignore = options.http?.ignore as (string | RegExp)[];
    const ignored = (path: string): boolean =>
      ignore.some((rule) => (typeof rule === 'string' ? rule === path : rule.test(path)));
    expect(ignored('/health/live')).toBe(true);
    expect(ignored('/metrics')).toBe(true);
    expect(ignored('/v1/healthy-food')).toBe(false);
  });

  it('attributes requests to the authenticated user', () => {
    const getUserId = buildObserveOptions(observabilityConfig.parse(credentials)).http?.getUserId;
    expect(getUserId?.({ user: { id: 'u-1' } })).toBe('u-1');
    expect(getUserId?.({})).toBe('anonymous');
  });

  it('fails fast without credentials', () => {
    expect(() => buildObserveOptions(observabilityConfig.parse({}))).toThrow(/OBSERVE_APP_KEY/);
  });
});
