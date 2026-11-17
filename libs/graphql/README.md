# @platform/graphql

Code-first GraphQL: Apollo Server 5 on Fastify through `@nestjs/apollo`. It covers queries,
mutations and graphql-ws subscriptions on one path, adds a complexity limit, per-operation
DataLoaders with no REQUEST scope, and a Redis-backed PubSub. Errors use the same code/status
vocabulary as the REST API.

## Public API

| Export                                                                                                                                                                                                                             | Kind          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppGraphqlModule.forRootAsync(options?: { imports?, requireSubscriptionAuth?, buildSchemaOptions? })`                                                                                                                             | global module | `GraphQLModule.forRootAsync<ApolloDriverConfig>` + `ComplexityPlugin` + `ErrorRequestIdPlugin` + `DataLoaderRegistry`.                                                                                                                                                                                                                                                                                                                                            |
| `createApolloDriverConfig(deps: { graphql, app, loaders, wsAuth, buildSchemaOptions? }): ApolloDriverConfig`                                                                                                                       | function      | The effective driver options (pure, unit-tested). `GRAPHQL_WS_INIT_TIMEOUT_MS` = 10s.                                                                                                                                                                                                                                                                                                                                                                             |
| `GraphqlPubSubModule` / `.forRootAsync({ inMemory? })`                                                                                                                                                                             | global module | `GRAPHQL_PUB_SUB` = `RedisPubSub` on two dedicated connections (or the in-memory `PubSub`). `GraphqlPubSubShutdown` QUITs them, bounded. `createRedisPubSub(cfg, name)`.                                                                                                                                                                                                                                                                                          |
| `GRAPHQL_PUB_SUB`, `InjectPubSub()`, `type GraphqlPubSub` (= `PubSubEngine`)                                                                                                                                                       | DI            | `@InjectPubSub() private readonly pubSub: GraphqlPubSub` (import the type with `import type`).                                                                                                                                                                                                                                                                                                                                                                    |
| `DataLoaderRegistry`                                                                                                                                                                                                               | provider      | `register(name, () => new DataLoader(...))` at boot. `createLoaders()` per operation (lazy, isolated). `has`, `names`.                                                                                                                                                                                                                                                                                                                                            |
| `@Loader(name)`, `resolveLoader(ctx, name)`                                                                                                                                                                                        | decorator     | Injects this operation's loader. Throws when it isn't registered.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GqlContext`, `GqlRequest`, `GraphqlLoaders` (augmentable), `GqlWsExtra`, `GqlWsConnectionContext`, `isWsContext`, `getGqlContext(ctx)`                                                                                            | context       | `{ req, reply?, loaders }`. For subscriptions, `req` is built from the upgrade request plus the connection params.                                                                                                                                                                                                                                                                                                                                                |
| `createGraphqlContext(registry)`, `buildWsRequest(ctx)`                                                                                                                                                                            | functions     | The Apollo `context` function.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `formatGraphqlError({ exposeInternal, typeBaseUrl? })`, `formatExecutionResult(result, format)`, `unwrapResolverError`, `isGraphQLError`, `type GraphqlErrorFormatter`                                                             | errors        | Resolver errors → `extensions { code, status, type, errors? }` via `toProblemDetails`. Internals are hidden in production, for HTTP and subscription events.                                                                                                                                                                                                                                                                                                      |
| `ComplexityPlugin`, `measureComplexity`, `isIntrospectionOnly`, `COMPLEXITY_ESTIMATORS`, `QUERY_TOO_COMPLEX`                                                                                                                       | plugin        | Rejects operations above `GRAPHQL_MAX_COMPLEXITY` with HTTP 400 before execution. Introspection is exempt.                                                                                                                                                                                                                                                                                                                                                        |
| `OperationRateLimitPlugin`, `GRAPHQL_RATE_LIMITED`                                                                                                                                                                                 | plugin        | Per-operation limiting: one charge per operation on the `graphql` cost budget (`THROTTLE_GRAPHQL_COST_LIMIT`), weighted by the complexity score, keyed by user (else IP). A limited operation fails before any resolver with HTTP 429 `RATE_LIMITED` and `Retry-After`; introspection-only operations are exempt. It verifies the bearer token itself (it runs before `JwtAuthGuard`) and hands the user to the guard, so a token is verified once per operation. |
| `SubscriptionGuardRef`, `SubscriptionGuardBinder`, `createSubscriptionCheck`                                                                                                                                                       | graphql-ws    | `onSubscribe` runs the same complexity check and cost charge for subscriptions, which Apollo plugins never see.                                                                                                                                                                                                                                                                                                                                                   |
| `ErrorRequestIdPlugin`, `attachRequestId`                                                                                                                                                                                          | plugin        | `extensions.requestId` on every HTTP error (= `x-request-id`).                                                                                                                                                                                                                                                                                                                                                                                                    |
| `extractConnectionToken`, `createSubscriptionAuthenticator(tokens, denylist)`, `createGraphqlWsAuthHandlers(auth, { requireAuth?, sweeper?, caps?, clientIp? })`, `WS_CLOSE_TOKEN_EXPIRED` (4401), `WS_CLOSE_TOKEN_REVOKED` (4401) | ws auth       | graphql-ws `onConnect`/`onClose`. `requireAuth` defaults to `true`. With `sweeper` (a `RevocationSweeper`), accepted sockets are tracked by `jti` and untracked on close. `AppGraphqlModule` passes its own `graphql-ws` sweeper.                                                                                                                                                                                                                                 |
| `GraphQLUUID`, `GraphQLJSONObject`, `UUIDResolver`, `JSONObjectResolver`, `GRAPHQL_SCALAR_RESOLVERS`                                                                                                                               | scalars       | `@Field(() => GraphQLUUID)`, `@Field(() => GraphQLJSONObject)`. `DateTime` is Nest's ISO scalar.                                                                                                                                                                                                                                                                                                                                                                  |

## Usage

```ts
@Module({
  imports: [
    AppConfigModule.forRoot(), RedisModule.forRootAsync(), AuthModule.forRootAsync(),
    AppGraphqlModule.forRootAsync(), GraphqlPubSubModule,
  ],
})
export class AppModule {}

// a domain package: register a loader once, use it in field resolvers
declare module '@platform/graphql' {
  interface GraphqlLoaders { authors: DataLoader<string, Author | null> }
}

@Injectable()
export class AuthorsLoaderRegistrar implements OnModuleInit {
  constructor(private readonly registry: DataLoaderRegistry, private readonly authors: AuthorsPort) {}
  onModuleInit(): void {
    this.registry.register('authors', () => new DataLoader((ids: readonly string[]) => this.authors.getAuthorsByIds([...ids]), { maxBatchSize: 500 }));
  }
}

@ResolveField(() => AuthorModel, { nullable: true, complexity: 5 })
author(@Parent() post: PostModel, @Loader('authors') authors: GraphqlLoaders['authors']) {
  return authors.load(post.authorId);
}

@Subscription(() => CommentModel, { filter: (p, _v, ctx: GqlContext) => p.authorId === ctx.req.user?.id })
commentAdded() { return this.pubSub.asyncIterableIterator('commentAdded'); }
```

Clients: HTTP `POST /graphql` (`content-type: application/json`). Subscriptions use graphql-ws on the
same path, with `connectionParams: { authorization: 'Bearer <jwt>' }` (or `{ token }`).

## Environment

`graphql` namespace: `GRAPHQL_PATH` (`/graphql`), `GRAPHQL_SANDBOX` / `GRAPHQL_INTROSPECTION`
(default: on outside production), `GRAPHQL_MAX_COMPLEXITY` (250), `THROTTLE_GRAPHQL_COST_LIMIT` (20000) and `THROTTLE_GRAPHQL_TTL_MS` (60000) (the `throttle` namespace), `GRAPHQL_SCHEMA_FILE` (write the
SDL there; unset = in memory). `app`: `NODE_ENV` (production hides internals and stack traces).
`redis`: `REDIS_URL` (PubSub).

## Gotchas

- **Put `complexity` on `@ResolveField`.** A `@Field` complexity is lost when a resolver resolves
  that property. Give fan-out list fields a real cost.
- **Subscriptions** authenticate once, at `connection_init`. An invalid, expired or revoked token
  closes the socket with 4403. A socket with no token is refused too (4403) by default, since
  anonymous sockets get no expiry timer and the throttler skips ws. To serve public subscriptions,
  opt out with `AppGraphqlModule.forRootAsync({ requireSubscriptionAuth: false })`: anonymous
  sockets are then accepted and each subscription's guards decide. Sockets are closed with 4401
  `Access token expired` when the token's `exp` passes, and with 4401 `Access token revoked` by the
  revocation sweep (every `WS_REVOCATION_SWEEP_INTERVAL_MS`, default 30 s) once their token is on
  the denylist (logout, tenant switch). The sweep starts on application bootstrap and stops on
  shutdown. `onConnect` also charges the per-IP handshake budget before the token is checked and takes a slot of the
  per-user socket cap after it (`THROTTLE_WS_*`); a refusal closes with 4403 like an authentication failure, and
  `onClose` frees the slot. The global `JwtAuthGuard` still runs per subscribe, reading the Bearer
  header synthesized from the connection params.
- `fieldResolverEnhancers` is left empty on purpose. Otherwise global guards would run for every
  resolved field of every list item.
- **The Sandbox has its own CSP.** It loads Apollo's CDN assets, so while `GRAPHQL_SANDBOX` is on,
  `SandboxCspHook` sets a route-level CSP on the `GET /graphql` HTML page only
  (`SANDBOX_CONTENT_SECURITY_POLICY`); the API keeps the strict global CSP. That makes
  `GRAPHQL_SANDBOX=true` work in production too (it is off there by default).
- **CSRF prevention** is on. GET and simple requests need `content-type: application/json` or an
  `apollo-require-preflight` header.
- **graphql 17 has dev/prod builds behind export conditions.** Vitest resolves sources with the
  `development` condition, but externals (Apollo) load natively. Specs that mix both alias
  `graphql` to the native instance with `vi.mock` (see `complexity.plugin.spec.ts`).
  `isGraphQLError` and `unwrapResolverError` are realm-safe for the same reason.
- RedisPubSub serializes payloads as JSON, so `Date` values arrive as ISO strings (Nest's
  `DateTime` scalar serializes both).
- Nest's graphql-ws server uses `ws` defaults (for example the 100 MiB max payload). Put a limit
  at the proxy if you expose subscriptions publicly.
