import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { isFunction } from 'lodash-es';
import { type Observable, throwError } from 'rxjs';
import { HTTP_HEADERS, PROBLEM_JSON_CONTENT_TYPE } from '../constants/headers.constants.js';
import { EXCEPTIONS_FILTER_OPTIONS } from '../constants/tokens.constants.js';
import {
  getContextType,
  getHeaderValue,
  type RequestLike,
} from '../context/execution-context.util.js';
import { type ProblemDetails, toProblemDetails } from '../errors/problem-details.js';

export interface ExceptionsFilterOptions {
  /** Reveal messages of unexpected errors in responses. `false` in production (the default). */
  exposeInternal: boolean;
  /** Base URI for problem `type` members (default `https://errors.nestjs-boilerplate.dev/`). */
  typeBaseUrl?: string;
}

interface NativeResponse {
  headersSent: boolean;
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk: string): unknown;
}

interface SocketClient {
  emit?: (event: string, payload: unknown) => unknown;
  send?: (data: string) => unknown;
  readyState?: unknown;
}

/**
 * Global catch-all filter; renders every error with the same vocabulary per transport:
 * - http    → RFC 9457 `application/problem+json` through `HttpAdapterHost` (works for Fastify
 *             replies AND the raw Node response Fastify middleware errors carry).
 * - graphql → returns the exception untouched; Apollo's `formatError` (`@app/graphql`) maps it.
 * - ws      → acks the client callback with `{ ok: false, error }` when the client used an ack,
 *             else emits `'exception'` with the problem document.
 * - rpc     → rethrows as an observable error; controller-scoped gRPC/Kafka filters own RPC
 *             semantics (a global RPC filter with `inheritAppConfig` hangs HTTP requests).
 * 5xx are logged at `error` with the stack, 4xx at `debug` (they are client mistakes, not incidents).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  private readonly options: ExceptionsFilterOptions;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Optional() @Inject(EXCEPTIONS_FILTER_OPTIONS) options?: ExceptionsFilterOptions,
  ) {
    this.options = { exposeInternal: false, ...options };
  }

  catch(exception: unknown, host: ArgumentsHost): unknown {
    switch (getContextType(host)) {
      case 'http':
        return this.handleHttp(exception, host);
      case 'graphql':
        this.log(exception, this.problem(exception));
        return exception;
      case 'ws':
        return this.handleWs(exception, host);
      case 'rpc':
        return this.handleRpc(exception);
    }
  }

  private handleHttp(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const response = http.getResponse<object>();
    const adapter = this.adapterHost.httpAdapter;

    const url: string = adapter
      ? String(adapter.getRequestUrl(request) ?? '')
      : (request.url ?? '');
    const q = url.indexOf('?');
    const requestId =
      request.id === undefined
        ? getHeaderValue(request.headers, HTTP_HEADERS.REQUEST_ID)
        : String(request.id);
    const problem = this.problem(exception, requestId, q === -1 ? url : url.slice(0, q));
    this.log(exception, problem, request.method);

    // Nest's own convention: frameworks' responses have `status()`, the raw Node response doesn't
    // (that's what Fastify middleware errors carry — FastifyAdapter.reply can't set its content type).
    if (!('status' in response)) {
      const raw = response as NativeResponse;
      if (raw.headersSent) return;
      raw.statusCode = problem.status;
      raw.setHeader('content-type', PROBLEM_JSON_CONTENT_TYPE);
      raw.end(JSON.stringify(problem));
      return;
    }
    if (!adapter || adapter.isHeadersSent(response)) return;
    adapter.setHeader(response, 'content-type', PROBLEM_JSON_CONTENT_TYPE);
    adapter.reply(response, problem, problem.status);
  }

  private handleWs(exception: unknown, host: ArgumentsHost): void {
    const ws = host.switchToWs();
    const client = ws.getClient<SocketClient | undefined>();
    const problem = this.problem(exception, undefined, safePattern(ws));
    this.log(exception, problem);

    // ws handler args are [client, data, ack?, pattern]; socket.io clients using emitWithAck would
    // otherwise wait for their ack timeout instead of getting the error.
    const ack = host.getArgs<unknown[]>().slice(2).find(isFunction) as
      | ((payload: unknown) => void)
      | undefined;
    if (ack) {
      ack({ ok: false, error: problem });
      return;
    }
    if (!client) return;
    if (typeof client.readyState === 'number' && isFunction(client.send)) {
      client.send(JSON.stringify({ event: 'exception', data: problem }));
    } else if (isFunction(client.emit)) {
      client.emit('exception', problem);
    }
  }

  private handleRpc(exception: unknown): Observable<never> {
    this.log(exception, this.problem(exception));
    return throwError(() => exception);
  }

  private problem(exception: unknown, requestId?: string, instance?: string): ProblemDetails {
    return toProblemDetails(exception, {
      requestId,
      instance,
      exposeInternal: this.options.exposeInternal,
      typeBaseUrl: this.options.typeBaseUrl,
    });
  }

  private log(exception: unknown, problem: ProblemDetails, method?: string): void {
    const fields = {
      status: problem.status,
      code: problem.code,
      requestId: problem.requestId,
      method,
      path: problem.instance,
    };
    if (problem.status >= 500) {
      this.logger.error({ ...fields, err: exception }, 'Request failed with an unexpected error');
    } else {
      this.logger.debug(fields, `Request failed: ${problem.code}`);
    }
  }
}

/** Nest appends the message pattern as the LAST ws handler argument (`'unknown'` when absent). */
function safePattern(ws: ReturnType<ArgumentsHost['switchToWs']>): string | undefined {
  const pattern: unknown = ws.getPattern();
  return typeof pattern === 'string' ? pattern : undefined;
}
