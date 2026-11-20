import { join } from 'node:path';
import {
  boundRpcPatterns,
  loadGrpcPackages,
  protoFilesUnder,
  wireRoundTrip,
} from '@platform/contracts/testing';
import { describe, expect, it } from 'vitest';
import {
  AI_GRPC_PACKAGE,
  AiServiceControllerMethods,
  type Conversation,
  type StreamMessageEvent,
} from '../index.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const root = loadGrpcPackages([AI_GRPC_PACKAGE]);

describe('AI_GRPC_PACKAGE', () => {
  it('resolves its protos under <package>/src/proto and registers every ai proto', () => {
    expect(AI_GRPC_PACKAGE.protoDir).toBe(join(PACKAGE_ROOT, 'src', 'proto'));
    const own = protoFilesUnder(AI_GRPC_PACKAGE.protoDir).filter((file) => file.startsWith('ai/'));
    expect(own).toEqual([...AI_GRPC_PACKAGE.protoPath].sort());
  });

  it('declares the protobuf package and service the proto defines', () => {
    expect(root.lookup('ai.v1')).toBeDefined();
    expect(AI_GRPC_PACKAGE.services).toEqual(['AiService']);
    expect(root.lookupService('ai.v1.AiService').name).toBe('AiService');
  });

  it('retries only the reads, never a chat turn, a create or a delete', () => {
    const ai = root.lookupService('ai.v1.AiService');
    expect(AI_GRPC_PACKAGE.idempotentMethods).toEqual({
      AiService: ['ListConversations', 'GetConversation', 'ListMessages'],
    });
    for (const method of AI_GRPC_PACKAGE.idempotentMethods?.['AiService'] ?? []) {
      expect(ai.methods[method], method).toBeDefined();
    }
  });

  it('StreamMessage is server-streaming; every other rpc is unary', () => {
    const ai = root.lookupService('ai.v1.AiService');
    const streaming = ai.methodsArray.filter((method) => method.responseStream === true);
    expect(streaming.map((method) => method.name)).toEqual(['StreamMessage']);
    expect(ai.methodsArray.some((method) => method.requestStream === true)).toBe(false);
  });

  it('generated AiService decorator binds every rpc of the proto', () => {
    const service = root.lookupService('ai.v1.AiService');
    expect(boundRpcPatterns(AiServiceControllerMethods, service)).toEqual(
      service.methodsArray.map((method) => [
        {
          service: 'AiService',
          rpc: method.name.charAt(0).toLowerCase() + method.name.slice(1),
          streaming: 'no_stream',
        },
      ]),
    );
  });
});

describe('ai.v1 wire format (proto-loader semantics + generated types)', () => {
  it('decodes Timestamps as Date and an absent optional field as undefined', () => {
    const conversation: Conversation = {
      tenantId: 't1',
      id: 'c1',
      userId: 'u1',
      model: 'openai/gpt-4o-mini',
      createdAt: new Date('2026-11-20T10:00:00.123Z'),
      updatedAt: new Date('2026-11-20T10:00:01.000Z'),
    };
    const decoded = wireRoundTrip(root, 'ai.v1.Conversation', conversation);
    expect(decoded['createdAt']).toEqual(new Date('2026-11-20T10:00:00.123Z'));
    expect(decoded['title']).toBeUndefined();
  });

  it('names the set member of the stream event oneof (`event`) and leaves the others out', () => {
    const delta: StreamMessageEvent = { delta: { text: 'Hel' } };
    const decoded = wireRoundTrip(root, 'ai.v1.StreamMessageEvent', delta);
    expect(decoded['event']).toBe('delta');
    expect(decoded['delta']).toEqual({ text: 'Hel' });
    expect(decoded['done']).toBeUndefined();

    const started = wireRoundTrip(root, 'ai.v1.StreamMessageEvent', { started: {} });
    expect(started['event']).toBe('started');
  });

  it('keeps an absent usage on done distinct from zero tokens', () => {
    const replay = wireRoundTrip(root, 'ai.v1.StreamDone', { replayed: true });
    expect(replay['usage']).toBeNull();
    const counted = wireRoundTrip(root, 'ai.v1.StreamDone', {
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(counted['usage']).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
