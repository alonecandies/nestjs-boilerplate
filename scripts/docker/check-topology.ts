// Topology smoke test (E-4). Boots one compose topology (monolith | microservices) with the app
// images in an ISOLATED compose project on shifted host ports, waits until every container is
// healthy and every app answers GET /health/ready, runs one REST journey through the edge API
// (register, then GET /v1/auth/me with the returned token, then one AI chat call: 503 AI_DISABLED
// from the app that runs AI, or a conversation it creates when the stack enables AI), proves that
// an app whose DATABASE_URL
// is the superuser refuses to start (the boot guard in `enforce`), and removes the project. The
// microservices services run GRPC_PRINCIPAL_ASSERTION=enforce (checked before the start), so the
// journey's calls with a user pass only with the gateway's signed principal assertion.
//
//   node scripts/docker/check-topology.ts up <monolith|microservices>     # builds the images
//   NO_BUILD=1 TAG=ci node scripts/docker/check-topology.ts up monolith    # CI: images loaded
//   node scripts/docker/check-topology.ts smoke --base-url http://127.0.0.1:3000   # journey only
//   KEEP=1 keeps the project; PROJECT=<name> replaces bp-topology-<topology> (never boilerplate).
//
// App services: every service whose compose `profiles` include the topology. Host ports: every
// `${X_HOST_PORT:-n}` knob not set in the environment moves to n + 20000 (n - 20000 when that
// exceeds 65535), so the developer's own stack on the default ports is never touched.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const TOPOLOGIES = ['monolith', 'microservices'] as const;
export type Topology = (typeof TOPOLOGIES)[number];

/** The developer's own compose project (`name:` in docker-compose.yml): never used. */
const COMPOSE_PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export const PROTECTED_PROJECTS: readonly string[] = ['boilerplate'];
/** In-network HTTP port of every app image (Dockerfile `ENV PORT=3000`). */
export const APP_HTTP_PORT = 3000;
/** Probes readiness from inside the compose network (busybox wget; already pulled by infra). */
export const PROBE_IMAGE = 'redis:8.10.2-alpine3.23';
export const SMOKE_PASSWORD = 'a very long passphrase';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const COMPOSE_FILE = join(REPO_ROOT, 'docker-compose.yml');
const HOST_PORT_KNOB = /\$\{([A-Z][A-Z0-9_]*_HOST_PORT):-(\d+)\}/g;

export interface ComposeConfig {
  services: Record<string, { profiles?: string[]; environment?: Record<string, string | null> }>;
}

/** Marker of the boot guard's refusal of a superuser runtime connection (libs/database boot-guard). */
export const SUPERUSER_REFUSAL = 'runtime.not-superuser';

/** How the AI chat API answered: AI off (the default) or a conversation created and read back. */
export type SmokeAiOutcome = 'disabled' | 'enabled';

export interface SmokeResult {
  readonly email: string;
  readonly userId: string;
  readonly ai: SmokeAiOutcome;
}

export function isTopology(value: string | undefined): value is Topology {
  return value !== undefined && (TOPOLOGIES as readonly string[]).includes(value);
}

export function projectName(topology: Topology, env: NodeJS.ProcessEnv = process.env): string {
  // An empty PROJECT counts as unset: compose resolves `-p ''` to the file's own name ("boilerplate").
  const name = env.PROJECT || `bp-topology-${topology}`;
  if (!COMPOSE_PROJECT_NAME.test(name)) {
    throw new Error(
      `refusing project name "${name}": it must match ${COMPOSE_PROJECT_NAME.source} (compose's form)`,
    );
  }
  if (PROTECTED_PROJECTS.includes(name)) {
    throw new Error(`refusing to run the topology smoke test in compose project "${name}"`);
  }
  return name;
}

export function shiftedHostPorts(
  composeText: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const ports: Record<string, string> = {};
  for (const [, name, port] of composeText.matchAll(HOST_PORT_KNOB)) {
    if (name === undefined || port === undefined || env[name]) continue;
    const n = Number(port);
    ports[name] = String(n + 20_000 <= 65_535 ? n + 20_000 : n - 20_000);
  }
  return ports;
}

export function appServices(config: ComposeConfig, topology: Topology): string[] {
  return Object.entries(config.services)
    .filter(([, service]) => service.profiles?.includes(topology) === true)
    .map(([name]) => name)
    .sort();
}

/** App services of the topology that run the database (a DATABASE_URL in their compose env). */
export function databaseApps(config: ComposeConfig, topology: Topology): string[] {
  return appServices(config, topology).filter(
    (name) => config.services[name]?.environment?.DATABASE_URL != null,
  );
}

const URL_USER_HOST = /^postgres:\/\/([^:@/]+):[^@/]*@([^/]+)\//;

/**
 * The SH section 5 wiring of one app's compose env: runtime and system roles through PgBouncer,
 * the owner straight to the coordinator, the pooler flag on and the boot guard enforcing.
 * Returns what is wrong (empty when the app is wired as required).
 */
export function threeRoleProblems(
  name: string,
  environment: Record<string, string | null> | undefined,
): string[] {
  const env = environment ?? {};
  const userHost = (key: string): string => {
    const match = URL_USER_HOST.exec(env[key] ?? '');
    const [, user, host] = match ?? [];
    return user === undefined || host === undefined ? '<missing>' : `${user}@${host}`;
  };
  const expected: Record<string, string> = {
    DATABASE_URL: 'app_runtime@pgbouncer:6432',
    DATABASE_SYSTEM_URL: 'app_system@pgbouncer:6432',
    DATABASE_MIGRATION_URL: 'app_owner@postgres:5432',
  };
  const problems = Object.entries(expected)
    .filter(([key, want]) => userHost(key) !== want)
    .map(([key, want]) => `${name}: ${key} is ${userHost(key)}, want ${want}`);
  if (env.DATABASE_POOLER !== 'pgbouncer')
    problems.push(`${name}: DATABASE_POOLER is not pgbouncer`);
  if (env.DATABASE_BOOT_GUARD !== 'enforce')
    problems.push(`${name}: DATABASE_BOOT_GUARD is not enforce`);
  return problems;
}

/** The one app that holds the principal-assertion signing key (the edge) in the microservices topology. */
export const PRINCIPAL_EDGE = 'gateway';

/**
 * The signed gRPC principal wiring of a topology's compose env (grpc-principal-unsigned): in
 * microservices only the edge signs (`GRPC_PRINCIPAL_SIGNING_KEY*`), and every other app verifies
 * in `enforce` with the public keys. The monolith makes no gRPC hop. Returns what is wrong.
 */
export function principalAssertionProblems(config: ComposeConfig, topology: Topology): string[] {
  if (topology !== 'microservices') return [];
  const problems: string[] = [];
  for (const name of appServices(config, topology)) {
    const env = config.services[name]?.environment ?? {};
    const signs =
      env.GRPC_PRINCIPAL_SIGNING_KEY != null || env.GRPC_PRINCIPAL_SIGNING_KEY_FILE != null;
    if (name === PRINCIPAL_EDGE) {
      if (!signs || env.GRPC_PRINCIPAL_SIGNING_KEY_ID == null) {
        problems.push(`${name}: no GRPC_PRINCIPAL_SIGNING_KEY (or _FILE) and _KEY_ID`);
      }
      continue;
    }
    if (signs) problems.push(`${name}: holds the signing key (only ${PRINCIPAL_EDGE} may)`);
    if (env.GRPC_PRINCIPAL_ASSERTION !== 'enforce') {
      problems.push(`${name}: GRPC_PRINCIPAL_ASSERTION is not enforce`);
    }
    if (env.GRPC_PRINCIPAL_PUBLIC_KEYS == null && env.GRPC_PRINCIPAL_PUBLIC_KEYS_FILE == null) {
      problems.push(`${name}: no GRPC_PRINCIPAL_PUBLIC_KEYS (or _FILE)`);
    }
  }
  return problems;
}

async function readJson(
  response: Response,
  label: string,
  expected: number,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(
      `${label}: HTTP ${response.status} (expected ${expected}): ${text.slice(0, 500)}`,
    );
  }
  const body: unknown = JSON.parse(text);
  if (typeof body !== 'object' || body === null) {
    throw new Error(`${label}: not a JSON object: ${text.slice(0, 500)}`);
  }
  return body as Record<string, unknown>;
}

/**
 * POST /v1/ai/conversations as the fresh user (an owner: `ai:chat`). The edge answers through the
 * app that runs AI (the monolith, or ai-service over gRPC): 503 `AI_DISABLED` while AI is off (the
 * compose default), the code having crossed the hop; with AI on, 201 and the conversation reads back.
 */
export async function aiJourney(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmokeAiOutcome> {
  const label = 'POST /v1/ai/conversations';
  const response = await fetchImpl(new URL('/v1/ai/conversations', baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Topology Smoke' }),
  });
  if (response.status === 503) {
    const problem = await readJson(response, label, 503);
    if (problem.code !== 'AI_DISABLED') {
      throw new Error(
        `${label}: 503 with code ${JSON.stringify(problem.code)}, expected AI_DISABLED`,
      );
    }
    return 'disabled';
  }
  const created = await readJson(response, label, 201);
  const id = typeof created.id === 'string' ? created.id : '';
  const read = await readJson(
    await fetchImpl(new URL(`/v1/ai/conversations/${id}`, baseUrl), {
      headers: { authorization: `Bearer ${token}` },
    }),
    `GET /v1/ai/conversations/${id}`,
    200,
  );
  if (id === '' || read.id !== id) {
    throw new Error(`GET /v1/ai/conversations/${id} returned ${JSON.stringify(read.id)}`);
  }
  return 'enabled';
}

/**
 * POST /v1/auth/register (201, accessToken), GET /v1/auth/me (200, same email), then the AI step
 * (`aiJourney`).
 */
export async function smokeJourney(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmokeResult> {
  const email = `smoke-${randomUUID()}@example.com`;
  const registered = await readJson(
    await fetchImpl(new URL('/v1/auth/register', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: SMOKE_PASSWORD, displayName: 'Topology Smoke' }),
    }),
    'POST /v1/auth/register',
    201,
  );
  const token = registered.accessToken;
  if (typeof token !== 'string' || token === '') {
    throw new Error(
      `POST /v1/auth/register returned no accessToken: ${JSON.stringify(registered)}`,
    );
  }
  const user = await readJson(
    await fetchImpl(new URL('/v1/auth/me', baseUrl), {
      headers: { authorization: `Bearer ${token}` },
    }),
    'GET /v1/auth/me',
    200,
  );
  if (user.email !== email) {
    throw new Error(
      `GET /v1/auth/me returned ${JSON.stringify(user.email)}, expected ${JSON.stringify(email)}`,
    );
  }
  const ai = await aiJourney(baseUrl, token, fetchImpl);
  return { email, userId: typeof user.id === 'string' ? user.id : '', ai };
}

function run(argv: readonly string[], env: NodeJS.ProcessEnv, capture = false): string {
  const result = spawnSync('docker', argv, {
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.status !== 0)
    throw new Error(`docker ${argv.join(' ')} exited with ${String(result.status)}`);
  return result.stdout ?? '';
}

async function waitReady(
  project: string,
  services: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  const network = run(
    [
      'network',
      'ls',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--filter',
      'label=com.docker.compose.network=backend',
    ],
    env,
    true,
  )
    .trim()
    .split('\n')[0];
  if (network === undefined || network === '')
    throw new Error(`no backend network for project ${project}`);
  for (const service of services) {
    const url = `http://${service}:${APP_HTTP_PORT}/health/ready`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const probe = spawnSync(
        'docker',
        ['run', '--rm', '--network', network, PROBE_IMAGE, 'wget', '-q', '-T', '5', '-O', '-', url],
        { env, encoding: 'utf8' },
      );
      if (probe.status === 0) {
        console.info(`  ${service}: ready ${probe.stdout.trim()}`);
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${service} not ready after ${timeoutMs} ms: ${probe.stdout}${probe.stderr}`,
        );
      }
      await sleep(2_000);
    }
  }
}

/**
 * A one-off container of `service` whose DATABASE_URL is the superuser, straight to the coordinator.
 * The boot guard (`enforce`) must refuse it: a non-zero exit that names the superuser check. A
 * process that keeps running is killed after `timeoutMs` and fails the probe.
 */
function superuserRefusal(
  compose: (...argv: string[]) => string[],
  service: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): string {
  const user = env.POSTGRES_USER || 'app';
  const password = env.POSTGRES_PASSWORD || 'app';
  const database = env.POSTGRES_DB || 'app';
  const result = spawnSync(
    'docker',
    compose(
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '-e',
      `DATABASE_URL=postgres://${user}:${password}@postgres:5432/${database}`,
      '-e',
      // Both URLs go straight to the coordinator, so the client may send its timeouts as startup
      // parameters (PgBouncer would refuse them): DATABASE_POOLER=none.
      `DATABASE_SYSTEM_URL=postgres://app_system:app_system@postgres:5432/${database}`,
      '-e',
      'DATABASE_POOLER=none',
      '-e',
      'DATABASE_RUN_MIGRATIONS=false',
      service,
    ),
    { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  const output = `${result.stdout}${result.stderr}`;
  if (result.error !== undefined || result.status === 0 || result.status === null) {
    throw new Error(
      `${service} with a superuser DATABASE_URL did not exit non-zero within ${timeoutMs} ms ` +
        `(status ${String(result.status)}): ${output.slice(-500)}`,
    );
  }
  if (!output.includes(SUPERUSER_REFUSAL)) {
    throw new Error(
      `${service} with a superuser DATABASE_URL exited ${result.status} without the boot guard's ` +
        `${SUPERUSER_REFUSAL} finding: ${output.slice(-800)}`,
    );
  }
  return `exit ${result.status}`;
}

async function up(topology: Topology): Promise<void> {
  const project = projectName(topology);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...shiftedHostPorts(readFileSync(COMPOSE_FILE, 'utf8')),
    COMPOSE_PROFILES: topology,
  };
  const compose = (...argv: string[]): string[] => [
    'compose',
    '-f',
    COMPOSE_FILE,
    '-p',
    project,
    ...argv,
  ];
  const config = JSON.parse(run(compose('config', '--format', 'json'), env, true)) as ComposeConfig;
  const services = appServices(config, topology);
  if (services.length === 0) throw new Error(`no compose service has the profile ${topology}`);
  const databaseServices = databaseApps(config, topology);
  const wiring = databaseServices.flatMap((name) =>
    threeRoleProblems(name, config.services[name]?.environment),
  );
  if (databaseServices.length === 0 || wiring.length > 0) {
    throw new Error(`three-role wiring of ${topology}: ${wiring.join('; ') || 'no database app'}`);
  }
  const principalWiring = principalAssertionProblems(config, topology);
  if (principalWiring.length > 0) {
    throw new Error(`signed principal wiring of ${topology}: ${principalWiring.join('; ')}`);
  }
  const apiPort = env.API_HOST_PORT || '3000';
  console.info(
    `[check-topology] ${topology}: project ${project}, apps ${services.join(', ')}, API 127.0.0.1:${apiPort}`,
  );
  const started = Date.now();
  try {
    run(
      compose(
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        env.WAIT_TIMEOUT ?? '600',
        env.NO_BUILD === '1' ? '--no-build' : '--build',
      ),
      env,
    );
    await waitReady(project, services, env, Number(env.READY_TIMEOUT_MS ?? '180000'));
    const result = await smokeJourney(`http://127.0.0.1:${apiPort}`);
    const [probed] = databaseServices;
    if (probed !== undefined) {
      const outcome = superuserRefusal(
        compose,
        probed,
        env,
        Number(env.REFUSAL_TIMEOUT_MS ?? '180000'),
      );
      console.info(`  ${probed}: superuser DATABASE_URL refused by the boot guard (${outcome})`);
    }
    console.info(
      `[check-topology] OK: ${topology} registered ${result.email} and read it back, AI ${result.ai}, in ${Math.round((Date.now() - started) / 1000)}s`,
    );
  } catch (error) {
    spawnSync('docker', compose('ps', '-a'), { env, stdio: 'inherit' });
    spawnSync('docker', compose('logs', '--no-color', '--tail', '80'), { env, stdio: 'inherit' });
    throw error;
  } finally {
    if (env.KEEP === '1') {
      console.info(
        `[check-topology] KEEP=1: leaving ${project} running (docker compose -p ${project} down -v)`,
      );
    } else {
      // projectName() refused PROTECTED_PROJECTS above, so this never removes the developer's volumes.
      spawnSync('docker', compose('down', '-v', '--remove-orphans', '--timeout', '20'), {
        env,
        stdio: 'inherit',
      });
    }
  }
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'base-url': { type: 'string' } },
  });
  const [command, topology] = positionals;
  const baseUrl = values['base-url'];
  if (command === 'smoke' && baseUrl !== undefined) {
    const result = await smokeJourney(baseUrl);
    console.info(
      `[check-topology] journey OK against ${baseUrl} (${result.email}, AI ${result.ai})`,
    );
    return;
  }
  if (command === 'up' && isTopology(topology)) {
    await up(topology);
    return;
  }
  console.error(
    'usage: node scripts/docker/check-topology.ts up <monolith|microservices> | smoke --base-url <url>',
  );
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `[check-topology] FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
