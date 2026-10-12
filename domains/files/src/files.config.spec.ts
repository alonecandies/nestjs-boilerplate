import { EnvValidationError } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { filesConfig } from './files.config.js';

const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('filesConfig (the files namespace: upload limits)', () => {
  it('defaults to 25 MiB per file and 4 streamed uploads per process', () => {
    expect(filesConfig.parse({})).toEqual({ maxUploadBytes: 26_214_400, maxConcurrentUploads: 4 });
  });

  it('reads the STORAGE_MAX_* variables (names unchanged)', () => {
    expect(
      filesConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: '1024', STORAGE_MAX_CONCURRENT_UPLOADS: '2' }),
    ).toEqual({ maxUploadBytes: 1024, maxConcurrentUploads: 2 });
  });

  it.each([
    ['STORAGE_MAX_UPLOAD_BYTES', '0'],
    ['STORAGE_MAX_UPLOAD_BYTES', '1.5'],
    ['STORAGE_MAX_CONCURRENT_UPLOADS', '0'],
  ])('rejects %s=%s, naming the variable', (variable, value) => {
    const error = errorOf(() => filesConfig.parse({ [variable]: value }));
    expect(error.namespace).toBe('files');
    expect(error.message).toContain('Invalid environment for "files"');
    expect(error.message).toContain(`→ at ${variable}`);
  });

  it('is registered under the "files" key', () => {
    expect(filesConfig.KEY).toBe('CONFIGURATION(files)');
  });
});
