import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zNodeEnv, zStr } from '../env/env.helpers.js';

export const grpcEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    GRPC_URL: zStr('0.0.0.0:50051'),
    IDENTITY_GRPC_URL: zStr('localhost:50051'),
    NOTIFICATIONS_GRPC_URL: zStr('localhost:50052'),
    BILLING_GRPC_URL: zStr('localhost:50053'),
    GRPC_DEADLINE_MS: zInt(5000, { min: 1 }),
    GRPC_MAX_MESSAGE_BYTES: zInt(4_194_304, { min: 1024 }),
    // TLS for internal gRPC (PEM files). CERT + KEY switch it on, for the server AND as the client
    // certificate this process presents (mTLS). CA = the bundle that signed the PEERS' certificates.
    GRPC_TLS_CA_PATH: zStr(),
    GRPC_TLS_CERT_PATH: zStr(),
    GRPC_TLS_KEY_PATH: zStr(),
    GRPC_TLS_REQUIRE_CLIENT_CERT: zBool(true),
    // Production refuses plaintext gRPC unless this explicit opt-out is set (e.g. a service mesh
    // already encrypts and authenticates pod-to-pod traffic).
    GRPC_ALLOW_INSECURE: zBool(false),
    // Server reflection (grpcurl/Postman). Default: on unless NODE_ENV=production.
    GRPC_REFLECTION: zBool(),
  })
  .superRefine((env, ctx) => {
    const hasCert = env.GRPC_TLS_CERT_PATH !== undefined;
    const hasKey = env.GRPC_TLS_KEY_PATH !== undefined;
    if (hasCert !== hasKey) {
      ctx.addIssue({
        code: 'custom',
        path: [hasCert ? 'GRPC_TLS_KEY_PATH' : 'GRPC_TLS_CERT_PATH'],
        message: 'GRPC_TLS_CERT_PATH and GRPC_TLS_KEY_PATH must be set together',
      });
    }
    if (hasCert && env.GRPC_TLS_REQUIRE_CLIENT_CERT && env.GRPC_TLS_CA_PATH === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['GRPC_TLS_CA_PATH'],
        message:
          'GRPC_TLS_CA_PATH is required to verify client certificates (or set GRPC_TLS_REQUIRE_CLIENT_CERT=false)',
      });
    }
    if (env.NODE_ENV === 'production' && !hasCert && !env.GRPC_ALLOW_INSECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['GRPC_TLS_CERT_PATH'],
        message:
          'gRPC is plaintext and unauthenticated without TLS: set GRPC_TLS_CERT_PATH/GRPC_TLS_KEY_PATH/GRPC_TLS_CA_PATH in production, or GRPC_ALLOW_INSECURE=true when the network layer (mesh, NetworkPolicy) secures it',
      });
    }
  })
  .transform((env) => ({
    /** Server bind address of THIS service. */
    url: env.GRPC_URL,
    /** Client targets (any grpc-js target syntax: `host:port`, `dns:///svc:port`, …). */
    clients: {
      identity: env.IDENTITY_GRPC_URL,
      notifications: env.NOTIFICATIONS_GRPC_URL,
      billing: env.BILLING_GRPC_URL,
    },
    /** Default per-call deadline; every client call MUST have one or a hung upstream pins resources. */
    deadlineMs: env.GRPC_DEADLINE_MS,
    maxMessageBytes: env.GRPC_MAX_MESSAGE_BYTES,
    /**
     * PEM file paths, or `undefined` for plaintext. Servers require a client certificate signed by
     * `caPath` when `requireClientCert`; clients verify servers against `caPath` (system roots when
     * unset) and present `certPath`/`keyPath`.
     */
    tls:
      env.GRPC_TLS_CERT_PATH !== undefined && env.GRPC_TLS_KEY_PATH !== undefined
        ? {
            caPath: env.GRPC_TLS_CA_PATH,
            certPath: env.GRPC_TLS_CERT_PATH,
            keyPath: env.GRPC_TLS_KEY_PATH,
            requireClientCert: env.GRPC_TLS_REQUIRE_CLIENT_CERT,
          }
        : undefined,
    /** Attach gRPC server reflection. */
    reflection: env.GRPC_REFLECTION ?? env.NODE_ENV !== 'production',
  }));

/** gRPC server bind address, client targets, deadlines, message limits, TLS and reflection. */
export const grpcConfig = defineConfigNamespace('grpc', grpcEnvSchema);
export type GrpcConfig = ConfigType<typeof grpcConfig>;
