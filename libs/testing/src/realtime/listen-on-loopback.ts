import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** Where a listening test app can be reached. */
export interface LoopbackAddress {
  /** `http://127.0.0.1:<port>` */
  httpUrl: string;
  /** `ws://127.0.0.1:<port>` */
  wsUrl: string;
}

/**
 * Binds an app that `createFastifyTestApp` returned (initialised, not listening) to
 * `127.0.0.1` on a free port (port 0), so a spec can open real HTTP and WebSocket connections.
 * Never binds another interface, never a fixed port. `app.close()` frees the port; run the spec
 * outside any sandbox that forbids listening.
 */
export async function listenOnLoopback(app: NestFastifyApplication): Promise<LoopbackAddress> {
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test app did not bind a TCP port');
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}`,
  };
}
