import { type INestApplicationContext, Module, type Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '@platform/config';
import { DatabaseModule, DRIZZLE, type DrizzleDB } from '@platform/database';
import { startTestPostgres } from '@platform/testing/postgres';
import { ClsModule } from 'nestjs-cls';
import { vi } from 'vitest';
import { billingMigrations } from '../src/infrastructure/persistence/billing.migrations.js';
import {
  type BillingSchema,
  billingSchema,
} from '../src/infrastructure/persistence/billing.schema.js';

export interface BillingDatabase {
  readonly app: INestApplicationContext;
  readonly db: DrizzleDB<BillingSchema>;
  close(): Promise<void>;
}

/**
 * A fresh Citus 14.2 database with the platform set and billing's history applied by the real
 * `DatabaseModule` (unless `runMigrations: false`), and `providers` on top. Int specs only.
 * Tenant-isolation specs pass `localExecution: false` (S0, sharding design §6).
 */
export async function startBillingDatabase(
  providers: Provider[],
  options: { runMigrations?: boolean; localExecution?: boolean } = {},
): Promise<BillingDatabase> {
  const pg = await startTestPostgres({ localExecution: options.localExecution ?? true });
  vi.stubEnv('DATABASE_URL', pg.url);
  vi.stubEnv('SERVICE_NAME', 'billing-int');

  @Module({
    imports: [
      AppConfigModule.forRoot(),
      ClsModule.forRoot({ global: true }),
      DatabaseModule.forRootAsync({
        schema: billingSchema,
        migrations: [billingMigrations],
        runMigrations: options.runMigrations ?? true,
      }),
    ],
    providers,
  })
  class BillingIntModule {}

  try {
    const app = await NestFactory.createApplicationContext(BillingIntModule, {
      logger: false,
      abortOnError: false,
    });
    return {
      app,
      db: app.get<DrizzleDB<BillingSchema>>(DRIZZLE),
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
