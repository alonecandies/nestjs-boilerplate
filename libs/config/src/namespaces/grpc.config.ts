import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zInt, zStr } from '../env/env.helpers.js';

export const grpcEnvSchema = z
  .object({
    GRPC_URL: zStr('0.0.0.0:50051'),
    IDENTITY_GRPC_URL: zStr('localhost:50051'),
    NOTIFICATIONS_GRPC_URL: zStr('localhost:50052'),
    BILLING_GRPC_URL: zStr('localhost:50053'),
    GRPC_DEADLINE_MS: zInt(5000, { min: 1 }),
    GRPC_MAX_MESSAGE_BYTES: zInt(4_194_304, { min: 1024 }),
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
  }));

/** gRPC server bind address, client targets, deadlines and message limits. */
export const grpcConfig = defineConfigNamespace('grpc', grpcEnvSchema);
export type GrpcConfig = ConfigType<typeof grpcConfig>;
