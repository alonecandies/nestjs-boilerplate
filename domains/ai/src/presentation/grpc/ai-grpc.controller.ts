import {
  type AiServiceController,
  AiServiceControllerMethods,
  type Conversation as ConversationContract,
  type ConversationPage,
  type MessagePage,
  type SendMessageResult,
  type StreamMessageEvent,
} from '@domain/ai-contracts';
import { Payload } from '@nestjs/microservices';
import { GrpcController, ZodRpcValidationPipe } from '@platform/transport';
import { Observable } from 'rxjs';
import {
  STREAM_STARTED_EVENT,
  toConversationContract,
  toConversationPageContract,
  toMessagePageContract,
  toSendMessageResultContract,
  toStreamEventContract,
} from '../../application/mappers/ai-contract.mapper.js';
import {
  AiPort,
  type ConversationRequest,
  type CreateConversationRequest,
  type ListConversationsRequest,
  type ListMessagesRequest,
  type SendMessageRequest,
} from '../../application/ports/ai.port.js';
import { ClientDisconnectedError } from '../client-disconnect.js';
import {
  conversationRpcSchema,
  createConversationRpcSchema,
  listConversationsRpcSchema,
  listMessagesRpcSchema,
  sendMessageRpcSchema,
} from './ai-grpc.schemas.js';

/**
 * `ai.v1.AiService` (ai-service) over `AiPort`, which `AiGrpcModule` binds to the CQRS buses of the
 * core. Payloads are zod-validated (`INVALID_ARGUMENT` with issues on failure); `@GrpcController()`
 * adopts the caller's principal from the metadata (the handlers re-check tenant and user against
 * it) and maps DomainExceptions to gRPC statuses + `x-error-code` trailers. Authorization (`ai:chat`)
 * and the `ai.chat` rate limit are the gateway's: only it can reach this port.
 *
 * `StreamMessage` sends `started` once the turn began (a refusal is the call's status, before any
 * event), then the port's events. A cancelled call (the client went away, or its deadline passed)
 * unsubscribes, which aborts the turn's signal: the model call stops and the reply so far is stored
 * as `incomplete`.
 */
@GrpcController()
@AiServiceControllerMethods()
export class AiGrpcController implements AiServiceController {
  constructor(private readonly ai: AiPort) {}

  async createConversation(
    @Payload(new ZodRpcValidationPipe(createConversationRpcSchema))
    request: CreateConversationRequest,
  ): Promise<ConversationContract> {
    return toConversationContract(await this.ai.createConversation(request));
  }

  async listConversations(
    @Payload(new ZodRpcValidationPipe(listConversationsRpcSchema))
    request: ListConversationsRequest,
  ): Promise<ConversationPage> {
    return toConversationPageContract(await this.ai.listConversations(request));
  }

  async getConversation(
    @Payload(new ZodRpcValidationPipe(conversationRpcSchema)) request: ConversationRequest,
  ): Promise<ConversationContract> {
    return toConversationContract(await this.ai.getConversation(request));
  }

  /** Resolves `undefined`, which serialises as `google.protobuf.Empty`. */
  async deleteConversation(
    @Payload(new ZodRpcValidationPipe(conversationRpcSchema)) request: ConversationRequest,
  ): Promise<void> {
    await this.ai.deleteConversation(request);
  }

  async listMessages(
    @Payload(new ZodRpcValidationPipe(listMessagesRpcSchema)) request: ListMessagesRequest,
  ): Promise<MessagePage> {
    return toMessagePageContract(await this.ai.listMessages(request));
  }

  async sendMessage(
    @Payload(new ZodRpcValidationPipe(sendMessageRpcSchema)) request: SendMessageRequest,
  ): Promise<SendMessageResult> {
    return toSendMessageResultContract(await this.ai.sendMessage(request));
  }

  streamMessage(
    @Payload(new ZodRpcValidationPipe(sendMessageRpcSchema)) request: SendMessageRequest,
  ): Observable<StreamMessageEvent> {
    return new Observable<StreamMessageEvent>((subscriber) => {
      const cancel = new AbortController();
      let finished = false;
      const run = async (): Promise<void> => {
        const events = await this.ai.streamMessage({ ...request, signal: cancel.signal });
        if (subscriber.closed) {
          // Cancelled while the turn was starting: release the stream (stores nothing to see).
          await events[Symbol.asyncIterator]().return?.();
          return;
        }
        subscriber.next(STREAM_STARTED_EVENT);
        for await (const event of events) {
          // A cancelled call stops reading: the stream stores the cut reply and ends.
          if (subscriber.closed) break;
          subscriber.next(toStreamEventContract(event));
        }
      };
      run().then(
        () => {
          finished = true;
          subscriber.complete();
        },
        (error: unknown) => {
          finished = true;
          subscriber.error(error);
        },
      );
      // Teardown: on cancel (grpc-js `cancelled` → unsubscribe) abort the turn; after the stream
      // finished there is nothing left to abort.
      return () => {
        if (!finished) cancel.abort(new ClientDisconnectedError());
      };
    });
  }
}
