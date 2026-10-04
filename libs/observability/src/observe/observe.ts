import { isSafeRequestId } from '@app/common';
import { type EnvSource, type ObservabilityConfig, observabilityConfig } from '@app/config';
import type { NestApplicationOptions } from '@nestjs/common';
import { createObserveModule, defaultTraceIdGenerator, type ObserveOptions } from '@nestjs/observe';
import { get, isObjectLike, isString } from 'lodash-es';
import { ClsService } from 'nestjs-cls';
import { Logger, PinoLogger } from 'nestjs-pino';
import { Counter, Gauge, Histogram, Summary } from 'prom-client';

/** What `NestFactory.create(..., { instrument })` accepts. */
export type ObserveInstrumentation = NonNullable<NestApplicationOptions['instrument']>;

/** Probes and scrapes are not worth a trace (they'd dominate the trace list). */
const UNTRACED_HTTP_PATHS: (string | RegExp)[] = [/^\/health(?:\/|$)/, '/metrics'];

/**
 * Observe's trace id = our request id: Fastify's `request.id` when valid (it already went through
 * `resolveRequestId`), else Observe's default (valid `x-request-id` header / RPC metadata, else a
 * UUIDv7). So one id finds the request in logs, Observe and downstream services.
 */
export function observeTraceIdGenerator(request: unknown): string {
  const id: unknown = isObjectLike(request) ? get(request, 'id') : undefined;
  return isSafeRequestId(id) ? id : defaultTraceIdGenerator(request);
}

/**
 * Providers whose calls must not become spans: the logging, CLS and metrics plumbing is called on
 * every request (a span per log line would drown the traces and cost more than the work itself).
 */
function skipInstrumentation(instance: unknown): boolean {
  return (
    instance instanceof PinoLogger ||
    instance instanceof Logger ||
    instance instanceof ClsService ||
    instance instanceof Histogram ||
    instance instanceof Counter ||
    instance instanceof Gauge ||
    instance instanceof Summary
  );
}

/**
 * The `@nestjs/observe` pair. Created once per process at import time (cheap: an
 * AsyncLocalStorage and a registry; nothing is patched until the module is instantiated).
 * `sourceContext: false`: Observe would otherwise upload application source fragments around every
 * error frame to a third party — opt in deliberately if that's acceptable. `attachTraceIdToLogs:
 * false`: it patches Nest's ConsoleLogger, which we don't use (pino lines carry `requestId`).
 */
export const { ObserveModule, ObserveInstrument } = createObserveModule({
  traceIdGenerator: observeTraceIdGenerator,
  attachTraceIdToLogs: false,
  sourceContext: false,
  skipInstrumentation,
});

/** Whether `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` are both configured. */
export function isObserveEnabled(env?: EnvSource): boolean {
  return observabilityConfig.parse(env).observe.enabled;
}

/**
 * The provider-level instrumentation for `NestFactory.create(..., { instrument })`, or `undefined`
 * when Observe isn't configured (then no provider is proxied at all — zero overhead). Evaluated
 * before Nest boots, hence the direct env parse instead of DI.
 */
export function observeInstrument(env?: EnvSource): ObserveInstrumentation | undefined {
  return isObserveEnabled(env) ? ObserveInstrument : undefined;
}

/** `ObserveModule.forRootAsync` options from the `observability` config namespace. */
export function buildObserveOptions(observability: ObservabilityConfig): ObserveOptions {
  const { appKey, appSecret, serviceId } = observability.observe;
  if (appKey === undefined || appSecret === undefined) {
    throw new Error('@nestjs/observe needs both OBSERVE_APP_KEY and OBSERVE_APP_SECRET');
  }
  return {
    appKey,
    appSecret,
    serviceId,
    // Logs already go to stdout → Loki; shipping them twice doubles cost and PII exposure.
    forwardLogs: false,
    http: {
      ignore: UNTRACED_HTTP_PATHS,
      getUserId: (request: unknown): string => {
        const userId: unknown = get(request, ['user', 'id']);
        return isString(userId) ? userId : 'anonymous';
      },
    },
  };
}
