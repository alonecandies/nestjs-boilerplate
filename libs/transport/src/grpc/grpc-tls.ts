import { readFileSync } from 'node:fs';
import type { GrpcConfig } from '@app/config';
import { type ChannelCredentials, credentials, ServerCredentials } from '@grpc/grpc-js';

type GrpcTlsConfig = NonNullable<GrpcConfig['tls']>;

const readPem = (path: string | undefined): Buffer | null =>
  path === undefined ? null : readFileSync(path);

/**
 * Server credentials from `grpcConfig.tls`: this service's certificate and key, and, when
 * `requireClientCert`, mutual TLS (callers must present a certificate signed by `caPath`).
 * `undefined` = plaintext (Nest then binds with `ServerCredentials.createInsecure()`).
 * The PEM files are read once, when the options are built.
 */
export function createGrpcServerCredentials(
  tls: GrpcTlsConfig | undefined,
): ServerCredentials | undefined {
  if (tls === undefined) return undefined;
  return ServerCredentials.createSsl(
    readPem(tls.caPath),
    [{ cert_chain: readFileSync(tls.certPath), private_key: readFileSync(tls.keyPath) }],
    tls.requireClientCert,
  );
}

/**
 * Channel credentials from `grpcConfig.tls`: verify the server against `caPath` (the system roots
 * when unset) and present this process's certificate for mutual TLS. The server certificate must
 * name the host of the target (`IDENTITY_GRPC_URL` etc.) in its SANs. `undefined` = plaintext.
 */
export function createGrpcChannelCredentials(
  tls: GrpcTlsConfig | undefined,
): ChannelCredentials | undefined {
  if (tls === undefined) return undefined;
  return credentials.createSsl(
    readPem(tls.caPath),
    readFileSync(tls.keyPath),
    readFileSync(tls.certPath),
  );
}
