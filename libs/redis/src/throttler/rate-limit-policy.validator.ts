import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import { RATE_LIMIT_POLICY_KEY } from './throttle.constants.js';

/**
 * `@nestjs/throttler` stores `@Throttle({ <name>: { limit, ttl } })` under `THROTTLER:LIMIT<name>` and
 * `THROTTLER:TTL<name>` (its constants are not exported).
 */
const THROTTLE_OVERRIDE_PREFIXES: readonly string[] = ['THROTTLER:LIMIT', 'THROTTLER:TTL'];

const carriesThrottleOverride = (target: object): boolean =>
  Reflect.getMetadataKeys(target).some(
    (key: unknown) =>
      typeof key === 'string' &&
      THROTTLE_OVERRIDE_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );

/**
 * Fails boot when a controller, resolver or gateway names a policy nobody registered, so a typo
 * can't turn into a 500 on the first request (or silently skip a limit). It also refuses a
 * `@Throttle()` override: the global buckets are shared by every route, so a per-route limit would
 * rewrite them for all routes instead of limiting one.
 */
@Injectable()
export class RateLimitPolicyValidator implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly registry: RateLimitPolicyRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const unknown = new Set<string>();
    const overrides = new Set<string>();
    const check = (name: string | undefined): void => {
      if (name !== undefined && this.registry.get(name) === undefined) unknown.add(name);
    };
    for (const wrapper of [...this.discovery.getControllers(), ...this.discovery.getProviders()]) {
      const instance: unknown = wrapper.instance;
      const metatype = wrapper.metatype;
      if (typeof instance !== 'object' || instance === null || !metatype) continue;
      check(this.reflector.get<string | undefined>(RATE_LIMIT_POLICY_KEY, metatype));
      if (carriesThrottleOverride(metatype)) overrides.add(metatype.name);
      const prototype: object = Object.getPrototypeOf(instance) as object;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler: unknown = Reflect.get(prototype, method);
        if (typeof handler === 'function') {
          check(this.reflector.get<string | undefined>(RATE_LIMIT_POLICY_KEY, handler));
          if (carriesThrottleOverride(handler)) overrides.add(`${metatype.name}.${method}`);
        }
      }
    }
    if (overrides.size > 0) {
      throw new Error(
        `@Throttle overrides are not supported: ${[...overrides].sort().join(', ')}. ` +
          'Declare a policy with RateLimitModule.forFeature() and use @RateLimit.',
      );
    }
    if (unknown.size > 0) {
      throw new Error(
        `@RateLimit names unregistered policies: ${[...unknown].sort().join(', ')}. ` +
          'Register them with RateLimitModule.forFeature().',
      );
    }
  }
}
