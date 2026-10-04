import type { Logger } from '@nestjs/common';
import { Kafka, logLevel } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';
import { createKafkaLogCreator, isTransientKafkaLog } from './kafka-logger.js';

function capture(): { logger: Logger; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  const logger = {
    error: record('error'),
    warn: record('warn'),
    log: record('log'),
    debug: record('debug'),
  } as unknown as Logger;
  return { logger, calls };
}

function entry(level: logLevel, message: unknown, extra: Record<string, unknown> = {}) {
  return {
    namespace: 'Connection',
    level,
    label: logLevel[level] ?? 'UNKNOWN',
    log: { timestamp: '2026-01-01T00:00:00.000Z', logger: 'kafkajs', message, ...extra },
  } as Parameters<ReturnType<ReturnType<typeof createKafkaLogCreator>>>[0];
}

describe('createKafkaLogCreator', () => {
  it('maps kafkajs levels to Nest logger methods with namespace and extras', () => {
    const { logger, calls } = capture();
    const log = createKafkaLogCreator(logger)(logLevel.DEBUG);

    log(
      entry(logLevel.ERROR, 'Crash: KafkaJSNumberOfRetriesExceeded', { groupId: 'g', stack: 'S' }),
    );
    log(entry(logLevel.WARN, 'Something odd'));
    log(entry(logLevel.INFO, 'Consumer has joined the group', { groupId: 'g' }));
    log(entry(logLevel.DEBUG, 'Request Metadata'));

    expect(calls).toEqual([
      {
        method: 'error',
        args: ['[Connection] Crash: KafkaJSNumberOfRetriesExceeded {"groupId":"g"}', 'S'],
      },
      { method: 'warn', args: ['[Connection] Something odd'] },
      { method: 'log', args: ['[Connection] Consumer has joined the group {"groupId":"g"}'] },
      { method: 'debug', args: ['[Connection] Request Metadata'] },
    ]);
  });

  it('downgrades the ERROR lines of kafkajs retry and reconnect loops to WARN', () => {
    const { logger, calls } = capture();
    const log = createKafkaLogCreator(logger)(logLevel.WARN);

    log(entry(logLevel.ERROR, 'Connection error: connect ECONNREFUSED 127.0.0.1:9092'));
    log(entry(logLevel.ERROR, 'Failed to connect to seed broker, trying another broker'));
    log(entry(logLevel.ERROR, 'Restarting the consumer in 300ms', { retryCount: 1 }));
    log(
      entry(logLevel.ERROR, 'Response GroupCoordinator(key: 10, version: 2)', {
        error: "The coordinator is loading and hence can't process requests",
      }),
    );

    expect(calls.map(({ method }) => method)).toEqual(['warn', 'warn', 'warn', 'warn']);
  });

  it('stringifies Error messages (kafkajs logs some errors as the message itself)', () => {
    const { logger, calls } = capture();
    createKafkaLogCreator(logger)(logLevel.WARN)(entry(logLevel.ERROR, new TypeError('boom')));
    expect(calls).toEqual([{ method: 'error', args: ['[Connection] TypeError: boom'] }]);
  });

  it('is what a plain kafkajs client uses (no kafkajs JSON console output)', () => {
    const { logger, calls } = capture();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const kafka = new Kafka({
      brokers: ['localhost:1'],
      logLevel: logLevel.ERROR,
      logCreator: createKafkaLogCreator(logger),
    });
    kafka.logger().error('Crash: something');
    expect(calls).toHaveLength(1);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('isTransientKafkaLog', () => {
  it('keeps real failures at ERROR', () => {
    expect(isTransientKafkaLog('Crash: KafkaJSNumberOfRetriesExceeded', {})).toBe(false);
    expect(isTransientKafkaLog('Response Produce(key: 0)', { error: 'Invalid record' })).toBe(
      false,
    );
    expect(isTransientKafkaLog('Error when calling eachMessage', {})).toBe(false);
  });
});
