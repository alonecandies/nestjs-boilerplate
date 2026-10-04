import { isSafeRequestId, type ValidationIssue } from '@app/common';
import { Metadata, type MetadataValue } from '@grpc/grpc-js';
import { compact, isArray, isPlainObject, isString, map, take, trim, uniq } from 'lodash-es';
import { GRPC_METADATA_KEYS } from './grpc.constants.js';

/** Who is calling, and on behalf of which request. The gateway sends this on every call. */
export interface RpcCallerContext {
  requestId?: string | undefined;
  correlationId?: string | undefined;
  userId?: string | undefined;
  roles?: readonly string[] | undefined;
}

/** A sanitized `RpcCallerContext` read from incoming metadata. `roles` is always present. */
export interface IncomingRpcContext {
  requestId?: string;
  correlationId?: string;
  userId?: string;
  roles: string[];
}

/** Client-safe error information sent in trailers so a `DomainException` survives the hop. */
export interface GrpcErrorTrailers {
  /** `DomainException.code`, e.g. `EMAIL_TAKEN`. */
  code?: string;
  /** `DomainException.details` (validation issues, entity/id, …). */
  details?: Record<string, unknown>;
}

/** Only printable ASCII is legal in a non-binary metadata value (grpc-js throws otherwise). */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_VALUE_LENGTH = 256;
const MAX_ROLES = 32;
/** The whole trailer block must stay far below grpc-js' 8 KiB default `max_metadata_size`. */
const MAX_ERROR_DETAILS_BYTES = 4096;
const MAX_TRAILER_ISSUES = 20;

const isLegalValue = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_VALUE_LENGTH && PRINTABLE_ASCII.test(value);

function setIfLegal(metadata: Metadata, key: string, value: string | undefined): void {
  if (value !== undefined && isLegalValue(value)) metadata.set(key, value);
}

const normalizeRoles = (roles: readonly string[] | undefined): string[] =>
  take(uniq(compact(map(roles, (role) => trim(role)))), MAX_ROLES).filter(isLegalValue);

/** First value of a metadata key as a string. Binary values are decoded as UTF-8. */
function firstValue(metadata: Metadata | undefined, key: string): string | undefined {
  const value: MetadataValue | undefined = metadata?.get(key)[0];
  if (value === undefined) return undefined;
  return isString(value) ? value : value.toString('utf8');
}

/** Structural check, so a second copy of `@grpc/grpc-js` in the tree cannot break `instanceof`. */
export function isGrpcMetadata(value: unknown): value is Metadata {
  return (
    value instanceof Metadata ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as Partial<Metadata>).get === 'function' &&
      typeof (value as Partial<Metadata>).getMap === 'function')
  );
}

/**
 * Builds the metadata for an outgoing call. Values that cannot travel as ASCII metadata, such as
 * unsafe request ids, are dropped instead of making grpc-js throw inside a request.
 */
export function createOutgoingMetadata(ctx: RpcCallerContext = {}): Metadata {
  const metadata = new Metadata();
  if (isSafeRequestId(ctx.requestId)) metadata.set(GRPC_METADATA_KEYS.REQUEST_ID, ctx.requestId);
  if (isSafeRequestId(ctx.correlationId)) {
    metadata.set(GRPC_METADATA_KEYS.CORRELATION_ID, ctx.correlationId);
  }
  setIfLegal(metadata, GRPC_METADATA_KEYS.USER_ID, ctx.userId);
  const roles = normalizeRoles(ctx.roles);
  if (roles.length > 0) metadata.set(GRPC_METADATA_KEYS.USER_ROLES, roles.join(','));
  return metadata;
}

/**
 * Reads the caller context from incoming metadata. Request and correlation ids that fail the
 * platform's safe-id check are ignored, because they end up in logs and response headers.
 */
export function readIncomingMetadata(metadata: Metadata | undefined): IncomingRpcContext {
  const context: IncomingRpcContext = {
    roles: normalizeRoles(firstValue(metadata, GRPC_METADATA_KEYS.USER_ROLES)?.split(',')),
  };
  const requestId = firstValue(metadata, GRPC_METADATA_KEYS.REQUEST_ID);
  if (isSafeRequestId(requestId)) context.requestId = requestId;
  const correlationId = firstValue(metadata, GRPC_METADATA_KEYS.CORRELATION_ID);
  if (isSafeRequestId(correlationId)) context.correlationId = correlationId;
  const userId = firstValue(metadata, GRPC_METADATA_KEYS.USER_ID)?.trim();
  if (userId && isLegalValue(userId)) context.userId = userId;
  return context;
}

function serializeDetails(details: Record<string, unknown>): Buffer | undefined {
  const encode = (value: Record<string, unknown>): Buffer | undefined => {
    try {
      const buffer = Buffer.from(JSON.stringify(value), 'utf8');
      return buffer.byteLength <= MAX_ERROR_DETAILS_BYTES ? buffer : undefined;
    } catch {
      return undefined; // BigInt / circular: not worth failing the error response over
    }
  };
  const full = encode(details);
  if (full !== undefined) return full;
  const issues = details['issues'];
  // Long validation lists are the usual reason for oversized details. The first issues are enough
  // for a client to fix the request.
  return isArray(issues)
    ? encode({ ...details, issues: take(issues, MAX_TRAILER_ISSUES) })
    : undefined;
}

/** Trailers for an error response. Returns `undefined` when there is nothing to send. */
export function createErrorTrailers(info: GrpcErrorTrailers): Metadata | undefined {
  const metadata = new Metadata();
  let populated = false;
  if (info.code !== undefined && SAFE_ERROR_CODE.test(info.code)) {
    metadata.set(GRPC_METADATA_KEYS.ERROR_CODE, info.code);
    populated = true;
  }
  if (info.details !== undefined && Object.keys(info.details).length > 0) {
    const encoded = serializeDetails(info.details);
    if (encoded !== undefined) {
      metadata.set(GRPC_METADATA_KEYS.ERROR_DETAILS, encoded);
      populated = true;
    }
  }
  return populated ? metadata : undefined;
}

/** Reads `createErrorTrailers` output from a client-side `ServiceError.metadata`. Never throws. */
export function readErrorTrailers(metadata: unknown): GrpcErrorTrailers {
  if (!isGrpcMetadata(metadata)) return {};
  const trailers: GrpcErrorTrailers = {};
  const code = firstValue(metadata, GRPC_METADATA_KEYS.ERROR_CODE);
  if (code !== undefined && SAFE_ERROR_CODE.test(code)) trailers.code = code;
  const raw = firstValue(metadata, GRPC_METADATA_KEYS.ERROR_DETAILS);
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) trailers.details = parsed as Record<string, unknown>;
    } catch {
      // A malformed details trailer is ignored: the status code and message still apply.
    }
  }
  return trailers;
}

/** Narrows `details.issues` from a trailer back to `ValidationIssue[]`. */
export function toValidationIssueList(value: unknown): ValidationIssue[] | undefined {
  if (!isArray(value)) return undefined;
  const issues: ValidationIssue[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const { path, message, code } = item as Record<string, unknown>;
    if (!isString(message)) continue;
    const issue: ValidationIssue = { path: isString(path) ? path : '', message };
    if (isString(code)) issue.code = code;
    issues.push(issue);
  }
  return issues;
}
