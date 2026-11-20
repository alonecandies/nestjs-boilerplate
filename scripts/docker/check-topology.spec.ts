import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aiJourney,
  appServices,
  type ComposeConfig,
  databaseApps,
  projectName,
  SMOKE_PASSWORD,
  shiftedHostPorts,
  smokeJourney,
  TOPOLOGIES,
  threeRoleProblems,
} from './check-topology.js';

const COMPOSE = readFileSync(join(import.meta.dirname, '..', '..', 'docker-compose.yml'), 'utf8');

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** A fetch double serving the journey endpoints; `override` replaces one response. */
function fakeApi(
  override: Partial<Record<'register' | 'me' | 'aiCreate' | 'aiRead', Response>> = {},
) {
  const calls: Recorded[] = [];
  let email = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      authorization: headers.get('authorization'),
      body,
    });
    if (url.pathname === '/v1/auth/register') {
      email = (body as { email: string }).email;
      return (
        override.register ??
        Response.json({ accessToken: 'token-1', user: { id: 'u-1', email } }, { status: 201 })
      );
    }
    if (url.pathname === '/v1/auth/me') {
      return override.me ?? Response.json({ id: 'u-1', email }, { status: 200 });
    }
    if (url.pathname === '/v1/ai/conversations') {
      return (
        override.aiCreate ?? Response.json({ status: 503, code: 'AI_DISABLED' }, { status: 503 })
      );
    }
    if (url.pathname === '/v1/ai/conversations/c-1') {
      return override.aiRead ?? Response.json({ id: 'c-1' }, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

describe('projectName', () => {
  it('defaults to an isolated bp-topology-<topology> project', () => {
    expect(TOPOLOGIES.map((t) => projectName(t, {}))).toEqual([
      'bp-topology-monolith',
      'bp-topology-microservices',
    ]);
  });

  it('honours PROJECT but refuses the developer project "boilerplate"', () => {
    expect(projectName('monolith', { PROJECT: 'e-smoke' })).toBe('e-smoke');
    expect(() => projectName('monolith', { PROJECT: 'boilerplate' })).toThrow(/refusing/);
  });

  it('treats an empty PROJECT as unset, never as the compose file name', () => {
    expect(projectName('monolith', { PROJECT: '' })).toBe('bp-topology-monolith');
  });

  it('refuses names outside the compose project-name form', () => {
    for (const PROJECT of ['Boilerplate', ' boilerplate', '-x', 'a b', 'a/b']) {
      expect(() => projectName('monolith', { PROJECT })).toThrow(/refusing/);
    }
  });
});

describe('shiftedHostPorts', () => {
  it('moves every *_HOST_PORT knob of docker-compose.yml off its default', () => {
    const ports = shiftedHostPorts(COMPOSE, {});
    expect(ports).toMatchObject({
      API_HOST_PORT: '23000',
      POSTGRES_HOST_PORT: '25432',
      REDIS_HOST_PORT: '26379',
      IDENTITY_GRPC_HOST_PORT: '30051',
    });
    const defaults = new Map(
      [...COMPOSE.matchAll(/\$\{([A-Z0-9_]+_HOST_PORT):-(\d+)\}/g)].map(([, name, port]) => [
        name,
        port,
      ]),
    );
    expect(Object.keys(ports).sort()).toEqual([...defaults.keys()].sort());
    for (const [name, port] of Object.entries(ports)) {
      expect(port).not.toBe(defaults.get(name));
      expect(Number(port)).toBeGreaterThan(1024);
      expect(Number(port)).toBeLessThanOrEqual(65_535);
    }
    expect(new Set(Object.values(ports)).size).toBe(Object.keys(ports).length);
  });

  it('treats an empty knob as unset and still shifts it', () => {
    expect(shiftedHostPorts(COMPOSE, { API_HOST_PORT: '' })).toMatchObject({
      API_HOST_PORT: '23000',
    });
  });

  it('keeps a port the caller already set', () => {
    expect(shiftedHostPorts(COMPOSE, { POSTGRES_HOST_PORT: '15432' })).not.toHaveProperty(
      'POSTGRES_HOST_PORT',
    );
  });
});

describe('appServices', () => {
  const config: ComposeConfig = {
    services: {
      postgres: {},
      redis: { profiles: [] },
      jaeger: { profiles: ['observability'] },
      monolith: { profiles: ['monolith'] },
      gateway: { profiles: ['microservices'] },
      'billing-service': { profiles: ['microservices'] },
      'identity-service': { profiles: ['microservices'] },
      'notifications-service': { profiles: ['microservices'] },
      'ai-service': { profiles: ['microservices'] },
    },
  };

  it('returns only the services of the topology profile, sorted', () => {
    expect(appServices(config, 'monolith')).toEqual(['monolith']);
    expect(appServices(config, 'microservices')).toEqual([
      'ai-service',
      'billing-service',
      'gateway',
      'identity-service',
      'notifications-service',
    ]);
  });
});

describe('smokeJourney', () => {
  it('registers a fresh user, reads it back, then reaches the AI chat API as that user', async () => {
    const api = fakeApi();
    const result = await smokeJourney('http://127.0.0.1:23000', api.fetchImpl);
    expect(result.email).toMatch(/^smoke-[0-9a-f-]{36}@example\.com$/);
    expect(result.userId).toBe('u-1');
    expect(result.ai).toBe('disabled');
    expect(api.calls).toEqual([
      {
        method: 'POST',
        path: '/v1/auth/register',
        authorization: null,
        body: { email: result.email, password: SMOKE_PASSWORD, displayName: 'Topology Smoke' },
      },
      { method: 'GET', path: '/v1/auth/me', authorization: 'Bearer token-1', body: undefined },
      {
        method: 'POST',
        path: '/v1/ai/conversations',
        authorization: 'Bearer token-1',
        body: { title: 'Topology Smoke' },
      },
    ]);
  });

  it('fails with the status and body when register does not answer 201', async () => {
    const api = fakeApi({ register: new Response('{"code":"BOOM"}', { status: 500 }) });
    await expect(smokeJourney('http://127.0.0.1:23000', api.fetchImpl)).rejects.toThrow(
      'POST /v1/auth/register: HTTP 500 (expected 201): {"code":"BOOM"}',
    );
  });

  it('fails when register returns no access token', async () => {
    const api = fakeApi({ register: Response.json({ user: {} }, { status: 201 }) });
    await expect(smokeJourney('http://127.0.0.1:23000', api.fetchImpl)).rejects.toThrow(
      /no accessToken/,
    );
  });

  it('fails when /v1/auth/me returns another user', async () => {
    const api = fakeApi({ me: Response.json({ id: 'u-2', email: 'someone@example.com' }) });
    await expect(smokeJourney('http://127.0.0.1:23000', api.fetchImpl)).rejects.toThrow(
      /expected "smoke-/,
    );
  });
});

describe('aiJourney', () => {
  it('accepts 503 AI_DISABLED (AI off, the compose default)', async () => {
    await expect(aiJourney('http://x.test', 't', fakeApi().fetchImpl)).resolves.toBe('disabled');
  });

  it('with AI on, creates a conversation and reads it back', async () => {
    const api = fakeApi({ aiCreate: Response.json({ id: 'c-1' }, { status: 201 }) });
    await expect(aiJourney('http://x.test', 't', api.fetchImpl)).resolves.toBe('enabled');
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /v1/ai/conversations',
      'GET /v1/ai/conversations/c-1',
    ]);
  });

  it('fails on a 503 that is not AI_DISABLED (an unreachable ai-service)', async () => {
    const api = fakeApi({
      aiCreate: Response.json({ status: 503, code: 'SERVICE_UNAVAILABLE' }, { status: 503 }),
    });
    await expect(aiJourney('http://x.test', 't', api.fetchImpl)).rejects.toThrow(
      /expected AI_DISABLED/,
    );
  });

  it('fails with the status and body on anything else', async () => {
    const api = fakeApi({ aiCreate: new Response('{"code":"BOOM"}', { status: 502 }) });
    await expect(aiJourney('http://x.test', 't', api.fetchImpl)).rejects.toThrow(
      'POST /v1/ai/conversations: HTTP 502 (expected 201): {"code":"BOOM"}',
    );
  });
});

describe('three-role wiring of the compose apps', () => {
  const wired = {
    DATABASE_URL: 'postgres://app_runtime:app_runtime@pgbouncer:6432/app',
    DATABASE_SYSTEM_URL: 'postgres://app_system:app_system@pgbouncer:6432/app',
    DATABASE_MIGRATION_URL: 'postgres://app_owner:app_owner@postgres:5432/app',
    DATABASE_POOLER: 'pgbouncer',
    DATABASE_BOOT_GUARD: 'enforce',
  };

  it('accepts the SH section 5 wiring', () => {
    expect(threeRoleProblems('monolith', wired)).toEqual([]);
  });

  it('names every deviation: superuser runtime, shared URL, pooled owner, guard off', () => {
    const problems = threeRoleProblems('monolith', {
      ...wired,
      DATABASE_URL: 'postgres://app:app@postgres:5432/app',
      DATABASE_MIGRATION_URL: 'postgres://app_owner:app_owner@pgbouncer:6432/app',
      DATABASE_BOOT_GUARD: 'warn',
    });
    expect(problems).toEqual([
      'monolith: DATABASE_URL is app@postgres:5432, want app_runtime@pgbouncer:6432',
      'monolith: DATABASE_MIGRATION_URL is app_owner@pgbouncer:6432, want app_owner@postgres:5432',
      'monolith: DATABASE_BOOT_GUARD is not enforce',
    ]);
    expect(threeRoleProblems('x', undefined)).toHaveLength(5);
  });

  it('lists the apps that run the database, per topology', () => {
    const config: ComposeConfig = {
      services: {
        monolith: { profiles: ['monolith'], environment: wired },
        gateway: { profiles: ['microservices'], environment: {} },
        'identity-service': { profiles: ['microservices'], environment: wired },
        'billing-service': { profiles: ['microservices'], environment: wired },
        'notifications-service': { profiles: ['microservices'] },
        'ai-service': { profiles: ['microservices'], environment: wired },
      },
    };
    expect(databaseApps(config, 'monolith')).toEqual(['monolith']);
    expect(databaseApps(config, 'microservices')).toEqual([
      'ai-service',
      'billing-service',
      'identity-service',
    ]);
  });
});
