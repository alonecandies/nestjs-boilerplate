import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  Optional,
} from '@nestjs/common';
import { KafkaContext } from '@nestjs/microservices';
import {
  CLS_PRINCIPAL,
  createPrincipal,
  generateId,
  getContextType,
  isPlatformTenantId,
  isSafeRequestId,
  isUuid,
  type Principal,
} from '@platform/common';
import { KAFKA_HEADERS } from '@platform/contracts';
import { tagActiveSpan } from '@platform/observability';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { Observable, tap } from 'rxjs';
import { RPC_CLS_KEYS } from '../context/transport-context.js';
import { recordKafkaOutcome } from './kafka-metrics.js';

const headerString = (headers: unknown, name: string): string | undefined => {
  const value = (headers as Record<string, unknown> | null | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
};

const field = (data: unknown, name: string): unknown =>
  typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[name] : undefined;

/** `{ userId: actorId, tenantId }` of an (unvalidated) envelope, when both are usable; never throws. */
function actorPrincipal(data: unknown): Principal | undefined {
  const tenantId = field(data, 'tenantId');
  const actorId = field(data, 'actorId');
  if (!isUuid(tenantId) || isPlatformTenantId(tenantId) || !isUuid(actorId)) return undefined;
  try {
    return createPrincipal({ userId: actorId, tenantId });
  } catch {
    return undefined;
  }
}

/**
 * Opens a nestjs-cls context for each Kafka message, the Kafka counterpart of
 * `GrpcContextInterceptor`:
 * - `CLS_ID` = the envelope id (unique per event and stable across redeliveries, so every log line
 *   about one event shares an id), else a new uuidv7.
 * - `RPC_CLS_KEYS.CORRELATION_ID` = the `x-correlation-id` header, else the envelope's
 *   `correlationId`, else the id above. Events the handler publishes (`KafkaProducer`) and gRPC
 *   calls it makes (`callerContextFromCls`) carry it on.
 * - `CLS_PRINCIPAL` = `{ userId: actorId, tenantId }` of the envelope (B2-24): a consumer that
 *   touches Postgres runs as the actor; system maintenance runs in `SystemContext` (B3-12).
 * Only unvalidated fields that pass the safe-id check are used, because they end up in logs.
 */
@Injectable()
export class KafkaContextInterceptor implements NestInterceptor {
  constructor(@Optional() private readonly cls?: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const cls = this.cls;
    if (cls === undefined || getContextType(context) !== 'rpc') return next.handle();
    const rpc = context.switchToRpc();
    const kafka = rpc.getContext<unknown>();
    if (!(kafka instanceof KafkaContext)) return next.handle();

    const data = rpc.getData<unknown>();
    const eventId = field(data, 'id');
    const requestId = isSafeRequestId(eventId) ? eventId : generateId();
    const correlationId =
      [
        headerString(kafka.getMessage().headers, KAFKA_HEADERS.CORRELATION_ID),
        field(data, 'correlationId'),
      ].find(isSafeRequestId) ?? requestId;

    const principal = actorPrincipal(data);

    return new Observable<unknown>((subscriber) =>
      cls.run({ ifNested: 'inherit' }, () => {
        cls.set(CLS_ID, requestId);
        cls.set(RPC_CLS_KEYS.CORRELATION_ID, correlationId);
        if (principal !== undefined) cls.set(CLS_PRINCIPAL, principal);
        tagActiveSpan({ requestId, correlationId });
        return next
          .handle()
          .pipe(tap({ complete: () => recordKafkaOutcome(kafka.getTopic(), 'success') }))
          .subscribe(subscriber);
      }),
    );
  }
}
