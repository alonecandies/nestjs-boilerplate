import {
  type DynamicModule,
  type INestApplicationContext,
  Module,
  type Provider,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '@platform/config';
import { DatabaseModule, DRIZZLE, type DrizzleDB } from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ClsModule } from 'nestjs-cls';
import postgres from 'postgres';
import { vi } from 'vitest';
import { aiMigrations } from '../src/infrastructure/persistence/ai.migrations.js';
import { type AiSchema, aiSchema } from '../src/infrastructure/persistence/ai.schema.js';

export interface AiDatabase {
  readonly app: INestApplicationContext;
  /** The app's `DRIZZLE` handle: `app_runtime` (NOBYPASSRLS), so every row it sees passed a policy. */
  readonly db: DrizzleDB<AiSchema>;
  /** The container's superuser, outside the app: seeding, DDL and assertions past RLS. */
  readonly superuser: DrizzleDB<AiSchema>;
  readonly pg: RlsTestPostgres;
  close(): Promise<void>;
}

/**
 * A fresh Citus 14.2 database (`startRlsTestPostgres`: the three roles, local execution off unless
 * `localExecution: true`) with the platform set and the ai history applied by the real
 * `DatabaseModule` (unless `runMigrations: false`), and `providers` (and `imports`, e.g. the ai
 * module under test) on top. The roles are those of
 * production: migrations as `app_owner` on DATABASE_MIGRATION_URL, the app as `app_runtime` on
 * DATABASE_URL, system methods as `app_system` on DATABASE_SYSTEM_URL; the boot guard enforces that
 * when the migrations run. Seed and assert through `superuser`. Int specs only.
 */
export async function startAiDatabase(
  providers: Provider[],
  options: {
    runMigrations?: boolean;
    localExecution?: boolean;
    imports?: (Type | DynamicModule)[];
  } = {},
): Promise<AiDatabase> {
  const runMigrations = options.runMigrations ?? true;
  const pg = await startRlsTestPostgres({ localExecution: options.localExecution ?? false });
  const superuser = drizzle({
    client: postgres(pg.url, { max: 2, onnotice: () => undefined }),
    schema: aiSchema,
    casing: 'snake_case',
  }) as DrizzleDB<AiSchema>;
  vi.stubEnv('DATABASE_URL', pg.runtimeUrl);
  vi.stubEnv('DATABASE_SYSTEM_URL', pg.systemUrl);
  vi.stubEnv('DATABASE_MIGRATION_URL', pg.migrationUrl);
  // Without the platform set the guard's Citus probe cannot run: it warns instead of refusing.
  vi.stubEnv('DATABASE_BOOT_GUARD', runMigrations ? 'enforce' : 'warn');
  vi.stubEnv('SERVICE_NAME', 'ai-int');

  @Module({
    imports: [
      AppConfigModule.forRoot(),
      ClsModule.forRoot({ global: true }),
      DatabaseModule.forRootAsync({
        schema: aiSchema,
        migrations: [aiMigrations],
        runMigrations,
      }),
      ...(options.imports ?? []),
    ],
    providers,
  })
  class AiIntModule {}

  const release = async (): Promise<void> => {
    await superuser.$client.end({ timeout: 5 });
    await pg.stop();
    vi.unstubAllEnvs();
  };
  try {
    const app = await NestFactory.createApplicationContext(AiIntModule, {
      logger: false,
      abortOnError: false,
    });
    return {
      app,
      db: app.get<DrizzleDB<AiSchema>>(DRIZZLE),
      superuser,
      pg,
      close: async () => {
        await app.close();
        await release();
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}
