import { AiErrorCode } from '@platform/ai';
import { describe, expect, it } from 'vitest';
import { AI_SERVICE_ANSWER_CODES, AiChatErrorCode } from './ai.constants.js';

describe('AI_SERVICE_ANSWER_CODES', () => {
  it("are exactly @platform/ai's model-call codes and the chat API's codes", () => {
    expect([...AI_SERVICE_ANSWER_CODES].sort()).toEqual(
      [...Object.values(AiErrorCode), ...Object.values(AiChatErrorCode)].sort(),
    );
  });
});
