import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config, {
  intHookTimeoutMs,
  SETUP_FILES,
  scriptsProject,
  UNIT_HOOK_TIMEOUT_MS,
  UNIT_TEST_TIMEOUT_MS,
  unitProject,
  withUniqueLibNames,
} from '../vitest.config.js';
import { configureNestTestLogging } from '../vitest.setup.js';

const ROOT = join(import.meta.dirname, '..');

describe('vitest.config.ts', () => {
  it('gives unit projects room for in-process Nest boots (B1FU-11)', () => {
    expect(UNIT_TEST_TIMEOUT_MS).toBe(15_000);
    expect(UNIT_HOOK_TIMEOUT_MS).toBe(30_000);
    const project = unitProject({ name: 'probe', root: join(ROOT, 'libs', 'common') });
    expect(project.test).toMatchObject({
      name: 'probe',
      testTimeout: UNIT_TEST_TIMEOUT_MS,
      hookTimeout: UNIT_HOOK_TIMEOUT_MS,
    });
  });

  it('gives the scripts project the same timeouts (its specs spawn buf, drizzle-kit, git)', () => {
    expect(scriptsProject.test).toMatchObject({
      name: 'scripts',
      testTimeout: UNIT_TEST_TIMEOUT_MS,
      hookTimeout: UNIT_HOOK_TIMEOUT_MS,
    });
  });

  it("keeps int projects' hook timeout a minute above the container startup wait", () => {
    expect(intHookTimeoutMs({})).toBe(180_000);
    expect(intHookTimeoutMs({ TEST_POSTGRES_STARTUP_TIMEOUT_MS: '60000' })).toBe(180_000);
    expect(intHookTimeoutMs({ TEST_POSTGRES_STARTUP_TIMEOUT_MS: '360000' })).toBe(420_000);
    // An invalid value fails in startTestPostgres itself; here it just keeps the default.
    expect(intHookTimeoutMs({ TEST_POSTGRES_STARTUP_TIMEOUT_MS: 'abc' })).toBe(180_000);
  });

  it('names a lib that shares a domain folder name platform-<name>, and leaves the others alone', () => {
    const lib = (name: string) => ({ name, root: join(ROOT, 'libs', name) });
    const domain = (name: string) => ({ name, root: join(ROOT, 'domains', name) });
    expect(
      withUniqueLibNames([lib('ai'), lib('redis')], [domain('ai'), domain('ai-contracts')]),
    ).toEqual([
      { name: 'platform-ai', root: join(ROOT, 'libs', 'ai') },
      { name: 'redis', root: join(ROOT, 'libs', 'redis') },
    ]);
  });

  it('gives every project of the repo a unique name (Vitest refuses duplicates)', () => {
    const names = (config.test?.projects ?? []).map((project) =>
      typeof project === 'object' && project !== null && 'test' in project
        ? project.test?.name
        : undefined,
    );
    expect(names).toContain('ai');
    expect(names).toContain('platform-ai');
    expect(new Set(names).size).toBe(names.length);
  });

  it('loads reflect-metadata first, then the repo setup file by absolute path', () => {
    expect(SETUP_FILES).toEqual(['reflect-metadata', join(ROOT, 'vitest.setup.ts')]);
    expect(existsSync(SETUP_FILES[1] ?? '')).toBe(true);
  });
});

describe('vitest.setup.ts (B1FU-10)', () => {
  afterEach(() => {
    // Leave the worker as every other spec sees it: silent.
    configureNestTestLogging({});
  });

  it('silences the Nest logger by default', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(configureNestTestLogging({})).toBe('silent');
    new Logger('Probe').log('must not print');
    new Logger('Probe').error('must not print either', 'stack');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('stays silent after Test.createTestingModule() installs its TestingLogger', async () => {
    configureNestTestLogging({});
    const moduleRef = await Test.createTestingModule({}).compile();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    new Logger('Probe').error('must not print', 'stack');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('keeps the logger untouched with TEST_LOGS=1', () => {
    const override = vi.spyOn(Logger, 'overrideLogger');
    expect(configureNestTestLogging({ TEST_LOGS: '1' })).toBe('verbose');
    expect(override).not.toHaveBeenCalled();
  });

  it('still lets specs spy on Logger.prototype', () => {
    configureNestTestLogging({});
    const warn = vi.spyOn(Logger.prototype, 'warn');
    new Logger('Probe').warn('observed, not printed');
    expect(warn).toHaveBeenCalledWith('observed, not printed');
  });
});
