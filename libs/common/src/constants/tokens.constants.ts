/**
 * DI tokens for the cross-cutting enhancers. `@app/common` must not depend on `@app/config`, so the
 * values are provided by the app (see `provideCommonEnhancers` / `provideCommonEnhancersAsync`).
 * Every consumer injects them with `@Optional()` and falls back to a safe default.
 */

/** `ExceptionsFilterOptions` for `AllExceptionsFilter` (default `{ exposeInternal: false }`). */
export const EXCEPTIONS_FILTER_OPTIONS = Symbol('EXCEPTIONS_FILTER_OPTIONS');

/** `number` — default per-request timeout (ms) for `TimeoutInterceptor` (default 30 000; `0` disables). */
export const DEFAULT_TIMEOUT_MS = Symbol('DEFAULT_TIMEOUT_MS');

/** `boolean | (() => boolean)` — maintenance switch for `MaintenanceModeMiddleware` (default `false`). */
export const MAINTENANCE_MODE = Symbol('MAINTENANCE_MODE');

/** `Partial<MaintenanceModeOptions>` — Retry-After and bypass paths for `MaintenanceModeMiddleware`. */
export const MAINTENANCE_MODE_OPTIONS = Symbol('MAINTENANCE_MODE_OPTIONS');

/** `CommonEnhancersOptions` — the raw options object the other tokens are derived from. */
export const COMMON_ENHANCERS_OPTIONS = Symbol('COMMON_ENHANCERS_OPTIONS');

/** Fallback used when `DEFAULT_TIMEOUT_MS` is not provided. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
