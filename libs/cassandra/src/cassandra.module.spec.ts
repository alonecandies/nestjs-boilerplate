import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigModule } from '@app/config';
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CASSANDRA_CLIENT } from './cassandra.constants.js';
import { CassandraModule } from './cassandra.module.js';
import type { CassandraModuleOptions } from './cassandra.types.js';
import { CassandraHealthIndicator } from './health/cassandra.health.js';

/** Recording stand-in for `cassandra.Client` (hoisted: the module under test destructures it at load). */
const driver = vi.hoisted(() => {
  interface Call {
    query: string;
    options: unknown;
  }
  interface Reply {
    rows?: Record<string, unknown>[];
    applied?: boolean;
  }
  class FakeClient {
    static instances: FakeClient[] = [];
    static connectErrors: Error[] = [];
    static reply: (query: string) => Reply = (query) =>
      query.startsWith('SELECT') ? { rows: [] } : { applied: true };

    readonly calls: Call[] = [];
    readonly events: string[] = [];
    shutdowns = 0;

    constructor(readonly options: { keyspace?: string; policies?: Record<string, unknown> }) {
      FakeClient.instances.push(this);
    }

    async connect(): Promise<void> {
      const error = FakeClient.connectErrors.shift();
      if (error) throw error;
    }

    async shutdown(): Promise<void> {
      this.shutdowns += 1;
    }

    on(event: string): this {
      this.events.push(event);
      return this;
    }

    async execute(query: string, _params: unknown, options: unknown) {
      this.calls.push({ query, options });
      const reply = FakeClient.reply(query);
      const rows = (reply.rows ?? []).map((values) => ({
        ...values,
        get: (k: string) => values[k],
      }));
      return { rows, pageState: null, wasApplied: () => reply.applied ?? true };
    }
  }
  return { FakeClient };
});

vi.mock('cassandra-driver', async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { default: { ...actual.default, Client: driver.FakeClient } };
});
// Abstract marker class; mocked so the test does not load observability's module graph.
vi.mock('@app/observability', () => ({ HealthContributor: class HealthContributor {} }));

const { FakeClient } = driver;

const namedError = (name: string, message = name): Error =>
  Object.assign(new Error(message), { name });

async function boot(options: CassandraModuleOptions = {}): Promise<INestApplicationContext> {
  @Module({ imports: [AppConfigModule.forRoot(), CassandraModule.forRootAsync(options)] })
  class TestAppModule {}
  return NestFactory.createApplicationContext(TestAppModule, {
    logger: false,
    abortOnError: false,
  });
}

describe('CassandraModule', () => {
  let app: INestApplicationContext | undefined;
  let dir: string;

  beforeEach(() => {
    FakeClient.instances = [];
    FakeClient.connectErrors = [];
    dir = mkdtempSync(join(tmpdir(), 'cassandra-module-'));
    writeFileSync(
      join(dir, '001_create_notifications.cql'),
      'CREATE TABLE IF NOT EXISTS notifications_by_user (user_id uuid, id uuid, PRIMARY KEY ((user_id), id));',
    );
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('forRootAsync() is global and exports the client token + health contributor', () => {
    const mod = CassandraModule.forRootAsync({ migrations: [{ dir }] });
    expect(mod).toMatchObject({ module: CassandraModule, global: true });
    expect(mod.exports).toEqual([CASSANDRA_CLIENT, CassandraHealthIndicator]);
  });

  it('bootstraps the keyspace with a keyspace-less client, then migrates through the main client', async () => {
    app = await boot({ migrations: [{ dir }] });
    const [bootstrap, main] = FakeClient.instances;
    expect(FakeClient.instances).toHaveLength(2);

    expect(bootstrap?.options.keyspace).toBeUndefined();
    expect(bootstrap?.calls.map((c) => c.query)).toEqual([
      "CREATE KEYSPACE IF NOT EXISTS app WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1} AND durable_writes = true",
    ]);
    expect(bootstrap?.shutdowns).toBe(1);

    expect(main?.options.keyspace).toBe('app');
    expect(app.get(CASSANDRA_CLIENT)).toBe(main);
    expect(main?.events).toContain('log'); // driver log → Nest Logger
    expect(main?.calls.map((c) => c.query)).toContain(
      'CREATE TABLE IF NOT EXISTS notifications_by_user (user_id uuid, id uuid, PRIMARY KEY ((user_id), id))',
    );
    // GOTCHA 14: policy objects must never be shared between two clients.
    expect(main?.options.policies?.['loadBalancing']).not.toBe(
      bootstrap?.options.policies?.['loadBalancing'],
    );
  });

  it('uses CASSANDRA_REPLICATION_FACTOR, and an explicit replication option wins', async () => {
    vi.stubEnv('CASSANDRA_REPLICATION_FACTOR', '3');
    app = await boot();
    expect(FakeClient.instances[0]?.calls[0]?.query).toContain("'replication_factor': 3");
    await app.close();
    FakeClient.instances = [];

    app = await boot({
      replication: { class: 'NetworkTopologyStrategy', dataCenters: { datacenter1: 3 } },
    });
    expect(FakeClient.instances[0]?.calls[0]?.query).toContain(
      "{'class': 'NetworkTopologyStrategy', 'datacenter1': 3}",
    );
  });

  it('skips keyspace bootstrap and migrations when disabled', async () => {
    vi.stubEnv('CASSANDRA_RUN_MIGRATIONS', 'false');
    app = await boot({ migrations: [{ dir }] });
    expect(FakeClient.instances).toHaveLength(1);
    expect(FakeClient.instances[0]?.options.keyspace).toBe('app');
    expect(FakeClient.instances[0]?.calls).toEqual([]);
  });

  it('retries transient connect failures with a fresh client', async () => {
    FakeClient.connectErrors = [namedError('NoHostAvailableError')];
    app = await boot({ runMigrations: false });
    expect(FakeClient.instances).toHaveLength(2);
    expect(FakeClient.instances[0]?.shutdowns).toBe(1); // the failed client is disposed
    expect(app.get(CASSANDRA_CLIENT)).toBe(FakeClient.instances[1]);
  });

  it('fails fast on non-transient connect errors', async () => {
    FakeClient.connectErrors = [namedError('AuthenticationError', 'Bad credentials')];
    await expect(boot({ runMigrations: false })).rejects.toThrow('Bad credentials');
    expect(FakeClient.instances).toHaveLength(1);
  });

  it('closes the main client when a migration fails at boot', async () => {
    FakeClient.reply = (query) => {
      if (query.startsWith('CREATE TABLE IF NOT EXISTS notifications_by_user')) {
        throw new Error('SyntaxException');
      }
      return query.startsWith('SELECT') ? { rows: [] } : { applied: true };
    };
    try {
      await expect(boot({ migrations: [{ dir }] })).rejects.toThrow(
        /CQL migration 001_create_notifications failed/,
      );
      expect(FakeClient.instances[1]?.shutdowns).toBe(1);
    } finally {
      FakeClient.reply = (query) => (query.startsWith('SELECT') ? { rows: [] } : { applied: true });
    }
  });

  it('shuts the client down with the application', async () => {
    app = await boot({ runMigrations: false });
    const [main] = FakeClient.instances;
    await app.close();
    app = undefined;
    expect(main?.shutdowns).toBe(1);
  });
});
