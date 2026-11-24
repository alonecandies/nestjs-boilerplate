import type { z } from 'zod';

/**
 * Shared checks for the `NODE_ENV=production` guards of the config namespaces. Every guard has an
 * explicit opt-out flag that only the local docker-compose stack sets (it runs in production mode
 * on purpose, with known credentials and plaintext infra).
 */

/**
 * Values that are public in this repository (the dev defaults, the docker-compose fallbacks, the
 * local RustFS keys) or that are obviously placeholders, including the docs' fill-me-in forms
 * (`whsec_...`, `<random>`).
 */
const KNOWN_LOCAL_SECRET =
  /placeholder|change[-_]?me|not[-_]for[-_]production|compose[-_]local|^rustfsadmin$|\.\.\.|…|<[^>]*>/i;

/** True for a secret that anyone who has read this repository knows. */
export function isKnownLocalSecret(value: string | undefined): boolean {
  return value !== undefined && KNOWN_LOCAL_SECRET.test(value);
}

/**
 * Adds the one issue every namespace raises for a publicly known secret (never echoes the value).
 * `subject` names the value when it is part of `key` (`JWT_ACCESS_VERIFY_SECRETS entry 2`).
 */
export function addKnownLocalSecretIssue(
  ctx: z.RefinementCtx,
  key: string,
  subject: string = key,
): void {
  ctx.addIssue({
    code: 'custom',
    path: [key],
    message: `${subject} is a publicly known value (a docker-compose fallback, the local RustFS key or a placeholder): set a real value in production, or ALLOW_KNOWN_LOCAL_SECRETS=true for the local compose stack only`,
  });
}

/** `new URL()` without throwing (values reaching a guard were already validated by `zUrl`). */
export function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * The hostname as a client resolves it: WHATWG URL parsing expands IPv4 shorthands (`127.1`,
 * `2130706433`, `0x7f000001`), lowercases, and normalises IPv6; brackets and a trailing dot go.
 */
function canonicalHost(raw: string): string | undefined {
  const bare = raw.trim().replace(/^\[(.*)\]$/, '$1');
  const host = parseUrl(`http://${bare.includes(':') ? `[${bare}]` : bare}`)?.hostname;
  return host?.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;
/** 127.0.0.0/8 mapped into IPv6 (`::ffff:127.0.0.1` normalises to `::ffff:7f00:1`). */
const IPV4_MAPPED_LOOPBACK = /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/;

/**
 * `localhost` and `*.localhost`, 127.0.0.0/8 (any spelling, IPv4-mapped too), `::1`, and the
 * unspecified addresses `0.0.0.0` / `::` (which reach this machine): never a production peer.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  if (host === undefined) return false;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    IPV4_LOOPBACK.test(host) ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    IPV4_MAPPED_LOOPBACK.test(host)
  );
}

/** https on a routable (non-loopback) host. */
export function isPublicHttpsUrl(value: string): boolean {
  const url = parseUrl(value);
  return url?.protocol === 'https:' && !isLoopbackHost(url.hostname);
}

/** `googleapis.com` or one of its subdomains, on a dot boundary (not `evilgoogleapis.com`). */
export function isGoogleApisHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  return host === 'googleapis.com' || (host?.endsWith('.googleapis.com') ?? false);
}
