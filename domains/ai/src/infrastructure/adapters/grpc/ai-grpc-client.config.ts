import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt, zStr } from '@platform/config';
import { z } from 'zod';

export const aiGrpcClientEnvSchema = z
  .object({
    // Any grpc-js target syntax: host:port, dns:///svc:port, … (compose: ai-service:50051).
    AI_GRPC_URL: zStr('localhost:50054'),
    // Deadline of a chat turn over gRPC (SendMessage, StreamMessage: the whole stream). Keep it above
    // ai-service's AI_REQUEST_TIMEOUT_MS (60000 by default), so the model call's own timeout
    // (504 AI_TIMEOUT) answers first. Every other call keeps GRPC_DEADLINE_MS.
    AI_GRPC_CHAT_DEADLINE_MS: zInt(70_000, { min: 1_000, max: 900_000 }),
  })
  .transform((env) => ({
    /** Target of `ai.v1.AiService`. */
    url: env.AI_GRPC_URL,
    /** Deadline of `SendMessage` and `StreamMessage` (ms). */
    chatDeadlineMs: env.AI_GRPC_CHAT_DEADLINE_MS,
  }));

/**
 * Where the gateway dials ai-service, and how long a chat turn may take. Read by
 * `AiApiModule.forRemote()` when the module is defined; message limits and TLS stay in the platform
 * `grpc` namespace.
 */
export const aiGrpcClientConfig = defineConfigNamespace('aiGrpcClient', aiGrpcClientEnvSchema);
export type AiGrpcClientConfig = ConfigType<typeof aiGrpcClientConfig>;
