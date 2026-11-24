import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliLogger } from './cli-logger.js';

describe('createCliLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  const capture = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const captureErr = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  it('writes one JSON object per line, without colours, when not pretty (deploy jobs)', () => {
    const out = capture();
    createCliLogger('OneOffJob', false).log('Done: 1 applied, 2 total');

    const line = String(out.mock.calls[0]?.[0]);
    expect(line).not.toContain('\u001b[');
    expect(JSON.parse(line)).toMatchObject({
      level: 'log',
      context: 'OneOffJob',
      message: 'Done: 1 applied, 2 total',
    });
  });

  it('writes errors as JSON on stderr when not pretty', () => {
    const err = captureErr();
    createCliLogger('OneOffJob', false).error('boom');

    expect(JSON.parse(String(err.mock.calls[0]?.[0]))).toMatchObject({
      level: 'error',
      context: 'OneOffJob',
      message: 'boom',
    });
  });

  it('writes coloured, human-readable text when pretty', () => {
    const out = capture();
    createCliLogger('OneOffJob', true).log('hello');

    const line = String(out.mock.calls[0]?.[0]);
    expect(line).toContain('[OneOffJob]');
    expect(line).toContain('\u001b[');
    expect(() => JSON.parse(line)).toThrow();
  });
});
