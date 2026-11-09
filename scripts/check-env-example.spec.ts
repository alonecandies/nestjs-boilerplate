// biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose `${VAR}` interpolation is the test data.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'check-env-example.mjs');
const MARKER = '# docker compose ONLY (interpolation in docker-compose.yml; ignored by the apps)';

type Tree = Record<string, string>;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function check(tree: Tree): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'check-env-example-'));
  roots.push(root);
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const namespace = (keys: string[]): string =>
  `export const schema = z.object({\n${keys.map((k) => `  ${k}: zStr('x'),`).join('\n')}\n});\n`;

/** A tree that passes: one platform namespace, its variable documented, an empty compose section. */
const BASE: Tree = {
  'libs/config/src/namespaces/app.config.ts': namespace(['PORT']),
  '.env.example': `PORT=3000\n${MARKER}\n`,
};

describe('check-env-example', () => {
  it('passes when every namespace variable is documented', () => {
    const result = check(BASE);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('.env.example documents all 1 config variables');
  });

  it('reads app namespaces (apps/*/src/**/*.config.ts)', () => {
    const result = check({ ...BASE, 'apps/api/src/api.config.ts': namespace(['API_PAGE_SIZE']) });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'missing from .env.example: API_PAGE_SIZE (apps/api/src/api.config.ts)',
    );
  });

  it('reads namespaces of libs outside libs/config (a store adapter such as libs/ledger)', () => {
    const result = check({
      ...BASE,
      'libs/ledger/src/ledger.config.ts': namespace(['LEDGER_URL']),
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'missing from .env.example: LEDGER_URL (libs/ledger/src/ledger.config.ts)',
    );
  });

  it('ignores *.config.ts outside src/ (drizzle.config.ts, vitest.config.ts)', () => {
    const result = check({
      ...BASE,
      'domains/orders/drizzle.config.ts': namespace(['IGNORED_ONE']),
      'apps/api/vitest.config.ts': namespace(['IGNORED_TWO']),
    });
    expect(result.status, result.output).toBe(0);
  });

  it('fails on a compose variable that .env.example does not document', () => {
    const result = check({
      ...BASE,
      'docker-compose.yml':
        'services:\n  ledger:\n    ports: ["127.0.0.1:${LEDGER_HOST_PORT:-3322}:3322"]\n',
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'docker-compose.yml interpolates LEDGER_HOST_PORT, which .env.example does not document',
    );
  });

  it('fails on a compose-section variable that no compose file interpolates', () => {
    const result = check({
      ...BASE,
      '.env.example': `PORT=3000\n${MARKER}\n# OLD_HOST_PORT=1\n`,
      'docker-compose.yml': 'services: {}\n',
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      '.env.example compose section lists OLD_HOST_PORT, which no compose file interpolates',
    );
  });

  it('accepts compose built-ins, $$ escapes, comment lines and app-section documentation', () => {
    const result = check({
      ...BASE,
      '.env.example': `PORT=3000\nSTRIPE_KEY=\n${MARKER}\n# COMPOSE_PROFILES=\n# TAG=local\n`,
      'libs/config/src/namespaces/app.config.ts': namespace(['PORT', 'STRIPE_KEY']),
      'docker-compose.yml': [
        'services:',
        '  api:',
        '    image: boilerplate/api:${TAG:-local}',
        '    environment:',
        '      STRIPE_KEY: ${STRIPE_KEY:-sk_test_local}',
        '    # set ${NOT_A_KNOB} in a comment: ignored',
        '    healthcheck:',
        '      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]',
        '',
      ].join('\n'),
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('.env.example documents all 2 docker compose variables');
  });

  it('reads every root compose file (docker-compose.citus.yml too)', () => {
    const result = check({
      ...BASE,
      'docker-compose.yml': 'services: {}\n',
      'docker-compose.citus.yml': 'services:\n  pgbouncer:\n    image: x:${PGBOUNCER_TAG}\n',
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain('docker-compose.citus.yml interpolates PGBOUNCER_TAG');
  });

  it('passes on this repository', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    // Other lanes may add root compose files: only require that docker-compose.yml is among them.
    expect(result.stdout).toMatch(/docker compose variables \([^)]*docker-compose\.yml/);
  });
});
