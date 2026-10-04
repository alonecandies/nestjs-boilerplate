import type { ApolloServerPlugin, BaseContext, GraphQLRequestListener } from '@apollo/server';
import { type GraphqlConfig, graphqlConfig } from '@app/config';
import { Plugin } from '@nestjs/apollo';
import { Inject } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import {
  type DocumentNode,
  GraphQLError,
  type GraphQLSchema,
  Kind,
  type OperationDefinitionNode,
} from 'graphql';
import {
  type ComplexityEstimator,
  fieldExtensionsEstimator,
  getComplexity,
  simpleEstimator,
} from 'graphql-query-complexity';
import { every, find, startsWith } from 'lodash-es';

/** `extensions.code` of rejected operations. */
export const QUERY_TOO_COMPLEX = 'QUERY_TOO_COMPLEX';

/**
 * Cost model: per-field `complexity` from `@Field`/`@ResolveField`/`@Query` options
 * (`fieldExtensionsEstimator`), otherwise 1 per field. Put costs on `@ResolveField` (a `@Field`
 * complexity is lost when a resolver resolves the property) and on list fields that fan out.
 */
export const COMPLEXITY_ESTIMATORS: readonly ComplexityEstimator[] = Object.freeze([
  fieldExtensionsEstimator(),
  simpleEstimator({ defaultComplexity: 1 }),
]);

function selectedOperation(
  document: DocumentNode,
  operationName: string | null | undefined,
): OperationDefinitionNode | undefined {
  return find(
    document.definitions,
    (d): d is OperationDefinitionNode =>
      d.kind === Kind.OPERATION_DEFINITION && (!operationName || d.name?.value === operationName),
  );
}

/**
 * `true` for operations that only read `__schema` / `__type` / `__typename`. They are exempt:
 * Sandbox's full introspection query alone exceeds typical limits, and introspection is already
 * switched off in production (`GRAPHQL_INTROSPECTION`).
 */
export function isIntrospectionOnly(
  document: DocumentNode,
  operationName?: string | null,
): boolean {
  const operation = selectedOperation(document, operationName);
  if (operation === undefined) return false;
  return every(
    operation.selectionSet.selections,
    (s) => s.kind === Kind.FIELD && startsWith(s.name.value, '__'),
  );
}

/**
 * The operation's cost, or `undefined` when it can't be computed. `getComplexity` coerces
 * variables and throws on invalid ones. Letting that escape `didResolveOperation` would turn a
 * client mistake into an HTTP 500, so execution is left to report the proper `BAD_USER_INPUT`.
 */
export function measureComplexity(input: {
  schema: GraphQLSchema;
  document: DocumentNode;
  operationName?: string | null | undefined;
  variables?: Record<string, unknown> | undefined;
}): number | undefined {
  try {
    return getComplexity({
      schema: input.schema,
      query: input.document,
      ...(input.operationName ? { operationName: input.operationName } : {}),
      variables: input.variables ?? {},
      estimators: [...COMPLEXITY_ESTIMATORS],
    });
  } catch {
    return undefined;
  }
}

/**
 * Rejects operations whose static cost exceeds `GRAPHQL_MAX_COMPLEXITY`, before any resolver runs.
 * This protects against deeply nested or alias-amplified queries that would fan out into
 * thousands of DB/RPC calls. The response is HTTP 400 with `extensions.code: 'QUERY_TOO_COMPLEX'`.
 * Apollo's driver discovers the plugin via `@Plugin()`, so it only has to be a provider.
 */
@Plugin()
export class ComplexityPlugin implements ApolloServerPlugin<BaseContext> {
  private readonly maxComplexity: number;

  constructor(
    private readonly schemaHost: GraphQLSchemaHost,
    @Inject(graphqlConfig.KEY) cfg: GraphqlConfig,
  ) {
    this.maxComplexity = cfg.maxComplexity;
  }

  async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
    // Read per request: the schema host is populated after plugins are constructed.
    const schema = this.schemaHost.schema;
    const max = this.maxComplexity;
    return {
      async didResolveOperation({ request, document }) {
        if (isIntrospectionOnly(document, request.operationName)) return;
        const complexity = measureComplexity({
          schema,
          document,
          operationName: request.operationName,
          variables: request.variables,
        });
        if (complexity === undefined || complexity <= max) return;
        throw new GraphQLError(`Query is too complex: ${complexity}. Maximum allowed: ${max}`, {
          extensions: {
            code: QUERY_TOO_COMPLEX,
            complexity,
            maxComplexity: max,
            http: { status: 400 },
          },
        });
      },
    };
  }
}
