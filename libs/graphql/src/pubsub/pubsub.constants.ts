import { Inject } from '@nestjs/common';
import type { PubSubEngine } from 'graphql-subscriptions';

/** DI token of the process-wide GraphQL `PubSubEngine` (RedisPubSub, or in-memory in tests). */
export const GRAPHQL_PUB_SUB = Symbol('GRAPHQL_PUB_SUB');

/**
 * Engine-agnostic PubSub type. Declare injected fields with it (`import type`) so resolvers don't
 * depend on graphql-redis-subscriptions:
 * `@InjectPubSub() private readonly pubSub: GraphqlPubSub`.
 */
export type GraphqlPubSub = PubSubEngine;

/** `@InjectPubSub() private readonly pubSub: GraphqlPubSub` */
export const InjectPubSub = (): PropertyDecorator & ParameterDecorator => Inject(GRAPHQL_PUB_SUB);
