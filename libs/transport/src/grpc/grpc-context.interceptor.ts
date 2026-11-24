import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
  Optional,
} from '@nestjs/common';
import { CLS_PRINCIPAL, generateId, getContextType } from '@platform/common';
import { tagActiveSpan } from '@platform/observability';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { Observable, throwError } from 'rxjs';
import { RPC_CLS_KEYS } from '../context/transport-context.js';
import { type IncomingRpcContext, isGrpcMetadata, readIncomingMetadata } from './grpc-metadata.js';
import { principalForRpcCall } from './grpc-principal.js';
import {
  assessPrincipalAssertion,
  type PrincipalAssertionCheck,
  type PrincipalAssertionSettings,
  principalAssertionSettings,
  recordPrincipalAssertion,
} from './grpc-principal-assertion.js';

/** One warning line per minute at most for each outcome and handler. */
const ASSERTION_WARNING_INTERVAL_MS = 60_000;

interface WarningWindow {
  lastAt: number;
  suppressed: number;
}

/**
 * Opens a nestjs-cls context for each gRPC call and fills it from the incoming metadata:
 * - `CLS_ID` (`cls.getId()`) = the caller's `x-request-id`, or a new uuidv7. Logs from the gateway
 *   and the service then share one id.
 * - `RPC_CLS_KEYS.CORRELATION_ID` = the caller's `x-correlation-id`, else the request id.
 * - `CLS_PRINCIPAL` = the caller's principal (B2-23); `RpcCallerContext` keys documented in
 *   `GRPC_METADATA_KEYS`. Malformed principal metadata fails the call (`INVALID_PRINCIPAL`).
 * - `RPC_CLS_KEYS.CALLER`, the sanitized metadata (with the raw `x-principal-assertion`, which
 *   `callerContextFromCls` forwards unchanged on the service's own calls).
 *
 * `GRPC_PRINCIPAL_ASSERTION` decides what the edge's signed principal assertion does:
 * - `off` ignores the header;
 * - `warn` verifies it: a missing, expired, invalid or mismatching one is logged and counted in
 *   `grpc_principal_assertions_total{outcome}` (`valid` too), and the plain headers still build
 *   the principal. Nothing is refused. The log line is throttled in both modes: at most one a
 *   minute per outcome and handler, with the number held back, while the counter counts every
 *   call;
 * - `enforce` counts the same way, but the principal comes from a valid assertion's claims only: a
 *   call with `x-user-id` and no valid assertion fails `INVALID_PRINCIPAL`, before any handler
 *   runs. A call without `x-user-id` and without an assertion stays anonymous (`principalForRpcCall`).
 *   The refusal carries no reason: the caller learns nothing, the log and the counter keep it.
 *
 * nestjs-cls middleware only runs for HTTP, which is why gRPC needs this. The handler is
 * subscribed inside `cls.run()`, so the context follows every await in the handler. This is the
 * same technique as nestjs-cls' own `ClsInterceptor`. Other transports pass straight through.
 * Without `ClsModule` in the app the interceptor does nothing.
 */
@Injectable()
export class GrpcContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(GrpcContextInterceptor.name);
  /**
   * By outcome and `Class.handler`: bounded by the handlers the app registers times four outcomes,
   * so a peer that floods the port, under `warn` or `enforce`, cannot flood the log.
   */
  private readonly warningWindows = new Map<string, WarningWindow>();

  constructor(@Optional() private readonly cls?: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const cls = this.cls;
    if (cls === undefined || getContextType(context) !== 'rpc') return next.handle();
    const metadata = context.switchToRpc().getContext<unknown>();
    if (!isGrpcMetadata(metadata)) return next.handle();

    const caller: IncomingRpcContext = readIncomingMetadata(metadata);
    const settings = principalAssertionSettings();
    const check = this.checkAssertion(caller, settings, context);
    let principal: ReturnType<typeof principalForRpcCall>;
    try {
      principal = principalForRpcCall(caller, settings.mode, check);
    } catch (error) {
      // INVALID_PRINCIPAL → UNAUTHENTICATED through the controller's exception filter.
      return throwError(() => error);
    }
    const requestId = caller.requestId ?? generateId();
    return new Observable<unknown>((subscriber) =>
      // 'inherit': if a global ClsGuard/ClsInterceptor already opened a context, extend a copy of
      // it. The id from the caller still wins over the one that initializer generated.
      cls.run({ ifNested: 'inherit' }, () => {
        cls.set(CLS_ID, requestId);
        cls.set(RPC_CLS_KEYS.CORRELATION_ID, caller.correlationId ?? requestId);
        cls.set(RPC_CLS_KEYS.CALLER, caller);
        if (principal !== undefined) cls.set(CLS_PRINCIPAL, principal);
        tagActiveSpan({ requestId, correlationId: caller.correlationId ?? requestId });
        return next.handle().subscribe(subscriber);
      }),
    );
  }

  /** `warn` and `enforce`: verify, count and log. `principalForRpcCall` acts on the result. */
  private checkAssertion(
    caller: IncomingRpcContext,
    settings: PrincipalAssertionSettings,
    context: ExecutionContext,
  ): PrincipalAssertionCheck | undefined {
    if (settings.mode === 'off') return undefined;
    const check = assessPrincipalAssertion(caller, settings.publicKeys);
    if (check === undefined) return undefined;
    recordPrincipalAssertion(check.outcome);
    if (check.outcome !== 'valid') {
      // Never the token or its claims: the outcome and the handler are enough to find the caller.
      const handler = `${context.getClass().name}.${context.getHandler().name}`;
      const effect =
        settings.mode === 'enforce' ? 'the call is refused' : 'the plain caller headers are used';
      this.warnThrottled(
        `${check.outcome} ${handler}`,
        `Principal assertion ${check.outcome} on ${handler}: ${effect} (GRPC_PRINCIPAL_ASSERTION=${settings.mode})`,
      );
    }
    return check;
  }

  /** Logs `message` unless `key` logged less than a minute ago; the next line says how many were held. */
  private warnThrottled(key: string, message: string): void {
    const now = Date.now();
    const window = this.warningWindows.get(key);
    // A clock that went back opens a new window instead of muting the warning until it catches up.
    if (
      window !== undefined &&
      now >= window.lastAt &&
      now - window.lastAt < ASSERTION_WARNING_INTERVAL_MS
    ) {
      window.suppressed += 1;
      return;
    }
    const held = window?.suppressed ?? 0;
    this.warningWindows.set(key, { lastAt: now, suppressed: 0 });
    this.logger.warn(held === 0 ? message : `${message} (${held} more since the last one)`);
  }
}
