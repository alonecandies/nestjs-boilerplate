import {
  DomainConflictException,
  EntityNotFoundException,
  PermissionDeniedException,
} from '@platform/common';
import { AiChatErrorCode } from '../ai.constants.js';

/*
 * Chat errors: DomainException subclasses with stable codes, mapped by every transport (REST
 * problem+json, GraphQL `extensions.code`, gRPC). Messages never carry message content.
 */

/** 404: the conversation does not exist or is not the caller's (RLS hides it either way). */
export class ConversationNotFoundException extends EntityNotFoundException {
  constructor(conversationId: string) {
    super('Conversation', conversationId, { code: AiChatErrorCode.CONVERSATION_NOT_FOUND });
  }
}

/** 409: this `Idempotency-Key` already answered a different message in this conversation. */
export class ChatIdempotencyKeyReusedException extends DomainConflictException {
  constructor() {
    super('This Idempotency-Key was already used for a different message', {
      code: AiChatErrorCode.IDEMPOTENCY_KEY_REUSED,
    });
  }
}

/** 403: the request names a tenant (or user) other than the caller's principal. */
export class AiTenantMismatchException extends PermissionDeniedException {
  constructor() {
    super('The request does not belong to your active workspace', {
      code: AiChatErrorCode.TENANT_MISMATCH,
    });
  }
}
