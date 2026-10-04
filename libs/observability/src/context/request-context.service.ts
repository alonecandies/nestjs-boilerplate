import { generateId, isSafeRequestId } from '@app/common';
import { Injectable } from '@nestjs/common';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { CLS_CORRELATION_ID, CLS_USER_ID } from '../observability.constants.js';

export interface RunInRequestContextOptions {
  /** Id of the new context; a valid id is adopted, anything else is replaced by a UUIDv7. */
  requestId?: string;
  correlationId?: string;
  userId?: string;
}

/**
 * Typed facade over the per-request CLS store (one AsyncLocalStorage context per HTTP request,
 * GraphQL operation, gRPC call, Kafka message or WS message). Replaces REQUEST-scoped providers on
 * hot paths: a singleton reading ALS costs nothing per request, a REQUEST-scoped provider re-creates
 * its whole dependency chain per request.
 *
 * Every accessor is safe outside a context (returns `undefined`, setters no-op), so code shared by
 * request handlers, crons and bootstrap never has to check.
 */
@Injectable()
export class RequestContextService {
  constructor(private readonly cls: ClsService) {}

  /** Whether the current async flow runs inside a request context. */
  get isActive(): boolean {
    return this.cls.isActive();
  }

  /** Id of the current request (= Fastify `request.id` = log field `requestId`). */
  get requestId(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string | undefined>(CLS_ID) : undefined;
  }

  /** Caller-supplied `x-correlation-id` when valid, else the request id (start of a new chain). */
  get correlationId(): string | undefined {
    if (!this.cls.isActive()) return undefined;
    return this.cls.get<string | undefined>(CLS_CORRELATION_ID) ?? this.requestId;
  }

  set correlationId(value: string | undefined) {
    if (this.cls.isActive() && (value === undefined || isSafeRequestId(value))) {
      this.cls.set(CLS_CORRELATION_ID, value);
    }
  }

  /** Authenticated user of the current request (set by auth guards / gRPC metadata readers). */
  get userId(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string | undefined>(CLS_USER_ID) : undefined;
  }

  set userId(value: string | undefined) {
    if (this.cls.isActive()) this.cls.set(CLS_USER_ID, value);
  }

  /**
   * Runs `fn` in a FRESH context — for work Nest has no request pipeline for (cron ticks, queue
   * jobs, standalone consumers), so logs, outgoing metadata and Kafka envelopes still correlate.
   */
  run<T>(fn: () => T, options: RunInRequestContextOptions = {}): T {
    return this.cls.run({ ifNested: 'override' }, () => {
      this.cls.set(CLS_ID, isSafeRequestId(options.requestId) ? options.requestId : generateId());
      if (isSafeRequestId(options.correlationId)) {
        this.cls.set(CLS_CORRELATION_ID, options.correlationId);
      }
      if (options.userId !== undefined) this.cls.set(CLS_USER_ID, options.userId);
      return fn();
    });
  }
}
