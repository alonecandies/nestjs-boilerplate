import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zStr } from '@platform/config';
import { z } from 'zod';

export const identityGrpcClientEnvSchema = z
  .object({
    // Any grpc-js target syntax: host:port, dns:///svc:port, … (compose: identity-service:50051).
    IDENTITY_GRPC_URL: zStr('localhost:50051'),
  })
  .transform((env) => ({
    /** Target of `identity.v1` (AuthService, UsersService). */
    url: env.IDENTITY_GRPC_URL,
  }));

/**
 * Where the gateway dials identity-service. Read by `IdentityApiModule.forRemote()` when the module
 * is defined; deadlines, message limits and TLS stay in the platform `grpc` namespace.
 */
export const identityGrpcClientConfig = defineConfigNamespace(
  'identityGrpcClient',
  identityGrpcClientEnvSchema,
);
export type IdentityGrpcClientConfig = ConfigType<typeof identityGrpcClientConfig>;
