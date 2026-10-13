import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { type AuthConfig, authConfig } from '@platform/config';
import { JWT_ALGORITHM, JWT_CLOCK_TOLERANCE_SEC } from './auth.constants.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PermissionsGuard } from './guards/permissions.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { AccessTokenDenylist } from './tokens/access-token-denylist.service.js';
import { TokenService } from './tokens/token.service.js';

export interface AuthModuleSetup {
  /**
   * Register `JwtAuthGuard` → `RolesGuard` → `PermissionsGuard` as global guards (in that
   * order). Default `true` (edge apps). gRPC/Kafka-only services pass `false` and use
   * `TokenService` / `AccessTokenDenylist` directly.
   */
  globalGuards?: boolean;
}

/**
 * Verification defaults of the `JwtService` this module registers. This package only verifies, so
 * there are no signing defaults (no `signOptions`): a stray `sign()` through this `JwtService`
 * carries no `iss`/`aud` and never passes `TokenService`. Issuers (the bounded context that owns
 * sessions, with its own `JwtModule`, and `signTestAccessToken`) pass their secret, algorithm,
 * `iss` and `aud` per call.
 */
export function createJwtModuleOptions(config: AuthConfig): JwtModuleOptions {
  return {
    secret: config.accessSecret,
    verifyOptions: {
      algorithms: [JWT_ALGORITHM],
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: JWT_CLOCK_TOLERANCE_SEC,
    },
  };
}

const GLOBAL_GUARDS: Provider[] = [
  // Order matters: authentication sets req.user, then role / permission checks read it.
  { provide: APP_GUARD, useExisting: JwtAuthGuard },
  { provide: APP_GUARD, useExisting: RolesGuard },
  { provide: APP_GUARD, useExisting: PermissionsGuard },
];

/**
 * Global authentication & authorization (blueprint §3.11): access-token verification, the Redis
 * access-token denylist, the passport `jwt` strategy and the RBAC guards.
 * Requires `RedisModule` (global) for the denylist.
 *
 * Import it BEFORE `AppThrottlerModule` so the throttler can track authenticated users by id.
 */
@Module({})
export class AuthModule {
  static forRootAsync(setup: AuthModuleSetup = {}): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      imports: [
        ConfigModule.forFeature(authConfig),
        PassportModule.register({ session: false }),
        JwtModule.registerAsync({
          imports: [ConfigModule.forFeature(authConfig)],
          inject: [authConfig.KEY],
          useFactory: createJwtModuleOptions,
        }),
      ],
      providers: [
        TokenService,
        AccessTokenDenylist,
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        PermissionsGuard,
        ...((setup.globalGuards ?? true) ? GLOBAL_GUARDS : []),
      ],
      exports: [
        TokenService,
        AccessTokenDenylist,
        JwtAuthGuard,
        RolesGuard,
        PermissionsGuard,
        PassportModule,
      ],
    };
  }
}
