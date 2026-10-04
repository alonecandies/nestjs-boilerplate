import { appConfig, graphqlConfig } from '@app/config';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { createApolloDriverConfig } from './apollo-config.factory.js';
import type { GraphqlWsAuthHandlers } from './auth/subscription-auth.js';
import type { GqlContext } from './context/gql-context.js';
import { DataLoaderRegistry } from './loaders/data-loader.registry.js';
import { JSONObjectResolver, UUIDResolver } from './scalars/index.js';

type WsOptions = {
  onConnect: (ctx: unknown) => unknown;
  onClose: (ctx: unknown) => void;
  onNext: (ctx: unknown, id: string, payload: unknown, args: unknown, result: unknown) => unknown;
};

function build(env: Record<string, string>): {
  config: ApolloDriverConfig;
  wsAuth: GraphqlWsAuthHandlers & {
    onConnect: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
  };
} {
  const wsAuth = { onConnect: vi.fn(async () => true), onClose: vi.fn() };
  const config = createApolloDriverConfig({
    graphql: graphqlConfig.parse(env),
    app: appConfig.parse(env),
    loaders: new DataLoaderRegistry(),
    wsAuth,
  });
  return { config, wsAuth };
}

type LandingPageListener = {
  renderLandingPage?: () => Promise<{ html: string | (() => Promise<string>) }>;
};

/** HTML of the landing pages the configured plugins would render (behavioural, not by plugin id). */
async function landingPages(config: ApolloDriverConfig): Promise<string[]> {
  const pages: string[] = [];
  for (const plugin of config.plugins ?? []) {
    const start = (plugin as { serverWillStart?: (s: unknown) => Promise<unknown> })
      .serverWillStart;
    const listener = (await start?.({})) as LandingPageListener | undefined;
    const page = await listener?.renderLandingPage?.();
    if (page !== undefined)
      pages.push(typeof page.html === 'string' ? page.html : await page.html());
  }
  return pages;
}

describe('createApolloDriverConfig', () => {
  it('development: Apollo Sandbox, introspection, stack traces, errors exposed', async () => {
    const { config } = build({ NODE_ENV: 'development' });

    expect(config).toMatchObject({
      path: '/graphql',
      autoSchemaFile: true,
      sortSchema: true,
      graphiql: false,
      introspection: true,
      csrfPrevention: true,
      includeStacktraceInErrorResponses: true,
    });
    const pages = await landingPages(config);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('embeddable-sandbox');
  });

  it('production: no landing page, no introspection, no stack traces', () => {
    const { config } = build({ NODE_ENV: 'production' });

    expect(config).toMatchObject({
      introspection: false,
      csrfPrevention: true,
      includeStacktraceInErrorResponses: false,
    });
    expect(config.plugins).toEqual([]);

    const formatted = config.formatError?.(
      { message: 'secret', path: ['x'] },
      new GraphQLError('secret', { path: ['x'], originalError: new Error('db password=hunter2') }),
    );
    expect(formatted).toMatchObject({ message: 'An unexpected error occurred.' });
  });

  it('honours explicit GRAPHQL_* overrides', async () => {
    const { config } = build({
      NODE_ENV: 'production',
      GRAPHQL_PATH: '/api/graphql',
      GRAPHQL_SANDBOX: 'true',
      GRAPHQL_INTROSPECTION: 'true',
      GRAPHQL_SCHEMA_FILE: 'schema.gql',
    });

    expect(config).toMatchObject({
      path: '/api/graphql',
      introspection: true,
      autoSchemaFile: 'schema.gql',
    });
    expect(await landingPages(config)).toHaveLength(1);
    expect(config.subscriptions?.['graphql-ws']).toMatchObject({ path: '/api/graphql' });
  });

  it('registers the UUID/JSONObject scalars without requiring them in the schema', () => {
    const { config } = build({});

    expect(config.resolvers).toEqual({ UUID: UUIDResolver, JSONObject: JSONObjectResolver });
    expect(config.resolverValidationOptions).toEqual({ requireResolversToMatchSchema: 'ignore' });
    expect(config.buildSchemaOptions).toMatchObject({ dateScalarMode: 'isoDate' });
  });

  it('wires graphql-ws on the same path to the auth handlers', async () => {
    const { config, wsAuth } = build({});
    const ws = config.subscriptions?.['graphql-ws'] as WsOptions & {
      connectionInitWaitTimeout: number;
    };
    const ctx = { connectionParams: { token: 't' }, extra: {} };

    await expect(ws.onConnect(ctx)).resolves.toBe(true);
    ws.onClose(ctx);

    expect(ws.connectionInitWaitTimeout).toBe(10_000);
    expect(wsAuth.onConnect).toHaveBeenCalledWith(ctx);
    expect(wsAuth.onClose).toHaveBeenCalledWith(ctx);
    expect(ws.onConnect({ extra: 'not-an-object' })).toBe(false);
  });

  it('formats subscription event errors with the production rules', () => {
    const { config } = build({ NODE_ENV: 'production' });
    const ws = config.subscriptions?.['graphql-ws'] as WsOptions;
    const error = new GraphQLError('boom', { path: ['x'], originalError: new Error('internal') });

    expect(ws.onNext({}, '1', {}, {}, { data: null, errors: [error] })).toMatchObject({
      errors: [{ message: 'An unexpected error occurred.', extensions: { code: 'INTERNAL' } }],
    });
    expect(ws.onNext({}, '1', {}, {}, { data: { x: 1 } })).toBeUndefined();
  });

  it('builds a per-operation context with fresh loaders', () => {
    const { config } = build({});
    const context = config.context as (req: unknown, reply?: unknown) => GqlContext;

    const a = context({ id: 'r1', headers: {} }, {});
    const b = context({ id: 'r2', headers: {} }, {});

    expect(a.req.id).toBe('r1');
    expect(a.loaders).not.toBe(b.loaders);
  });
});
