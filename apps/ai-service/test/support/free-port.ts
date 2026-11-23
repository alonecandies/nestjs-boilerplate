import { Server } from '@grpc/grpc-js';

/**
 * Runs `start`, which boots an in-process gRPC server on `127.0.0.1:0`, and returns what it
 * resolved with plus the port the server really bound. The kernel picks the port and the server
 * keeps it from the first moment, so no parallel fork can take it between "find a free port" and
 * "listen on it" (the old `freePort()` bound port 0, closed that listener and returned the
 * number, leaving exactly that window).
 */
export async function withBoundGrpcPort<T>(
  start: () => Promise<T>,
): Promise<{ value: T; port: number }> {
  const original = Server.prototype.bindAsync;
  const ports: number[] = [];
  Server.prototype.bindAsync = function (this: Server, address, credentials, callback) {
    original.call(this, address, credentials, (error, port) => {
      if (error === null) ports.push(port);
      callback(error, port);
    });
  };
  let value: T;
  try {
    value = await start();
  } finally {
    Server.prototype.bindAsync = original;
  }
  const [port] = ports;
  if (port === undefined || ports.length !== 1) {
    throw new Error(`Expected one gRPC server to bind, saw ${String(ports.length)}`);
  }
  return { value, port };
}
