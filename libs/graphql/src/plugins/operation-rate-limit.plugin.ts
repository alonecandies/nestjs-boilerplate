import type { ApolloServerPlugin, BaseContext, GraphQLRequestListener } from '@apollo/server';
import { Plugin } from '@nestjs/apollo';
import { Inject, Optional } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
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
import { isIntrospectionOnly, measureComplexity } from './complexity.plugin.js';

export const GRAPHQL_RATE_LIMITED = 'RATE_LIMITED';

interface GqlRequestLike {
  user?: unknown;
  ip?: unknown;
}

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
 */
@Plugin()
export class OperationRateLimitPlugin implements ApolloServerPlugin<BaseContext> {
  constructor(
    private readonly schemaHost: GraphQLSchemaHost,
    @Inject(throttleConfig.KEY) private readonly limits: ThrottleConfig,
    // Explicit token: a `T | undefined` parameter type is emitted as `Object` in design:paramtypes.
    @Optional() @Inject(RateLimitCharger) private readonly charger?: RateLimitCharger,
  ) {}

  async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
    const charger = this.charger;
    if (charger === undefined) return {};
    const schema = this.schemaHost.schema;
    const { graphqlCostLimit, graphqlTtlMs } = this.limits;
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
        const userId = authenticatedUserId(req.user);
        const tracker = userId
          ? `user:${userId}`
          : `ip:${typeof req.ip === 'string' ? req.ip : 'unknown'}`;
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
