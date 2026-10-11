/**
 * Shared checks for the `NODE_ENV=production` guards of the config namespaces. Every guard has an
 * explicit opt-out flag that only the local docker-compose stack sets (it runs in production mode
 * on purpose, with known credentials and plaintext infra).
 */

/**
 * Values that are public in this repository (the dev defaults, the docker-compose fallbacks, the
 * local RustFS keys) or that are obviously placeholders.
 */
const KNOWN_LOCAL_SECRET =
  /placeholder|change[-_]?me|not[-_]for[-_]production|compose[-_]local|^rustfsadmin$/i;

/** True for a secret that anyone who has read this repository knows. */
export function isKnownLocalSecret(value: string | undefined): boolean {
  return value !== undefined && KNOWN_LOCAL_SECRET.test(value);
}

const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;

/** `localhost`, `*.localhost`, 127.0.0.0/8 and `::1` (bracketed or not): never a production peer. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    IPV4_LOOPBACK.test(host)
  );
}

/** `new URL()` without throwing (values reaching a guard were already validated by `zUrl`). */
export function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
