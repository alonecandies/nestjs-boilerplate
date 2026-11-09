// Topology smoke test (E-4). Boots one compose topology (monolith | microservices) with the app
// images in an ISOLATED compose project on shifted host ports, waits until every container is
// healthy and every app answers GET /health/ready, runs one REST journey through the edge API
// (register, then GET /v1/auth/me with the returned token) and removes the project.
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
  services: Record<string, { profiles?: string[] }>;
}

export interface SmokeResult {
  readonly email: string;
  readonly userId: string;
}

export function isTopology(value: string | undefined): value is Topology {
  return value !== undefined && (TOPOLOGIES as readonly string[]).includes(value);
}

export function projectName(topology: Topology, env: NodeJS.ProcessEnv = process.env): string {
  const name = env.PROJECT ?? `bp-topology-${topology}`;
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
    if (name === undefined || port === undefined || env[name] !== undefined) continue;
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

/** POST /v1/auth/register (201, accessToken) then GET /v1/auth/me (200, same email). */
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
  return { email, userId: typeof user.id === 'string' ? user.id : '' };
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
  const apiPort = env.API_HOST_PORT ?? '3000';
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
    console.info(
      `[check-topology] OK: ${topology} registered ${result.email} and read it back in ${Math.round((Date.now() - started) / 1000)}s`,
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
    console.info(`[check-topology] journey OK against ${baseUrl} (${result.email})`);
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
