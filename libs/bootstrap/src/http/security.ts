import type { AppConfig } from '@app/config';
import type { FastifyHelmetOptions } from '@fastify/helmet';

/**
 * Global helmet settings. The API serves JSON, so production gets the strictest CSP (nothing may be
 * loaded, nothing may frame it). Development additionally allows the Apollo Sandbox that the
 * GraphQL module serves at `GET /graphql` (research nest-http §12). The docs page (`/docs`) sets its
 * own route-level CSP either way.
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
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://embeddable-sandbox.cdn.apollographql.com',
        ],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        frameSrc: ["'self'", 'https://sandbox.embed.apollographql.com'],
        manifestSrc: ["'self'", 'https://apollo-server-landing-page.cdn.apollographql.com'],
        connectSrc: ["'self'", 'https:', 'wss:'],
      },
    },
    // The embedded sandbox iframe is cross-origin.
    crossOriginEmbedderPolicy: false,
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
