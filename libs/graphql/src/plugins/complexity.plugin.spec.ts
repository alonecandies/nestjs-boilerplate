import { ApolloServer } from '@apollo/server';
import { EntityNotFoundException } from '@app/common';
import { graphqlConfig } from '@app/config';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import {
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  getIntrospectionQuery,
  parse,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GqlContext } from '../context/gql-context.js';
import { formatGraphqlError } from '../errors/format-graphql-error.js';
import { DataLoaderRegistry } from '../loaders/data-loader.registry.js';
import {
  ComplexityPlugin,
  isIntrospectionOnly,
  measureComplexity,
  QUERY_TOO_COMPLEX,
} from './complexity.plugin.js';
import { ErrorRequestIdPlugin } from './error-request-id.plugin.js';

interface UserSource {
  id: string;
}

// Code-first Nest puts `complexity` from @Field/@ResolveField options into field extensions,
// which is exactly what fieldExtensionsEstimator reads.
const User: GraphQLObjectType<UserSource> = new GraphQLObjectType<UserSource>({
  name: 'User',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    friends: {
      type: new GraphQLList(User),
      args: { limit: { type: GraphQLInt } },
      extensions: { complexity: 10 },
      resolve: (): UserSource[] => [{ id: 'f1' }],
    },
  }),
});

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      user: {
        type: User,
        args: { id: { type: new GraphQLNonNull(GraphQLString) } },
        resolve: (_root, args: { id: string }): UserSource => ({ id: args.id }),
      },
      missing: {
        type: User,
        resolve: (): never => {
          throw new EntityNotFoundException('User', 'u404');
        },
      },
    },
  }),
});

const MAX = 20;
const cfg = graphqlConfig.parse({ GRAPHQL_MAX_COMPLEXITY: String(MAX) });

function createPlugin(): ComplexityPlugin {
  const host = new GraphQLSchemaHost();
  host.schema = schema;
  return new ComplexityPlugin(host, cfg);
}

// user(1) + id(1) + friends(10) + friends.id(1) = 13
const CHEAP = '{ user(id: "u1") { id friends { id } } }';
// two aliased copies: 26 > 20 (alias amplification)
const EXPENSIVE =
  '{ a: user(id: "u1") { id friends { id } } b: user(id: "u2") { id friends { id } } }';

describe('measureComplexity / isIntrospectionOnly', () => {
  it('sums field costs (explicit complexity or 1)', () => {
    expect(measureComplexity({ schema, document: parse(CHEAP) })).toBe(13);
    expect(measureComplexity({ schema, document: parse(EXPENSIVE) })).toBe(26);
  });

  it('returns undefined when variables are invalid (no HTTP 500 from the plugin)', () => {
    const document = parse('query Q($id: String!) { user(id: $id) { id } }');

    expect(measureComplexity({ schema, document, variables: { id: 42 } })).toBeUndefined();
  });

  it('recognizes introspection-only operations', () => {
    expect(isIntrospectionOnly(parse(getIntrospectionQuery()))).toBe(true);
    expect(isIntrospectionOnly(parse('{ __typename }'))).toBe(true);
    expect(isIntrospectionOnly(parse('{ __typename user(id: "1") { id } }'))).toBe(false);
    expect(
      isIntrospectionOnly(parse('query A { user(id: "1") { id } } query B { __typename }'), 'B'),
    ).toBe(true);
  });
});

describe('ComplexityPlugin (via ApolloServer.executeOperation)', () => {
  let server: ApolloServer<GqlContext>;
  // `createLoaders()` rather than a `{}` literal: domain libs augment `GraphqlLoaders` with
  // required keys (identity's `users`), which a literal fails once they share the program.
  const loaders = new DataLoaderRegistry();
  const contextValue = (): GqlContext => ({
    req: { id: 'req-123', headers: {} },
    loaders: loaders.createLoaders(),
  });

  beforeAll(async () => {
    server = new ApolloServer<GqlContext>({
      schema,
      plugins: [createPlugin(), new ErrorRequestIdPlugin()],
      formatError: formatGraphqlError({ exposeInternal: false }),
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('executes operations within the limit', async () => {
    const res = await server.executeOperation({ query: CHEAP }, { contextValue: contextValue() });

    expect(res.body.kind).toBe('single');
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
    expect(res.body.singleResult.data).toEqual({ user: { id: 'u1', friends: [{ id: 'f1' }] } });
  });

  it('rejects over-limit operations before execution with HTTP 400 + QUERY_TOO_COMPLEX', async () => {
    const res = await server.executeOperation(
      { query: EXPENSIVE },
      { contextValue: contextValue() },
    );

    expect(res.http.status).toBe(400);
    if (res.body.kind !== 'single') throw new Error('expected a single result');
    expect(res.body.singleResult.data).toBeUndefined();
    expect(res.body.singleResult.errors?.[0]).toMatchObject({
      message: `Query is too complex: 26. Maximum allowed: ${MAX}`,
      extensions: {
        code: QUERY_TOO_COMPLEX,
        complexity: 26,
        maxComplexity: MAX,
        requestId: 'req-123',
      },
    });
  });

  it('lets introspection through even though it exceeds the limit', async () => {
    const document = parse(getIntrospectionQuery());
    expect(measureComplexity({ schema, document })).toBeGreaterThan(MAX);

    const res = await server.executeOperation(
      { query: getIntrospectionQuery() },
      { contextValue: contextValue() },
    );

    if (res.body.kind !== 'single') throw new Error('expected a single result');
    expect(res.body.singleResult.errors).toBeUndefined();
  });

  it('leaves invalid variables to execution (400 BAD_USER_INPUT, not 500)', async () => {
    const res = await server.executeOperation(
      { query: 'query Q($id: String!) { user(id: $id) { id } }', variables: { id: 42 } },
      { contextValue: contextValue() },
    );

    expect(res.http.status).toBe(400);
    if (res.body.kind !== 'single') throw new Error('expected a single result');
    expect(res.body.singleResult.errors?.[0]?.extensions?.['code']).toBe('BAD_USER_INPUT');
  });

  it('formats resolver DomainExceptions with the platform codes and the request id', async () => {
    const res = await server.executeOperation(
      { query: '{ missing { id } }' },
      { contextValue: contextValue() },
    );

    if (res.body.kind !== 'single') throw new Error('expected a single result');
    expect(res.body.singleResult.data).toEqual({ missing: null });
    expect(res.body.singleResult.errors?.[0]).toMatchObject({
      path: ['missing'],
      extensions: { code: 'NOT_FOUND', status: 404, requestId: 'req-123' },
    });
  });
});
