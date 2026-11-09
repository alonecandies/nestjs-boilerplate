import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { type RateLimitPolicy, RateLimitPolicyRegistry } from './rate-limit-policy.js';

export interface RateLimitFeatureOptions {
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  /** Receives the `inject`ed values; returns the domain's policies (limits from its config). */
  useFactory: (...deps: never[]) => readonly RateLimitPolicy[];
}

let featureSequence = 0;

/**
 * How a domain declares its named policies:
 * `RateLimitModule.forFeature({ imports: [ConfigModule.forFeature(cfg)], inject: [cfg.KEY], useFactory })`.
 * The registry is optional so domain modules still compose in tests without `AppThrottlerModule`
 * (then nothing is throttled anyway).
 */
@Module({})
export class RateLimitModule {
  static forFeature(options: RateLimitFeatureOptions): DynamicModule {
    featureSequence += 1;
    const token = `RATE_LIMIT_FEATURE_${featureSequence}`;
    return {
      module: RateLimitModule,
      imports: [...(options.imports ?? [])],
      providers: [
        {
          provide: token,
          inject: [{ token: RateLimitPolicyRegistry, optional: true }, ...(options.inject ?? [])],
          useFactory: (registry: RateLimitPolicyRegistry | undefined, ...deps: unknown[]): true => {
            const policies = Reflect.apply(
              options.useFactory,
              undefined,
              deps,
            ) as readonly RateLimitPolicy[];
            registry?.register(policies);
            return true;
          },
        },
      ],
    };
  }
}
