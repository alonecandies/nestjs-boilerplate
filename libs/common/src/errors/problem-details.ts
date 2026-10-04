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
  return problem;
}

interface ResolvedProblem {
  status: number;
  code: string;
  detail?: string | undefined;
  errors?: unknown[] | undefined;
}

function resolveProblem(exception: unknown, exposeInternal: boolean): ResolvedProblem {
  if (isDomainException(exception)) {
    const issues = exception.details?.['issues'];
    const status: number = exception.httpStatus;
    return {
      status,
      code: exception.code,
      detail: exception.message,
      // 5xx domain details may describe upstream internals — only issues of 4xx errors are public.
      errors: isUnknownArray(issues) && (status < 500 || exposeInternal) ? issues : undefined,
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
