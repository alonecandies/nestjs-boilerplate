/** Lockout buckets charged on a request, reset by `LockoutResetInterceptor` when it succeeds. */
const attempts = new WeakMap<object, Set<string>>();

export function markLockoutAttempt(request: object, key: string): void {
  const keys = attempts.get(request) ?? new Set<string>();
  keys.add(key);
  attempts.set(request, keys);
}

export function takeLockoutAttempts(request: object): string[] | undefined {
  const keys = attempts.get(request);
  attempts.delete(request);
  return keys === undefined ? undefined : [...keys];
}
