import type { FastifyHelmetOptions } from '@fastify/helmet';
import type { AppConfig } from '@platform/config';

/**
 * Global helmet settings. The API serves JSON, so production gets the strictest CSP (nothing may be
 * loaded, nothing may frame it); development allows same-origin resources. The pages that need more
 * set their own route-level CSP in every environment: `/docs` (Scalar) and, while
 * `GRAPHQL_SANDBOX` is on, the Apollo Sandbox at `GET /graphql` (`SandboxCspHook`).
 */
export function defaultHelmetOptions(
  config: Pick<AppConfig, 'isProduction'>,
): FastifyHelmetOptions {
  if (config.isProduction) {
    return {
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
    };
  }
  return {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] },
    },
  };
}

/**
 * Route-level CSP of the Scalar API reference (`GET /docs`): it loads its bundle and fonts from
 * jsDelivr / Google Fonts and runs an inline init script.
 */
export const DOCS_CONTENT_SECURITY_POLICY = {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
    styleSrc: [
      "'self'",
      "'unsafe-inline'",
      'https://cdn.jsdelivr.net',
      'https://fonts.googleapis.com',
    ],
    fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'", 'https:'],
    workerSrc: ["'self'", 'blob:'],
  },
} as const;
