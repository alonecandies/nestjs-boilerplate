import { credentials } from '@grpc/grpc-js';
import { ImmuServiceClient } from '../generated/immudb/schema/schema.pb.js';

/** One HTTP/2 channel per process; sessions multiplex over it. */
export function createImmudbGrpcClient(cfg: { address: string; tls: boolean }): ImmuServiceClient {
  return new ImmuServiceClient(
    cfg.address,
    cfg.tls ? credentials.createSsl() : credentials.createInsecure(),
    {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.max_receive_message_length': 32 * 1024 * 1024,
    },
  );
}
