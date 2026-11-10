import { UseFilters } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

/**
 * Put on every `@WebSocketGateway`. Nest never applies global (APP_FILTER) filters to gateways
 * (`ExceptionFiltersContext.getGlobalMetadata()` returns `[]` in @nestjs/websockets), so without it
 * a 429/403/validation error reaches the client as Nest's generic `{ status: 'error' }`. With it,
 * clients get the problem document: `{ ok: false, error }` through the ack callback when they used
 * `emitWithAck`, else an `exception` event. In the gateway's module the filter options token is
 * absent, so `exposeInternal` is false (5xx messages hidden), which is the safe default.
 */
export const UseWsExceptionFilter = (): ClassDecorator & MethodDecorator =>
  UseFilters(AllExceptionsFilter);
