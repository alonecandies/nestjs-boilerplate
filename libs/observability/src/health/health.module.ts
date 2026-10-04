import { type AppConfig, appConfig } from '@app/config';
import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HEALTH_OPTIONS } from '../observability.constants.js';
import { HealthController } from './health.controller.js';
import type { ResolvedHealthOptions } from './health.types.js';
import type { HealthContributor } from './health-contributor.js';
import { HealthContributorRegistry } from './health-contributor.registry.js';

export interface HealthModuleOptions {
  contributors: readonly Type<HealthContributor>[];
  readinessTimeoutMs: number;
  /** Time readiness reports `shutting_down` (503) before Nest closes the server; lets LBs drain. */
  shutdownDrainMs: number;
  /** Default: `!app.isProduction` (false when `appConfig` is not loaded). */
  exposeDetails?: boolean;
}

/** Terminus + `/health/live` + `/health/ready` (internal to `ObservabilityModule`). */
@Module({})
export class HealthModule {
  static register(options: HealthModuleOptions): DynamicModule {
    return {
      module: HealthModule,
      imports: [
        TerminusModule.forRoot({
          errorLogStyle: 'json',
          gracefulShutdownTimeoutMs: options.shutdownDrainMs,
        }),
      ],
      controllers: [HealthController],
      providers: [
        {
          provide: HEALTH_OPTIONS,
          inject: [{ token: appConfig.KEY, optional: true }],
          useFactory: (app: AppConfig | undefined): ResolvedHealthOptions => ({
            contributors: options.contributors,
            readinessTimeoutMs: options.readinessTimeoutMs,
            exposeDetails: options.exposeDetails ?? (app !== undefined && !app.isProduction),
          }),
        },
        HealthContributorRegistry,
      ],
      // Terminus' HealthIndicatorService for contributors declared in other modules.
      exports: [TerminusModule, HealthContributorRegistry],
    };
  }
}
