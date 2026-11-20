import { Query } from '@nestjs/cqrs';
import type { CursorPage } from '@platform/common';
import type { Message } from '../../../domain/ai.types.js';
import type { ListMessagesRequest } from '../../ports/ai.port.js';

export class ListMessagesQuery extends Query<CursorPage<Message>> {
  constructor(readonly request: ListMessagesRequest) {
    super();
  }
}
