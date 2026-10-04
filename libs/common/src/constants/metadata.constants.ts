/** Route metadata: the route skips authentication (read by `JwtAuthGuard` in `@app/auth`, throttler skip lists). */
export const IS_PUBLIC_KEY = 'app:isPublic';

/** Route metadata: per-route timeout in ms (read by `TimeoutInterceptor`). */
export const TIMEOUT_KEY = 'app:timeout';
