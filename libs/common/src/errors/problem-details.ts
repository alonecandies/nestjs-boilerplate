import { HttpException, HttpStatus } from '@nestjs/common';
import {
  flatMap,
  isNumber,
  isPlainObject,
  isString,
  kebabCase,
  memoize,
  startCase,
  toLower,
} from 'lodash-es';
import { isDomainException } from './domain.exception.js';
import { ErrorCode, errorCodeForStatus } from './error-codes.js';
import { translateInfrastructureError } from './infrastructure-errors.js';
import type { ValidationIssue } from './validation-issue.js';

/**
 * RFC 9457 "Problem Details for HTTP APIs" body, plus two extension members: `code` (stable machine
 * code clients branch on) and `requestId` (to correlate with logs/traces).
 *
 * NOTE: deliberately no `statusCode` member — Nest's FastifyAdapter rewrites the content type to
 * `application/json` when an error body carries `statusCode`.
 */
export interface ProblemDetails {
  /** URI identifying the problem type: `${typeBaseUrl}${kebab(code)}`. */
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  requestId?: string;
  /** Field-level issues (`ValidationIssue`-shaped objects for validation failures). */
  errors?: unknown[];
  /** Client-safe context of 4xx domain errors (`DomainException.details` minus `issues`). */
  details?: Record<string, unknown>;
}

export interface ProblemDetailsContext {
  requestId?: string | undefined;
  /** The request path (without query string) / event pattern the problem occurred on. */
  instance?: string | undefined;
  /** Reveal messages of unexpected (5xx) errors. Must be `false` in production. */
  exposeInternal: boolean;
  /** Base URI for `type` (default `DEFAULT_PROBLEM_TYPE_BASE_URL`). */
  typeBaseUrl?: string | undefined;
}

export const DEFAULT_PROBLEM_TYPE_BASE_URL = 'https://errors.nestjs-boilerplate.dev/';

const GENERIC_INTERNAL_DETAIL = 'An unexpected error occurred.';
const RATE_LIMITED_DETAIL = 'Too many requests. Please retry later.';
const VALIDATION_DETAIL = 'The request is invalid.';

const TITLE_OVERRIDES: Readonly<Partial<Record<string, string>>> = {
  [ErrorCode.INTERNAL]: 'Internal Server Error',
  [ErrorCode.RATE_LIMITED]: 'Too Many Requests',
};

/** Codes are a small, author-controlled set → memoizing the string munging is bounded and cheap. */
const typeSlug = memoize((code: string): string => kebabCase(code));
const titleFor = memoize(
  (code: string): string => TITLE_OVERRIDES[code] ?? startCase(toLower(code)),
);

/**
 * Maps ANY thrown value to a problem document. Used by the HTTP filter, the maintenance middleware
 * and WS/GraphQL adapters so every transport speaks the same error vocabulary.
 *
 * - `@platform/database` errors (`RlsContextError`, `RowCountMismatchError`, `SystemDatabaseError`) →
 *   the `DomainException` they stand for (`translateInfrastructureError`); unlisted codes → 500.
 * - `DomainException` → its status/code; `details.issues` → `errors`; message is client-safe by contract.
 * - `HttpException` (incl. ValidationPipe 400 lists/grouped objects, ThrottlerException 429) →
 *   status-derived code (or Nest 12 `errorCode`); 5xx messages hidden unless `exposeInternal`.
 * - `Error` carrying a numeric 4xx `statusCode` (Fastify body-limit/content-type errors) → that status.
 * - anything else → 500 `INTERNAL`, message hidden unless `exposeInternal`.
 */
export function toProblemDetails(exception: unknown, ctx: ProblemDetailsContext): ProblemDetails {
  const base = resolveProblem(exception, ctx.exposeInternal);
  const problem: ProblemDetails = {
    type: `${ctx.typeBaseUrl ?? DEFAULT_PROBLEM_TYPE_BASE_URL}${typeSlug(base.code)}`,
    title: titleFor(base.code),
    status: base.status,
    code: base.code,
  };
  if (base.detail !== undefined) problem.detail = base.detail;
  if (ctx.instance !== undefined) problem.instance = ctx.instance;
  if (ctx.requestId !== undefined) problem.requestId = ctx.requestId;
  if (base.errors !== undefined && base.errors.length > 0) problem.errors = base.errors;
  if (base.details !== undefined) problem.details = base.details;
  return problem;
}

interface ResolvedProblem {
  status: number;
  code: string;
  detail?: string | undefined;
  errors?: unknown[] | undefined;
  details?: Record<string, unknown> | undefined;
}

function resolveProblem(raw: unknown, exposeInternal: boolean): ResolvedProblem {
  const exception = translateInfrastructureError(raw) ?? raw;
  if (isDomainException(exception)) {
    const issues = exception.details?.['issues'];
    const status: number = exception.httpStatus;
    return {
      status,
      code: exception.code,
      detail: exception.message,
      // 5xx domain details may describe upstream internals — only issues of 4xx errors are public.
      errors: isUnknownArray(issues) && (status < 500 || exposeInternal) ? issues : undefined,
      details: status < 500 ? publicDetails(exception.details) : undefined,
    };
  }

  if (exception instanceof HttpException) {
    return fromHttpException(exception, exposeInternal);
  }

  const clientStatus = clientErrorStatusOf(exception);
  if (clientStatus !== undefined && exception instanceof Error) {
    return {
      status: clientStatus,
      code: errorCodeForStatus(clientStatus),
      detail: exception.message,
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: ErrorCode.INTERNAL,
    detail: exposeInternal ? describeUnknown(exception) : GENERIC_INTERNAL_DETAIL,
  };
}

function fromHttpException(exception: HttpException, exposeInternal: boolean): ResolvedProblem {
  const status = exception.getStatus();
  const response = exception.getResponse();
  const { message, errors } = extractHttpMessage(response, exception.message);
  const hasIssues = errors !== undefined && errors.length > 0;

  let code: string = exception.errorCode ?? errorCodeForStatus(status);
  if (hasIssues && status === 400 && exception.errorCode === undefined) {
    code = ErrorCode.VALIDATION_FAILED;
  }

  let detail: string | undefined = message;
  if (status === 429) detail = RATE_LIMITED_DETAIL;
  else if (status >= 500 && !exposeInternal) detail = undefined;

  return { status, code, detail, errors: hasIssues ? errors : undefined };
}

/**
 * Understands every body shape Nest produces: plain string, `{ message: string }`,
 * `{ message: string[] }` (ValidationPipe 'list'), `{ message: Record<string, string[]> }`
 * (ValidationPipe 'grouped') and our own `{ message, errors: ValidationIssue[] }`.
 */
function extractHttpMessage(
  response: string | object,
  fallback: string,
): { message: string | undefined; errors?: unknown[] | undefined } {
  if (isString(response)) return { message: response };
  const body = response as { message?: unknown; errors?: unknown };

  if (isUnknownArray(body.errors)) {
    return {
      message: isString(body.message) ? body.message : VALIDATION_DETAIL,
      errors: body.errors,
    };
  }
  if (isUnknownArray(body.message)) {
    const errors = body.message
      .filter(isString)
      .map((m): Pick<ValidationIssue, 'message'> => ({ message: m }));
    return { message: VALIDATION_DETAIL, errors };
  }
  if (isPlainObject(body.message)) {
    const grouped = body.message as Record<string, unknown>;
    const errors = flatMap(Object.entries(grouped), ([path, messages]): ValidationIssue[] =>
      isUnknownArray(messages) ? messages.filter(isString).map((m) => ({ path, message: m })) : [],
    );
    return { message: VALIDATION_DETAIL, errors };
  }
  return { message: isString(body.message) ? body.message : fallback };
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function jsonSafe(value: unknown, depth: number): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => jsonSafe(item, depth + 1))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const safe = jsonSafe(item, depth + 1);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  }
  return undefined; // Dates, Errors, class instances, functions, symbols, bigint
}

/**
 * The public part of `DomainException.details` (F22): plain JSON values only, at most 4 levels,
 * without `issues` (rendered as `errors`). `DomainExceptionOptions.details` is documented as
 * client-safe; this is the allow-list that enforces "plain data" on top of that contract.
 */
export function publicDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const { issues: _issues, ...rest } = details;
  const safe = jsonSafe(rest, 0);
  if (safe === null || typeof safe !== 'object' || Array.isArray(safe)) return undefined;
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/** `Array.isArray` narrows to `any[]`; keep `unknown` so element access stays type-checked. */
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

function clientErrorStatusOf(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const status = (exception as { statusCode?: unknown }).statusCode;
  return isNumber(status) && status >= 400 && status < 500 ? status : undefined;
}

function describeUnknown(exception: unknown): string {
  if (exception instanceof Error) return exception.message || exception.name;
  if (isString(exception)) return exception;
  return GENERIC_INTERNAL_DETAIL;
}
