import { HTTP_HEADERS } from '@app/common';

/**
 * gRPC metadata keys used between services. gRPC requires lower-case ASCII keys, and a `-bin`
 * suffix for binary values (grpc-js base64-encodes those on the wire).
 */
export const GRPC_METADATA_KEYS = {
  /** Edge request id. The service adopts it as its nestjs-cls id, so logs line up across hops. */
  REQUEST_ID: HTTP_HEADERS.REQUEST_ID,
  CORRELATION_ID: HTTP_HEADERS.CORRELATION_ID,
  /** Authenticated caller, asserted by the gateway. Trust it only inside the service mesh. */
  USER_ID: 'x-user-id',
  /** Comma-separated roles of the caller. */
  USER_ROLES: 'x-user-roles',
  /** Trailer: stable `DomainException.code` (e.g. `EMAIL_TAKEN`) that survives the hop. */
  ERROR_CODE: 'x-error-code',
  /** Trailer: JSON of the client-safe `DomainException.details` (issues, entity/id). */
  ERROR_DETAILS: 'x-error-details-bin',
} as const;

export type GrpcMetadataKey = (typeof GRPC_METADATA_KEYS)[keyof typeof GRPC_METADATA_KEYS];

/** DI token: `Partial<GrpcCircuitBreakerOptions>` overrides for `GrpcCircuitBreakers`. */
export const GRPC_CIRCUIT_BREAKER_OPTIONS = Symbol('GRPC_CIRCUIT_BREAKER_OPTIONS');

/**
 * Keepalive and connection-age settings shared by servers and clients. The client pings every
 * 30 s, and the server accepts pings that are at least 10 s apart; if the server's limit were
 * stricter than the client's interval, the server would answer with GOAWAY `too_many_pings`.
 */
export const GRPC_KEEPALIVE = {
  keepaliveTimeMs: 30_000,
  keepaliveTimeoutMs: 10_000,
  keepalivePermitWithoutCalls: 1,
  http2MinPingIntervalWithoutDataMs: 10_000,
} as const;
