import { Inject, Injectable, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import {
  type GraphqlConfig,
  graphqlConfig,
  type ThrottleConfig,
  throttleConfig,
} from '@platform/config';
import { RateLimitCharger, THROTTLER } from '@platform/redis';
import { type DocumentNode, GraphQLError, type GraphQLSchema } from 'graphql';
import {
  isIntrospectionOnly,
  measureComplexity,
  QUERY_TOO_COMPLEX,
} from '../plugins/complexity.plugin.js';
import { GRAPHQL_RATE_LIMITED } from '../plugins/operation-rate-limit.plugin.js';

export interface SubscriptionCheckInput {
  document: DocumentNode;
  operationName?: string | null | undefined;
  variables?: Record<string, unknown> | undefined;
  user: unknown;
  ip: string | undefined;
}

export type SubscriptionCheck = (
  input: SubscriptionCheckInput,
) => Promise<readonly GraphQLError[] | undefined>;

/** Filled at bootstrap (the schema exists only then); unbound → every subscription passes. */
export class SubscriptionGuardRef {
  private check: SubscriptionCheck | undefined;

  bind(check: SubscriptionCheck): void {
    this.check = check;
  }

  async run(input: SubscriptionCheckInput): Promise<readonly GraphQLError[] | undefined> {
    return this.check === undefined ? undefined : this.check(input);
  }
}

/** The graphql-ws twin of ComplexityPlugin + OperationRateLimitPlugin (one charge per subscribe). */
export function createSubscriptionCheck(deps: {
  schema: () => GraphQLSchema;
  maxComplexity: number;
  costLimit: number;
  costTtlMs: number;
  charger: RateLimitCharger | undefined;
}): SubscriptionCheck {
  return async (input) => {
    if (isIntrospectionOnly(input.document, input.operationName)) return undefined;
    const complexity = measureComplexity({
      schema: deps.schema(),
      document: input.document,
      operationName: input.operationName,
      variables: input.variables,
    });
    if (complexity !== undefined && complexity > deps.maxComplexity) {
      return [
        new GraphQLError(
          `Query is too complex: ${complexity}. Maximum allowed: ${deps.maxComplexity}`,
          {
            extensions: { code: QUERY_TOO_COMPLEX, complexity, maxComplexity: deps.maxComplexity },
          },
        ),
      ];
    }
    if (deps.charger === undefined) return undefined;
    // The same tracker as the HTTP plugin: user id, else the client IP (IPv6 collapsed to its subnet).
    const { record } = await deps.charger.charge(
      {
        throttler: THROTTLER.GRAPHQL,
        scope: 'cost',
        tracker: deps.charger.trackerFor(input.user, input.ip),
        limit: deps.costLimit,
        ttlMs: deps.costTtlMs,
        blockMs: deps.costTtlMs,
      },
      Math.max(1, complexity ?? 1),
    );
    if (!record.isBlocked) return undefined;
    return [
      new GraphQLError('Too many requests. Please retry later.', {
        extensions: {
          code: GRAPHQL_RATE_LIMITED,
          status: 429,
          retryAfterSeconds: record.timeToBlockExpire,
        },
      }),
    ];
  };
}

@Injectable()
export class SubscriptionGuardBinder implements OnApplicationBootstrap {
  constructor(
    private readonly ref: SubscriptionGuardRef,
    private readonly schemaHost: GraphQLSchemaHost,
    @Inject(graphqlConfig.KEY) private readonly graphql: GraphqlConfig,
    @Inject(throttleConfig.KEY) private readonly limits: ThrottleConfig,
    // Explicit token: a `T | undefined` parameter type is emitted as `Object` in design:paramtypes.
    @Optional() @Inject(RateLimitCharger) private readonly charger?: RateLimitCharger,
  ) {}

  onApplicationBootstrap(): void {
    this.ref.bind(
      createSubscriptionCheck({
        schema: () => this.schemaHost.schema,
        maxComplexity: this.graphql.maxComplexity,
        costLimit: this.limits.graphqlCostLimit,
        costTtlMs: this.limits.graphqlTtlMs,
        charger: this.charger,
      }),
    );
  }
}
