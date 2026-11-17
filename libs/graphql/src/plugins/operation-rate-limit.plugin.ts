import type { ApolloServerPlugin, BaseContext, GraphQLRequestListener } from '@apollo/server';
import { Plugin } from '@nestjs/apollo';
import { Inject, Optional } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { AccessTokenDenylist, rememberVerifiedUser, TokenService } from '@platform/auth';
import { getHeaderValue } from '@platform/common';
import { type ThrottleConfig, throttleConfig } from '@platform/config';
import {
  authenticatedUserId,
  collectDecision,
  formatRateLimit,
  formatRateLimitPolicy,
  RateLimitCharger,
  THROTTLER,
} from '@platform/redis';
import { GraphQLError } from 'graphql';
import {
  createSubscriptionAuthenticator,
  type SubscriptionAuthenticator,
} from '../auth/subscription-auth.js';
import { isIntrospectionOnly, measureComplexity } from './complexity.plugin.js';

export const GRAPHQL_RATE_LIMITED = 'RATE_LIMITED';

interface GqlRequestLike {
  user?: unknown;
  ip?: unknown;
  headers?: Readonly<Record<string, string | string[] | undefined>>;
}

const BEARER = /^\s*bearer\s+(\S+)\s*$/i;

/** The Fastify reply in the GraphQL context (`{ req, reply }`, built by createGraphqlContext). */
interface HeaderReply {
  header(name: string, value: string): unknown;
}

/**
 * Per-OPERATION GraphQL limiting (spec §11): one charge per operation on the `graphql` cost budget
 * (`THROTTLE_GRAPHQL_COST_LIMIT` per `THROTTLE_GRAPHQL_TTL_MS`, per user, else per client IP), weighted
 * by the operation's complexity (the same estimators as `ComplexityPlugin`, minimum 1). A fully
 * limited operation fails BEFORE any resolver runs with HTTP 429, `extensions.code: RATE_LIMITED`,
 * `Retry-After` and the IETF headers. Introspection-only operations are exempt.
 *
 * Over HTTP this hook runs before `JwtAuthGuard` (it authenticates per resolver), so `req.user` is
 * not set yet: the bearer token is verified here with the checks of `JwtStrategy` (signature, iss,
 * aud, exp, typ, denylist) to key the budget by user. A missing or invalid token is charged to the
 * client IP (IPv6 collapsed to its subnet, like the guards); the guard then rejects it as usual.
 * A `req.user` that is already set is used as is. The user verified here is remembered for the
 * request (`rememberVerifiedUser`), and `JwtAuthGuard` reuses it, so each HTTP operation verifies
 * its token and reads the denylist once.
 */
@Plugin()
export class OperationRateLimitPlugin implements ApolloServerPlugin<BaseContext> {
  private readonly authenticate: SubscriptionAuthenticator;

  constructor(
    private readonly schemaHost: GraphQLSchemaHost,
    @Inject(throttleConfig.KEY) private readonly limits: ThrottleConfig,
    tokens: TokenService,
    denylist: AccessTokenDenylist,
    // Explicit token: a `T | undefined` parameter type is emitted as `Object` in design:paramtypes.
    @Optional() @Inject(RateLimitCharger) private readonly charger?: RateLimitCharger,
  ) {
    this.authenticate = createSubscriptionAuthenticator(tokens, denylist);
  }

  /** The principal to charge: `req.user`, else the verified bearer token, else none (IP). */
  private async principalOf(req: GqlRequestLike): Promise<unknown> {
    if (authenticatedUserId(req.user) !== undefined) return req.user;
    const token = BEARER.exec(getHeaderValue(req.headers, 'authorization') ?? '')?.[1];
    if (token === undefined) return undefined;
    try {
      const user = await this.authenticate(token);
      // JwtAuthGuard runs next for the same request: hand it the verified user so the JWT is not
      // verified and the denylist not read a second time for this operation.
      rememberVerifiedUser(req, user);
      return user;
    } catch {
      // Invalid, expired or revoked (or the denylist is unreachable): JwtAuthGuard answers it.
      return undefined;
    }
  }

  async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
    const charger = this.charger;
    if (charger === undefined) return {};
    const schema = this.schemaHost.schema;
    const { graphqlCostLimit, graphqlTtlMs } = this.limits;
    const principalOf = (req: GqlRequestLike) => this.principalOf(req);
    return {
      async didResolveOperation({ request, document, contextValue }) {
        if (isIntrospectionOnly(document, request.operationName)) return;
        const cost = measureComplexity({
          schema,
          document,
          operationName: request.operationName,
          variables: request.variables,
        });
        const ctx = contextValue as { req?: GqlRequestLike; reply?: HeaderReply };
        const req = ctx.req ?? {};
        const tracker = charger.trackerFor(await principalOf(req), req.ip);
        const { record, decision } = await charger.charge(
          {
            throttler: THROTTLER.GRAPHQL,
            scope: 'cost',
            tracker,
            limit: graphqlCostLimit,
            ttlMs: graphqlTtlMs,
            blockMs: graphqlTtlMs,
          },
          Math.max(1, cost ?? 1),
        );
        // Same per-response list as the guards (they key on the Fastify reply), so one
        // RateLimit-Policy / RateLimit pair lists ip, user, tenant AND graphql:cost.
        if (ctx.reply !== undefined) {
          const all = collectDecision(ctx.reply, decision);
          ctx.reply.header('ratelimit-policy', formatRateLimitPolicy(all));
          ctx.reply.header('ratelimit', formatRateLimit(all));
        }
        if (!record.isBlocked) return;
        const retry = new Map<string, string>([['retry-after', String(record.timeToBlockExpire)]]);
        ctx.reply?.header('retry-after', String(record.timeToBlockExpire));
        throw new GraphQLError('Too many requests. Please retry later.', {
          extensions: {
            code: GRAPHQL_RATE_LIMITED,
            status: 429,
            http: { status: 429, headers: retry },
          },
        });
      },
    };
  }
}
