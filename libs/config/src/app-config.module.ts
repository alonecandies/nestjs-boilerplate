import { type DynamicModule, Module } from '@nestjs/common';
import { type ConfigFactory, ConfigModule } from '@nestjs/config';
import { appConfig } from './namespaces/app.config.js';
import { observabilityConfig } from './namespaces/observability.config.js';

export interface AppConfigModuleOptions {
  /** Extra namespaces to load globally (prefer `ConfigModule.forFeature(x)` in the consuming module). */
  load?: ConfigFactory[];
}

/**
 * Root config module (import once in every app's root module).
 *
 * - `ignoreEnvFile: true`: `.env` files are loaded by Node itself (`--env-file-if-exists`) before
 *   any module is evaluated, so there is exactly one source of truth: `process.env`.
 * - Only `app` + `observability` are loaded globally (every process needs them). Each other
 *   namespace is loaded by the module that injects it via `ConfigModule.forFeature(xConfig)`, so a
 *   service only validates — and only fails fast on — the env it actually uses.
 * - `cache: true`: `ConfigService.get` doesn't re-read `process.env` on every call.
 */
@Module({})
export class AppConfigModule {
  static forRoot(options: AppConfigModuleOptions = {}): DynamicModule {
    return {
      module: AppConfigModule,
      global: true,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          ignoreEnvFile: true,
          load: [appConfig, observabilityConfig, ...(options.load ?? [])],
        }),
      ],
    };
  }
}
