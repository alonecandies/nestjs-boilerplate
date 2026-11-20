import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { AiDisabledError, AiModelNotAllowedError } from '@platform/ai';
import { generateId } from '@platform/common';
import { type AiConfig, aiConfig } from '@platform/config';
import type { Conversation } from '../../../domain/ai.types.js';
import { requireCaller } from '../../caller-scope.js';
import { ConversationsRepository } from '../../repositories/conversations.repository.js';
import { CreateConversationCommand } from './create-conversation.command.js';

/**
 * A new, empty conversation of the caller on `model` (default `AI_DEFAULT_MODEL`). Refused while
 * `AI_ENABLED=false` (503: a thread nobody can talk to) and for a model outside the allowlist (422).
 */
@CommandHandler(CreateConversationCommand)
export class CreateConversationHandler implements ICommandHandler<CreateConversationCommand> {
  constructor(
    private readonly conversations: ConversationsRepository,
    @Inject(aiConfig.KEY) private readonly config: AiConfig,
  ) {}

  async execute({ request }: CreateConversationCommand): Promise<Conversation> {
    requireCaller(request);
    if (!this.config.enabled) throw new AiDisabledError();
    const model = request.model ?? this.config.defaultModel;
    if (!this.config.allowedModels.includes(model)) throw new AiModelNotAllowedError(model);
    const now = new Date();
    const conversation: Conversation = {
      tenantId: request.tenantId,
      id: generateId(),
      userId: request.userId,
      title: request.title ?? null,
      model,
      createdAt: now,
      updatedAt: now,
    };
    await this.conversations.create(conversation);
    return conversation;
  }
}
