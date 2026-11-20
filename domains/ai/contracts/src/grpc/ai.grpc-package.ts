import { join } from 'node:path';
import type { GrpcPackageSpec } from '@platform/contracts';
// Value import on purpose: registers the Timestamp <-> Date wrapper (see identity.grpc-package.ts).
import { AI_SERVICE_NAME } from '../generated/ai/v1/ai.pb.js';

/**
 * `ai.v1`: AiService (conversations, the chat turn and its server-streamed variant). Only the
 * reads are retried on `UNAVAILABLE`: a chat turn spends tokens and stores messages, and a create or
 * delete is not repeated blindly either.
 */
export const AI_GRPC_PACKAGE: GrpcPackageSpec = {
  package: 'ai.v1',
  protoDir: join(import.meta.dirname, '..', 'proto'),
  protoPath: ['ai/v1/ai.proto'],
  services: [AI_SERVICE_NAME],
  clientToken: 'AI_GRPC_CLIENT',
  idempotentMethods: {
    [AI_SERVICE_NAME]: ['ListConversations', 'GetConversation', 'ListMessages'],
  },
};
