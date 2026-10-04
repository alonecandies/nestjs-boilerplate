import { generateId, getContextType, isSafeRequestId } from '@app/common';
import { KAFKA_HEADERS } from '@app/contracts';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  Optional,
} from '@nestjs/common';
import { KafkaContext } from '@nestjs/microservices';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { RPC_CLS_KEYS } from '../context/transport-context.js';

const headerString = (headers: unknown, name: string): string | undefined => {
  const value = (headers as Record<string, unknown> | null | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
};

const field = (data: unknown, name: string): unknown =>
  typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[name] : undefined;

/**
 * Opens a nestjs-cls context for each Kafka message, the Kafka counterpart of
 * `GrpcContextInterceptor`:
 * - `CLS_ID` = the envelope id (unique per event and stable across redeliveries, so every log line
 *   about one event shares an id), else a new uuidv7.
 * - `RPC_CLS_KEYS.CORRELATION_ID` = the `x-correlation-id` header, else the envelope's
 *   `correlationId`, else the id above. Events the handler publishes (`KafkaProducer`) and gRPC
 *   calls it makes (`callerContextFromCls`) carry it on.
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

    return new Observable<unknown>((subscriber) =>
      cls.run({ ifNested: 'inherit' }, () => {
        cls.set(CLS_ID, requestId);
        cls.set(RPC_CLS_KEYS.CORRELATION_ID, correlationId);
        return next.handle().subscribe(subscriber);
      }),
    );
  }
}
