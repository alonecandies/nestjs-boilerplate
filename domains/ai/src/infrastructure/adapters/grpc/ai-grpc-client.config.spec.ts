import { describe, expect, it } from 'vitest';
import { aiGrpcClientConfig } from './ai-grpc-client.config.js';

describe('aiGrpcClientConfig (AI_GRPC_URL, read by AiApiModule.forRemote())', () => {
  it('defaults to ai-service on its host-dev port and a chat deadline above the model timeout', () => {
    expect(aiGrpcClientConfig.parse({})).toEqual({
      url: 'localhost:50054',
      chatDeadlineMs: 70_000,
    });
  });

  it('accepts any grpc-js target syntax and treats a blank value as unset', () => {
    expect(aiGrpcClientConfig.parse({ AI_GRPC_URL: 'dns:///ai-service:50051' }).url).toBe(
      'dns:///ai-service:50051',
    );
    expect(aiGrpcClientConfig.parse({ AI_GRPC_URL: '  ' }).url).toBe('localhost:50054');
  });

  it('bounds the chat deadline', () => {
    expect(aiGrpcClientConfig.parse({ AI_GRPC_CHAT_DEADLINE_MS: '120000' }).chatDeadlineMs).toBe(
      120_000,
    );
    expect(() => aiGrpcClientConfig.parse({ AI_GRPC_CHAT_DEADLINE_MS: '999' })).toThrow();
    expect(() => aiGrpcClientConfig.parse({ AI_GRPC_CHAT_DEADLINE_MS: '900001' })).toThrow();
  });

  it('is its own namespace, owned by ai', () => {
    expect(aiGrpcClientConfig.KEY).toBe('CONFIGURATION(aiGrpcClient)');
  });
});
