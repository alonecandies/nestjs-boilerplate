import { JSONObjectResolver, UUIDResolver } from 'graphql-scalars';

/**
 * Custom scalars of the public schema (`DateTime` is Nest's built-in ISO scalar). They are used
 * code-first: `@Field(() => GraphQLUUID) id: string`,
 * `@Args('id', { type: () => GraphQLUUID })`, and `@Field(() => GraphQLJSONObject) data: Record<string, unknown>`.
 */
export {
  GraphQLJSONObject,
  GraphQLUUID,
  JSONObjectResolver,
  UUIDResolver,
} from 'graphql-scalars';

/** Resolver map registered on the Apollo driver (a scalar no field uses is ignored). */
export const GRAPHQL_SCALAR_RESOLVERS = Object.freeze({
  UUID: UUIDResolver,
  JSONObject: JSONObjectResolver,
});
