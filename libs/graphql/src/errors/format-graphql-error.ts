import { toProblemDetails } from '@app/common';
import {
  type ExecutionResult,
  type FormattedExecutionResult,
  GraphQLError,
  type GraphQLFormattedError,
} from 'graphql';
import { get, omit } from 'lodash-es';

export interface FormatGraphqlErrorOptions {
  /** Reveal messages of unexpected errors and stack traces. MUST be `false` in production. */
  exposeInternal: boolean;
  /** Base URI of `extensions.type` (defaults to the platform's problem type base). */
  typeBaseUrl?: string;
}

/** Extension keys that must never reach production clients (Nest/Apollo debugging aids). */
const INTERNAL_EXTENSIONS = ['stacktrace', 'originalError', 'exception'] as const;

const APOLLO_INTERNAL_CODE = 'INTERNAL_SERVER_ERROR';

/**
 * Realm-safe `instanceof GraphQLError`. If a second copy of `graphql` is ever loaded (duplicate
 * install, dev/prod export conditions), its errors would otherwise be treated as unknown 500s.
 */
export function isGraphQLError(value: unknown): value is GraphQLError {
  return value instanceof GraphQLError || (value instanceof Error && value.name === 'GraphQLError');
}

/**
 * The value a resolver threw. graphql-js wraps it in a located `GraphQLError` (with `path`). It is
 * exposed as the standard `cause` in graphql 17 (`originalError` is deprecated and kept as the
 * fallback for graphql 16). This is Apollo's `unwrapResolverError`, but realm-safe.
 */
export function unwrapResolverError(error: unknown): unknown {
  if (!isGraphQLError(error) || error.path === undefined) return error;
  const inner: unknown = error.cause ?? get(error, 'originalError');
  return inner ?? error;
}

const GENERIC_INTERNAL_MESSAGE = 'An unexpected error occurred.';

/**
 * Builds Apollo's `formatError`. It speaks the same error vocabulary as the REST API
 * (`toProblemDetails`):
 * - Errors thrown by resolvers (`DomainException`, `HttpException` including ValidationPipe 400s,
 *   and unknown errors) get `extensions: { code, status, type, errors? }`. For example,
 *   `EntityNotFoundException` becomes `code: 'NOT_FOUND', status: 404`, and an unknown error
 *   becomes `code: 'INTERNAL'` with a generic message unless `exposeInternal`.
 * - GraphQL-level errors (syntax, validation, `BAD_USER_INPUT`, `QUERY_TOO_COMPLEX`, persisted
 *   queries) keep Apollo's code and message. They describe the client's document.
 * - Without `exposeInternal`, stack traces and Nest's `originalError` echo are stripped.
 *
 * This does not log: `AllExceptionsFilter` already logged resolver errors when they passed
 * through Nest.
 */
export function formatGraphqlError(
  options: FormatGraphqlErrorOptions,
): (formatted: GraphQLFormattedError, error: unknown) => GraphQLFormattedError {
  const { exposeInternal, typeBaseUrl } = options;

  return (formatted, error) => {
    const original = unwrapResolverError(error);

    // Errors of the document itself (or deliberately thrown GraphQLErrors) already carry a code.
    if (isGraphQLError(original) || original === undefined || original === null) {
      if (exposeInternal) return formatted;
      const extensions = omit(formatted.extensions, INTERNAL_EXTENSIONS);
      // Apollo-level internal failures (e.g. "Context creation failed: <reason>") embed the
      // server-side message, so it is replaced by a generic one.
      return extensions['code'] === APOLLO_INTERNAL_CODE
        ? { ...formatted, message: GENERIC_INTERNAL_MESSAGE, extensions }
        : { ...formatted, extensions };
    }

    const problem = toProblemDetails(original, { exposeInternal, typeBaseUrl });
    const extensions: Record<string, unknown> = {
      code: problem.code,
      status: problem.status,
      type: problem.type,
    };
    if (problem.errors !== undefined) extensions['errors'] = problem.errors;
    const stacktrace = formatted.extensions?.['stacktrace'];
    if (exposeInternal && stacktrace !== undefined) extensions['stacktrace'] = stacktrace;

    const result: GraphQLFormattedError = {
      message: problem.detail ?? problem.title,
      extensions,
    };
    if (formatted.locations !== undefined) {
      return { ...result, locations: formatted.locations, ...pathOf(formatted) };
    }
    return { ...result, ...pathOf(formatted) };
  };
}

function pathOf(formatted: GraphQLFormattedError): Pick<GraphQLFormattedError, 'path'> {
  return formatted.path === undefined ? {} : { path: formatted.path };
}

/** The formatter returned by `formatGraphqlError`. */
export type GraphqlErrorFormatter = ReturnType<typeof formatGraphqlError>;

/**
 * Applies the formatter to a subscription result (graphql-ws `onNext`). graphql-ws bypasses
 * Apollo's `formatError`, so without this, events of a failing subscription would carry raw
 * error messages (and internals) to clients. Returns `undefined` when there is nothing to format,
 * which tells graphql-ws to send the result unchanged.
 */
export function formatExecutionResult(
  result: ExecutionResult,
  format: GraphqlErrorFormatter,
): FormattedExecutionResult | undefined {
  if (result.errors === undefined || result.errors.length === 0) return undefined;
  return { ...result, errors: result.errors.map((error) => format(error.toJSON(), error)) };
}
