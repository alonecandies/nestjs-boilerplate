import {
  type DynamicModule,
  Global,
  type INestApplicationContext,
  Module,
  type Provider,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type Principal, PrincipalPermissions, runWithPrincipal } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import {
  DatabaseModule,
  DRIZZLE,
  type DrizzleDB,
  type DrizzleTransactionalAdapter,
  RlsElevation,
  TransactionHost,
} from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ClsModule } from 'nestjs-cls';
import postgres, { type Sql } from 'postgres';
import { vi } from 'vitest';
import { identityMigrations } from '../src/infrastructure/persistence/identity.migrations.js';
import {
  type IdentitySchema,
  identitySchema,
} from '../src/infrastructure/persistence/identity.schema.js';

/** The one permission the int harness grants every principal: `elevated()` asks for it. */
export const TEST_ELEVATION_PERMISSION = 'identity-int:elevate';

/** `RlsElevation.elevate` asks `PrincipalPermissions` (bound by `RbacModule.forRoot()` in the apps). */
@Global()
@Module({
  providers: [
    {
      provide: PrincipalPermissions,
      useValue: { of: () => [TEST_ELEVATION_PERMISSION] } satisfies PrincipalPermissions,
    },
  ],
  exports: [PrincipalPermissions],
})
class TestPrincipalPermissionsModule {}

export interface IdentityDatabase {
  readonly app: INestApplicationContext;
  /** The runtime handle (`DRIZZLE`): `app_runtime`, NOBYPASSRLS, under the identity policies. */
  readonly db: DrizzleDB<IdentitySchema>;
  /** The superuser on its own client: seeding and "what is really there" checks only. */
  readonly admin: DrizzleDB<IdentitySchema>;
  /**
   * The superuser as raw postgres.js, on a client drizzle never wrapped (drizzle replaces a
   * client's Date serializers, which raw tagged-template inserts need).
   */
  readonly adminSql: Sql;
  readonly pg: RlsTestPostgres;
  /**
   * `work` as `principal` in ONE runtime unit of work that first turns `app.elevated` on through the
   * real `RlsElevation.elevate` (the repositories join it through `inUnitOfWork`).
   */
  elevated<T>(principal: Principal, work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * A fresh Citus 14.2 database with the three roles (`startRlsTestPostgres`, local execution off by
 * default: every shard statement runs over a remote connection, as on a cluster). The real
 * `DatabaseModule` migrates as `app_owner` (`DATABASE_MIGRATION_URL`), runs as `app_runtime`
 * (`DATABASE_URL`) and opens the system pool as `app_system` (`DATABASE_SYSTEM_URL`); `admin`
 * seeds through the superuser `url`. `providers` (repositories under test) and `imports` sit on top.
 * `testPermissions: false` leaves `PrincipalPermissions` to an import (`RbacModule.forRoot()`, as the
 * apps bind it); `elevated()` then needs a principal the real RBAC grants `TEST_ELEVATION_PERMISSION`
 * to, so it is for the default harness only. Int specs only.
 */
export async function startIdentityDatabase(
  providers: Provider[],
  options: {
    localExecution?: boolean;
    imports?: (Type | DynamicModule)[];
    testPermissions?: boolean;
  } = {},
): Promise<IdentityDatabase> {
  const pg = await startRlsTestPostgres({ localExecution: options.localExecution ?? false });
  vi.stubEnv('DATABASE_URL', pg.runtimeUrl);
  vi.stubEnv('DATABASE_MIGRATION_URL', pg.migrationUrl);
  vi.stubEnv('DATABASE_SYSTEM_URL', pg.systemUrl);
  vi.stubEnv('SERVICE_NAME', 'identity-int');
  // Two clients: drizzle replaces the Date serializers of the client it wraps.
  const adminClient = postgres(pg.url, { max: 2, onnotice: () => undefined });
  const adminSql = postgres(pg.url, { max: 2, onnotice: () => undefined });

  @Module({
    imports: [
      AppConfigModule.forRoot(),
      ClsModule.forRoot({ global: true }),
      ...(options.testPermissions === false ? [] : [TestPrincipalPermissionsModule]),
      DatabaseModule.forRootAsync({
        schema: identitySchema,
        migrations: [identityMigrations],
        runMigrations: true,
      }),
      ...(options.imports ?? []),
    ],
    providers,
  })
  class IdentityIntModule {}

  const cleanup = async (): Promise<void> => {
    await adminClient.end({ timeout: 5 });
    await adminSql.end({ timeout: 5 });
    await pg.stop();
    vi.unstubAllEnvs();
  };

  try {
    const app = await NestFactory.createApplicationContext(IdentityIntModule, {
      logger: false,
      abortOnError: false,
    });
    const txHost =
      app.get<TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>>(TransactionHost);
    const elevation = app.get(RlsElevation);
    return {
      app,
      db: app.get<DrizzleDB<IdentitySchema>>(DRIZZLE),
      admin: drizzle({ client: adminClient, schema: identitySchema, casing: 'snake_case' }),
      adminSql,
      pg,
      elevated: (principal, work) =>
        runWithPrincipal(principal, () =>
          txHost.withTransaction(async () => {
            await elevation.elevate(TEST_ELEVATION_PERMISSION);
            return work();
          }),
        ),
      close: async () => {
        await app.close();
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
