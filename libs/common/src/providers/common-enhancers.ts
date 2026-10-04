import type {
  FactoryProvider,
  InjectionToken,
  OptionalFactoryDependency,
  Provider,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import {
  COMMON_ENHANCERS_OPTIONS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  EXCEPTIONS_FILTER_OPTIONS,
  MAINTENANCE_MODE,
  MAINTENANCE_MODE_OPTIONS,
} from '../constants/tokens.constants.js';
import {
  AllExceptionsFilter,
  type ExceptionsFilterOptions,
} from '../filters/all-exceptions.filter.js';
import { TimeoutInterceptor } from '../interceptors/timeout.interceptor.js';
import type {
  MaintenanceModeOptions,
  MaintenanceModeSwitch,
} from '../middlewares/maintenance-mode.middleware.js';
import { createStandardSchemaValidationPipe, createValidationPipe } from '../pipes/validation.js';

export interface CommonEnhancersOptions {
  /** Default request timeout for HTTP/GraphQL handlers (ms; `0` disables). Default 30 000. */
  defaultTimeoutMs?: number;
  /** Reveal unexpected error messages in problem responses. Default `false` — keep it off in prod. */
  exposeInternalErrors?: boolean;
  /** Problem `type` base URI. */
  problemTypeBaseUrl?: string;
  /** Maintenance switch read by `MaintenanceModeMiddleware`. Default `false`. */
  maintenanceMode?: MaintenanceModeSwitch;
  maintenanceModeOptions?: Partial<MaintenanceModeOptions>;
}

export interface CommonEnhancersAsyncOptions {
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  /**
   * Builds the options from injected config, e.g.
   * `{ inject: [appConfig.KEY], useFactory: (app: AppConfig) => ({ exposeInternalErrors: !app.isProduction, … }) }`.
   * (`never[]` params accept any concrete factory signature without `any`.)
   */
  useFactory: (...args: never[]) => CommonEnhancersOptions | Promise<CommonEnhancersOptions>;
}

/**
 * Global enhancers every HTTP app installs (put the result in the root module's `providers`):
 * - APP_PIPE ×2: class-validator (`createValidationPipe`) and Nest 12 Standard Schema (zod);
 *   each is a no-op for parameters the other one owns.
 * - APP_FILTER: `AllExceptionsFilter` (problem+json; transport-aware).
 * - APP_INTERCEPTOR: `TimeoutInterceptor` (http/graphql only).
 * - the option tokens (`EXCEPTIONS_FILTER_OPTIONS`, `DEFAULT_TIMEOUT_MS`, `MAINTENANCE_MODE`,
 *   `MAINTENANCE_MODE_OPTIONS`) — also consumed by `MaintenanceModeMiddleware`, so apply that
 *   middleware in the same module.
 */
export function provideCommonEnhancers(options: CommonEnhancersOptions = {}): Provider[] {
  return buildProviders({ provide: COMMON_ENHANCERS_OPTIONS, useValue: options });
}

/** Same as `provideCommonEnhancers`, with options resolved from DI (typically `appConfig`). */
export function provideCommonEnhancersAsync(options: CommonEnhancersAsyncOptions): Provider[] {
  return buildProviders({
    provide: COMMON_ENHANCERS_OPTIONS,
    // Widening the parameter list is sound here: Nest calls it with the resolved `inject` values.
    useFactory: options.useFactory as (
      ...args: unknown[]
    ) => CommonEnhancersOptions | Promise<CommonEnhancersOptions>,
    inject: options.inject ?? [],
  });
}

function derive<T>(
  provide: InjectionToken,
  pick: (o: CommonEnhancersOptions) => T,
): FactoryProvider<T> {
  return { provide, useFactory: pick, inject: [COMMON_ENHANCERS_OPTIONS] };
}

function buildProviders(optionsProvider: Provider<CommonEnhancersOptions>): Provider[] {
  return [
    optionsProvider,
    derive(
      EXCEPTIONS_FILTER_OPTIONS,
      (o): ExceptionsFilterOptions => ({
        exposeInternal: o.exposeInternalErrors ?? false,
        ...(o.problemTypeBaseUrl === undefined ? {} : { typeBaseUrl: o.problemTypeBaseUrl }),
      }),
    ),
    derive(DEFAULT_TIMEOUT_MS, (o): number => o.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    derive(MAINTENANCE_MODE, (o): MaintenanceModeSwitch => o.maintenanceMode ?? false),
    derive(
      MAINTENANCE_MODE_OPTIONS,
      (o): Partial<MaintenanceModeOptions> => o.maintenanceModeOptions ?? {},
    ),
    // Order matters only for overlapping params, and there are none: class-validator skips
    // `{ schema }` params, the Standard Schema pipe skips params without one.
    { provide: APP_PIPE, useFactory: () => createValidationPipe() },
    { provide: APP_PIPE, useFactory: () => createStandardSchemaValidationPipe() },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
  ];
}
