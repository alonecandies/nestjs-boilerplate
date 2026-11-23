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
 *   the principal. Nothing is refused;
 * - `enforce` counts the same way, but the principal comes from a valid assertion's claims only: a
 *   call with `x-user-id` and no valid assertion fails `INVALID_PRINCIPAL`, before any handler
 *   runs. A call without `x-user-id` and without an assertion stays anonymous (`principalForRpcCall`).
 *
 * nestjs-cls middleware only runs for HTTP, which is why gRPC needs this. The handler is
 * subscribed inside `cls.run()`, so the context follows every await in the handler. This is the
 * same technique as nestjs-cls' own `ClsInterceptor`. Other transports pass straight through.
 * Without `ClsModule` in the app the interceptor does nothing.
 */
@Injectable()
export class GrpcContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(GrpcContextInterceptor.name);

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
      const effect =
        settings.mode === 'enforce' ? 'the call is refused' : 'the plain caller headers are used';
      this.logger.warn(
        `Principal assertion ${check.outcome} on ${context.getClass().name}.${context.getHandler().name}: ${effect} (GRPC_PRINCIPAL_ASSERTION=${settings.mode})`,
      );
    }
    return check;
  }
}
