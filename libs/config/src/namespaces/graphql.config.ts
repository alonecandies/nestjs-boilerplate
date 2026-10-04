import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zNodeEnv, zStr } from '../env/env.helpers.js';

export const graphqlEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    GRAPHQL_PATH: zStr('/graphql', {
      pattern: /^\/[A-Za-z0-9/_-]*$/,
      patternMessage: 'Expected an absolute path',
    }),
    GRAPHQL_SANDBOX: zBool(),
    GRAPHQL_INTROSPECTION: zBool(),
    GRAPHQL_MAX_COMPLEXITY: zInt(250, { min: 1 }),
    GRAPHQL_SCHEMA_FILE: zStr(),
  })
  .transform((env) => {
    const notProduction = env.NODE_ENV !== 'production';
    return {
      path: env.GRAPHQL_PATH,
      /** Apollo Sandbox landing page (dev tooling; loads assets from Apollo's CDN). */
      sandbox: env.GRAPHQL_SANDBOX ?? notProduction,
      /** Schema introspection — off in production to reduce the attack surface. */
      introspection: env.GRAPHQL_INTROSPECTION ?? notProduction,
      maxComplexity: env.GRAPHQL_MAX_COMPLEXITY,
      /** When set, the code-first schema is also written to this file (else kept in memory). */
      schemaFile: env.GRAPHQL_SCHEMA_FILE,
    };
  });

/** GraphQL (Apollo on Fastify): path, dev tooling, query complexity. */
export const graphqlConfig = defineConfigNamespace('graphql', graphqlEnvSchema);
export type GraphqlConfig = ConfigType<typeof graphqlConfig>;
