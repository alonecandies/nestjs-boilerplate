import { io, type Socket } from 'socket.io-client';

/** What a client sends in the handshake. A token in `query` is sent on purpose: servers refuse it. */
export interface OpenSocketOptions {
  /** Namespace path of the gateway under test, for example `/orders`. */
  namespace: string;
  /** `auth: { token }` (browser style). */
  token?: string;
  /** Extra request headers (`Authorization: Bearer …`, server-to-server style). */
  headers?: Record<string, string>;
  /** Query-string parameters. */
  query?: Record<string, string>;
}

/** The problem details a refused handshake carries in `connect_error.data`. */
export interface ConnectRefusal {
  message: string;
  data?: { status?: number; code?: string } & Record<string, unknown>;
}

const DEFAULT_WAIT_MS = 3_000;

/**
 * Opens a websocket-only client (no long-polling upgrade, no reconnection: a server-side
 * disconnect must stay visible to the spec) and starts connecting. Pair it with
 * {@link SocketClients.track} so the spec closes every client.
 */
export function openSocket(wsUrl: string, options: OpenSocketOptions): Socket {
  return io(`${wsUrl}${options.namespace}`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    ...(options.token === undefined ? {} : { auth: { token: options.token } }),
    ...(options.headers === undefined ? {} : { extraHeaders: options.headers }),
    ...(options.query === undefined ? {} : { query: options.query }),
  });
}

/** Resolves when `socket` is connected. Rejects with the refusal when the handshake fails. */
export function connected(socket: Socket, timeoutMs = DEFAULT_WAIT_MS): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve(socket);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`socket did not connect within ${timeoutMs} ms`));
    }, timeoutMs);
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
  });
}

/** Resolves with the refusal of a handshake that must fail; rejects when the socket connects. */
export function refused(socket: Socket, timeoutMs = DEFAULT_WAIT_MS): Promise<ConnectRefusal> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`handshake was not refused within ${timeoutMs} ms`));
    }, timeoutMs);
    const onConnect = (): void => {
      cleanup();
      reject(new Error('handshake was accepted, a refusal was expected'));
    };
    const onError = (error: ConnectRefusal): void => {
      cleanup();
      resolve(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
  });
}

/** Resolves with the arguments of the next `event`; rejects after `timeoutMs`. */
export function nextEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`no '${event}' event within ${timeoutMs} ms`));
    }, timeoutMs);
    const onEvent = (payload: T): void => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

/** Resolves with the disconnect reason (`io server disconnect`, …); rejects after `timeoutMs`. */
export function disconnected(socket: Socket, timeoutMs = DEFAULT_WAIT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    if (socket.disconnected) {
      reject(new Error('socket is already disconnected'));
      return;
    }
    const timer = setTimeout(() => {
      socket.off('disconnect', onDisconnect);
      reject(new Error(`socket stayed connected for ${timeoutMs} ms`));
    }, timeoutMs);
    const onDisconnect = (reason: string): void => {
      clearTimeout(timer);
      resolve(reason);
    };
    socket.once('disconnect', onDisconnect);
  });
}

/** Records every payload of `event` from now on. */
export function collectEvents<T = unknown>(
  socket: Socket,
  event: string,
): { readonly received: T[]; stop(): void } {
  const received: T[] = [];
  const onEvent = (payload: T): void => {
    received.push(payload);
  };
  socket.on(event, onEvent);
  return { received, stop: () => socket.off(event, onEvent) };
}

/** Waits `ms` (an absence can only be asserted by waiting). */
export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls `predicate` until it holds; rejects after `timeoutMs`. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = DEFAULT_WAIT_MS,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await wait(intervalMs);
  }
}

/** Remembers every client a spec opens so `afterAll` closes them all (idempotent per client). */
export class SocketClients {
  private readonly sockets = new Set<Socket>();

  /** @param namespace the namespace path every client of this spec connects to */
  constructor(private readonly namespace: string) {}

  /** Registers `socket` and returns it. */
  track(socket: Socket): Socket {
    this.sockets.add(socket);
    return socket;
  }

  /** `openSocket` + `track`. */
  open(wsUrl: string, options: Omit<OpenSocketOptions, 'namespace'> = {}): Socket {
    return this.track(openSocket(wsUrl, { ...options, namespace: this.namespace }));
  }

  /** `open` + wait for the connection. */
  async connect(wsUrl: string, options?: Omit<OpenSocketOptions, 'namespace'>): Promise<Socket> {
    return connected(this.open(wsUrl, options));
  }

  closeAll(): void {
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }
}
