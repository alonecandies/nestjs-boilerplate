import type { ServerResponse } from 'node:http';

/** Why a streamed turn was aborted: the client went away before the response ended. */
export class ClientDisconnectedError extends Error {
  constructor() {
    super('The client closed the connection');
    this.name = 'ClientDisconnectedError';
  }
}

export interface ClientDisconnect {
  /** Aborts (reason `ClientDisconnectedError`) when the connection closes before the response ended. */
  readonly signal: AbortSignal;
  /** Stops watching (call it once the response is done). */
  dispose(): void;
}

/**
 * Watches the raw HTTP response of a request: its `close` before `finish` means the client
 * disconnected (a closed tab, a cancelled `fetch`, a dropped proxy connection). The response's
 * `close` is used, not the request's: since Node 16 `IncomingMessage` emits `close` as soon as its
 * body has been read, which for a POST is long before the reply ends. Without a response (a
 * graphql-ws operation) the signal never aborts: the resolver combines it with the GraphQL
 * context's `connectionSignal`, which aborts when the socket closes.
 */
export function abortOnDisconnect(response: ServerResponse | undefined): ClientDisconnect {
  const controller = new AbortController();
  if (response === undefined) return { signal: controller.signal, dispose: () => undefined };
  const onClose = (): void => {
    if (!response.writableFinished) controller.abort(new ClientDisconnectedError());
  };
  if (response.destroyed) onClose();
  else response.once('close', onClose);
  return {
    signal: controller.signal,
    dispose: () => {
      response.off('close', onClose);
    },
  };
}
