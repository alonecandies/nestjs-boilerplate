import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import type { BuildSchemaOptions } from '@nestjs/graphql';
import type { AppConfig, GraphqlConfig } from '@platform/config';
import { createClientIpResolver } from '@platform/redis';
import { type DocumentNode, parse } from 'graphql';
import type { GraphqlWsAuthHandlers } from './auth/subscription-auth.js';
import { isWsContext } from './context/gql-context.js';
import {
  buildWsRequest,
  createGraphqlContext,
  createGraphqlWsConnectionSignals,
} from './context/graphql-context.factory.js';
import { formatExecutionResult, formatGraphqlError } from './errors/format-graphql-error.js';
import type { DataLoaderRegistry } from './loaders/data-loader.registry.js';
import { GRAPHQL_SCALAR_RESOLVERS } from './scalars/index.js';
import type { SubscriptionGuardRef } from './subscriptions/subscription-guard.js';

/** graphql-ws clients must send `connection_init` within this window, or the socket is closed. */
export const GRAPHQL_WS_INIT_TIMEOUT_MS = 10_000;

export interface ApolloConfigDeps {
  graphql: GraphqlConfig;
  app: AppConfig;
  loaders: DataLoaderRegistry;
  wsAuth: GraphqlWsAuthHandlers;
  buildSchemaOptions?: BuildSchemaOptions | undefined;
  /** Filled at bootstrap with the graphql-ws complexity + cost check (C-6); unset → no check. */
  subscriptionGuard?: SubscriptionGuardRef | undefined;
}

/**
 * The Apollo driver options, as a pure function of config, so the effective configuration is
 * testable without booting Nest:
 * - **Sandbox** (`GRAPHQL_SANDBOX`, default outside production) uses Apollo Sandbox instead of
 *   Nest's default GraphiQL page. Otherwise there is no landing page at all: GET /graphql without
 *   a query returns 400, and no Apollo CDN assets are served.
 * - **CSRF prevention**: GET or simple requests need `content-type: application/json` or the
 *   `apollo-require-preflight` header.
 * - **Introspection** follows `GRAPHQL_INTROSPECTION`.
 * - **Schema**: code-first, written to `GRAPHQL_SCHEMA_FILE` when set, else kept in memory
 *   (containers usually have read-only filesystems).
 * - **Subscriptions**: graphql-ws on the same path, authenticated once per connection.
 * - **Context**: a fresh set of DataLoaders per operation; over graphql-ws also the connection's
 *   `connectionSignal`, aborted when its socket closes.
 * - **Errors**: `formatGraphqlError`, for HTTP results and for subscription events (graphql-ws
 *   `onNext`). Internal details are hidden in production.
 */
export function createApolloDriverConfig(deps: ApolloConfigDeps): ApolloDriverConfig {
  const { graphql, app, loaders, wsAuth } = deps;
  const exposeInternal = !app.isProduction;
  const formatError = formatGraphqlError({ exposeInternal });
  const clientIp = createClientIpResolver(app.trustProxy);
  const connections = createGraphqlWsConnectionSignals();
  return {
    path: graphql.path,
    autoSchemaFile: graphql.schemaFile ?? true,
    sortSchema: true,
    buildSchemaOptions: { dateScalarMode: 'isoDate', ...deps.buildSchemaOptions },
    introspection: graphql.introspection,
    graphiql: false,
    plugins: graphql.sandbox
      ? [ApolloServerPluginLandingPageLocalDefault({ embed: true, includeCookies: false })]
      : [],
    csrfPrevention: true,
    cache: 'bounded',
    includeStacktraceInErrorResponses: exposeInternal,
    formatError,
    resolvers: { ...GRAPHQL_SCALAR_RESOLVERS },
    // Scalars that no field uses must not fail boot ("UUID defined in resolvers, but not in schema").
    resolverValidationOptions: { requireResolversToMatchSchema: 'ignore' },
    context: createGraphqlContext(loaders, clientIp, connections),
    subscriptions: {
      'graphql-ws': {
        path: graphql.path,
        connectionInitWaitTimeout: GRAPHQL_WS_INIT_TIMEOUT_MS,
        // Nest types `ctx.extra` as unknown; graphql-ws/use/ws supplies `{ socket, request }`.
        onConnect: (ctx) => {
          if (!isWsContext(ctx)) return false;
          connections.open(ctx);
          return wsAuth.onConnect(ctx);
        },
        onClose: (ctx) => {
          if (!isWsContext(ctx)) return;
          connections.close(ctx);
          wsAuth.onClose(ctx);
        },
        // Apollo plugins never see graphql-ws operations: run the same complexity check and the
        // per-operation cost budget here. Returning errors rejects the subscription.
        onSubscribe: async (ctx, _id, payload) => {
          if (!isWsContext(ctx) || deps.subscriptionGuard === undefined) return undefined;
          let document: DocumentNode;
          try {
            document = parse(payload.query);
          } catch {
            return undefined; // graphql-ws reports the syntax error itself
          }
          const req = buildWsRequest(ctx, clientIp);
          return deps.subscriptionGuard.run({
            document,
            operationName: payload.operationName,
            variables: payload.variables ?? undefined,
            user: req.user,
            ip: req.ip,
          });
        },
        // Same error format (and internals hiding) for subscription events as for HTTP.
        onNext: (_ctx, _id, _payload, _args, result) => formatExecutionResult(result, formatError),
      },
    },
  };
}
