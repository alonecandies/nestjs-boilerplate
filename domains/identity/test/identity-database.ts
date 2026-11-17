import { type INestApplicationContext, Module, type Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '@platform/config';
import { DatabaseModule, DRIZZLE, type DrizzleDB } from '@platform/database';
import { startTestPostgres } from '@platform/testing/postgres';
import { ClsModule } from 'nestjs-cls';
import { vi } from 'vitest';
import { identityMigrations } from '../src/infrastructure/persistence/identity.migrations.js';
import {
  type IdentitySchema,
  identitySchema,
} from '../src/infrastructure/persistence/identity.schema.js';

export interface IdentityDatabase {
  readonly app: INestApplicationContext;
  readonly db: DrizzleDB<IdentitySchema>;
  close(): Promise<void>;
}

/**
 * A fresh Citus 14.2 database (`startTestPostgres`) with the platform set and identity's history
 * applied by the real `DatabaseModule`, and `providers` (repositories under test) on top. Int specs only.
 * `options.localExecution: false` makes Citus execute on workers like a cluster (tenant-isolation specs).
 */
export async function startIdentityDatabase(
  providers: Provider[],
  options: { localExecution?: boolean } = {},
): Promise<IdentityDatabase> {
  const pg = await startTestPostgres({ localExecution: options.localExecution ?? true });
  vi.stubEnv('DATABASE_URL', pg.url);
  vi.stubEnv('DATABASE_MIGRATION_URL', pg.url); // the superuser until the role flip
  vi.stubEnv('SERVICE_NAME', 'identity-int');

  @Module({
    imports: [
      AppConfigModule.forRoot(),
      ClsModule.forRoot({ global: true }),
      DatabaseModule.forRootAsync({
        schema: identitySchema,
        migrations: [identityMigrations],
        runMigrations: true,
      }),
    ],
    providers,
  })
  class IdentityIntModule {}

  try {
    const app = await NestFactory.createApplicationContext(IdentityIntModule, {
      logger: false,
      abortOnError: false,
    });
    return {
      app,
      db: app.get<DrizzleDB<IdentitySchema>>(DRIZZLE),
      close: async () => {
        await app.close();
        await pg.stop();
        vi.unstubAllEnvs();
      },
    };
  } catch (error) {
    await pg.stop();
    vi.unstubAllEnvs();
    throw error;
  }
}
