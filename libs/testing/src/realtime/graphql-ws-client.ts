import { type Client, createClient, type SubscribePayload } from 'graphql-ws';

/** How a graphql-ws socket was closed. */
export interface GraphqlWsClose {
  code: number;
  reason: string;
}

/** One result as the client receives it: `data` and/or the formatted GraphQL errors. */
export interface GraphqlWsResult<T = Record<string, unknown>> {
  data?: T | null | undefined;
  errors?: readonly { message: string; extensions?: Record<string, unknown> | undefined }[];
}

/** What a subscription has produced so far (the arrays grow as messages arrive). */
export interface GraphqlWsCollector<T = Record<string, unknown>> {
  /** The `data` of every `next` message, in order. */
  readonly received: T[];
  /** Every GraphQL error list (a `next` carrying `errors`, or the operation's `error` message). */
  readonly errors: unknown[][];
  /** `true` once the server sent `complete` (or the socket closed under it). */
  readonly completed: boolean;
  /** Ends the operation (a `complete` message to the server). Idempotent. */
  stop(): void;
}

export interface OpenGraphqlWsOptions {
  /** `connection_init` payload, for example `{ authorization: 'Bearer …' }` or `{ token }`. */
  connectionParams?: Record<string, unknown>;
  /** Path of the endpoint (default `/graphql`). */
  path?: string;
}

const DEFAULT_WAIT_MS = 3_000;

/**
 * One graphql-ws connection: the client (Node 24's global `WebSocket`, no retries, so a close
 * stays visible to the spec), the promise of its close event, and helpers for operations. Open it
 * with {@link GraphqlWsClients.open} so `afterAll` disposes every connection.
 */
export class GraphqlWsConnection {
  readonly client: Client;
  /** Resolves once with the close event; never rejects. */
  readonly closed: Promise<GraphqlWsClose>;
  private acknowledged = false;
  private closeEvent: GraphqlWsClose | undefined;
  private readonly watchers = new Set<() => void>();

  constructor(wsUrl: string, options: OpenGraphqlWsOptions = {}) {
    let resolveClosed: (event: GraphqlWsClose) => void = () => undefined;
    this.closed = new Promise<GraphqlWsClose>((resolve) => {
      resolveClosed = resolve;
    });
    this.client = createClient({
      url: `${wsUrl}${options.path ?? '/graphql'}`,
      webSocketImpl: WebSocket,
      lazy: false,
      retryAttempts: 0,
      // A refused connection is the point of several specs: do not log it.
      onNonLazyError: () => undefined,
      ...(options.connectionParams === undefined
        ? {}
        : { connectionParams: options.connectionParams }),
      on: {
        connected: () => {
          this.acknowledged = true;
          this.notify();
        },
        closed: (event) => {
          const { code, reason } = event as { code: number; reason: string };
          this.closeEvent = { code, reason };
          resolveClosed(this.closeEvent);
          this.notify();
        },
      },
    });
  }

  /** Resolves when the server acknowledged `connection_init`; rejects when the socket closes first. */
  acknowledgement(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    return this.until(
      () => {
        if (this.acknowledged) return true;
        if (this.closeEvent !== undefined) {
          throw new Error(
            `socket closed before the acknowledgement: ${this.closeEvent.code} ${this.closeEvent.reason}`,
          );
        }
        return false;
      },
      timeoutMs,
      'no connection_ack',
    );
  }

  /** Resolves with the close event; rejects when the socket stays open for `timeoutMs`. */
  closedWithin(timeoutMs = DEFAULT_WAIT_MS): Promise<GraphqlWsClose> {
    return this.until(() => this.closeEvent !== undefined, timeoutMs, 'socket stayed open').then(
      () => this.closeEvent as GraphqlWsClose,
    );
  }

  /** `true` while the socket has not closed. */
  get open(): boolean {
    return this.closeEvent === undefined;
  }

  /** Starts an operation and records its messages. */
  subscribe<T = Record<string, unknown>>(payload: SubscribePayload): GraphqlWsCollector<T> {
    const received: T[] = [];
    const errors: unknown[][] = [];
    const state = { completed: false };
    const dispose = this.client.subscribe<T>(payload, {
      next: (result) => {
        if (result.errors !== undefined) errors.push([...result.errors]);
        if (result.data !== undefined && result.data !== null) received.push(result.data);
      },
      error: (error: unknown) => {
        errors.push(Array.isArray(error) ? error : [error]);
        state.completed = true;
      },
      complete: () => {
        state.completed = true;
      },
    });
    return {
      received,
      errors,
      get completed() {
        return state.completed;
      },
      stop: dispose,
    };
  }

  /** Runs one query or mutation over the socket and resolves with its single result. */
  execute<T = Record<string, unknown>>(
    payload: SubscribePayload,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<GraphqlWsResult<T>> {
    return new Promise((resolve, reject) => {
      let result: GraphqlWsResult<T> | undefined;
      const timer = setTimeout(() => {
        dispose();
        reject(new Error(`no result within ${timeoutMs} ms`));
      }, timeoutMs);
      const dispose = this.client.subscribe<T>(payload, {
        next: (next) => {
          result = next;
        },
        error: (error) => {
          clearTimeout(timer);
          resolve({ errors: Array.isArray(error) ? error : [error] });
        },
        complete: () => {
          clearTimeout(timer);
          if (result === undefined) reject(new Error('operation completed without a result'));
          else resolve(result);
        },
      });
    });
  }

  /** Closes the client (idempotent). */
  async dispose(): Promise<void> {
    await this.client.dispose();
  }

  private notify(): void {
    for (const watcher of [...this.watchers]) watcher();
  }

  /** Re-checks `predicate` on every connection event; rejects on a throw or after `timeoutMs`. */
  private until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        try {
          if (!predicate()) return;
        } catch (error) {
          finish();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        finish();
        resolve();
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`${what} within ${timeoutMs} ms`));
      }, timeoutMs);
      const finish = (): void => {
        clearTimeout(timer);
        this.watchers.delete(check);
      };
      this.watchers.add(check);
      check();
    });
  }
}

/** Remembers every connection a spec opens so `afterAll` disposes them all. */
export class GraphqlWsClients {
  private readonly connections = new Set<GraphqlWsConnection>();

  /** Opens and tracks a connection; it starts connecting at once. */
  open(wsUrl: string, options?: OpenGraphqlWsOptions): GraphqlWsConnection {
    const connection = new GraphqlWsConnection(wsUrl, options);
    this.connections.add(connection);
    return connection;
  }

  /** `open` + wait for `connection_ack`. */
  async connect(wsUrl: string, options?: OpenGraphqlWsOptions): Promise<GraphqlWsConnection> {
    const connection = this.open(wsUrl, options);
    await connection.acknowledgement();
    return connection;
  }

  async disposeAll(): Promise<void> {
    const all = [...this.connections];
    this.connections.clear();
    await Promise.all(all.map((connection) => connection.dispose()));
  }
}
