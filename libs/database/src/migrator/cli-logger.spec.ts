import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMigrateCliLogger } from './cli-logger.js';

describe('createMigrateCliLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  const capture = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const captureErr = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  it('writes one JSON object per line by default (deploy jobs)', () => {
    const out = capture();
    createMigrateCliLogger(false).log('Done: 1 applied, 2 total');

    const line = String(out.mock.calls[0]?.[0]);
    expect(line).not.toContain('\u001b[');
    expect(JSON.parse(line)).toMatchObject({
      level: 'log',
      context: 'DatabaseMigrate',
      message: 'Done: 1 applied, 2 total',
    });
  });

  it('writes errors as JSON on stderr', () => {
    const err = captureErr();
    createMigrateCliLogger(false).error('boom');

    expect(JSON.parse(String(err.mock.calls[0]?.[0]))).toMatchObject({
      level: 'error',
      message: 'boom',
    });
  });

  it('keeps human-readable text when pretty', () => {
    const out = capture();
    createMigrateCliLogger(true).log('hello');

    const line = String(out.mock.calls[0]?.[0]);
    expect(line).toContain('[DatabaseMigrate]');
    expect(() => JSON.parse(line)).toThrow();
  });
});
