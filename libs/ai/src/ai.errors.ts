import {
  type DomainExceptionOptions,
  DomainValidationException,
  ExternalServiceException,
  OperationTimeoutException,
  ServiceUnavailableException,
} from '@platform/common';

/** Stable codes of the errors `AiClient` throws (HTTP problem+json, gRPC, GraphQL). */
export const AiErrorCode = {
  AI_DISABLED: 'AI_DISABLED',
  AI_MODEL_NOT_ALLOWED: 'AI_MODEL_NOT_ALLOWED',
  AI_INPUT_TOO_LARGE: 'AI_INPUT_TOO_LARGE',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_UPSTREAM_ERROR: 'AI_UPSTREAM_ERROR',
} as const;

/** 503: `AI_ENABLED=false`; thrown before any model is built or called. */
export class AiDisabledError extends ServiceUnavailableException {
  constructor() {
    super('AI features are disabled', { code: AiErrorCode.AI_DISABLED });
  }
}

/** 422: the requested model is not the default model nor in `AI_ALLOWED_MODELS`. */
export class AiModelNotAllowedError extends DomainValidationException {
  constructor(model: string) {
    super('The requested model is not allowed', {
      code: AiErrorCode.AI_MODEL_NOT_ALLOWED,
      details: { model },
    });
  }
}

/** 422: the messages hold more text than `AI_MAX_INPUT_CHARS`. */
export class AiInputTooLargeError extends DomainValidationException {
  constructor(maxInputChars: number) {
    super('The conversation is too long for one request', {
      code: AiErrorCode.AI_INPUT_TOO_LARGE,
      details: { maxInputChars },
    });
  }
}

/** 504: the call ran longer than `AI_REQUEST_TIMEOUT_MS` and was aborted. */
export class AiTimeoutError extends OperationTimeoutException {
  constructor(timeoutMs: number, options?: Pick<DomainExceptionOptions, 'cause'>) {
    super('The AI model did not answer in time', {
      ...options,
      code: AiErrorCode.AI_TIMEOUT,
      details: { timeoutMs },
    });
  }
}

/**
 * 502: OpenRouter or the model failed (after the SDK's retries). The cause stays for the server
 * logs only; it is never serialized, and the client logs only its name and status code.
 */
export class AiUpstreamError extends ExternalServiceException {
  constructor(options?: Pick<DomainExceptionOptions, 'cause'>) {
    super('The AI model failed to answer', { ...options, code: AiErrorCode.AI_UPSTREAM_ERROR });
  }
}
