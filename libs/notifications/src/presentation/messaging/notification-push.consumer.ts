import { type EventEnvelopeFor, KAFKA_TOPICS } from '@app/contracts';
import { type GraphqlPubSub, InjectPubSub } from '@app/graphql';
import { InjectRedis, RedisKeyService } from '@app/redis';
import { KafkaConsumerController, KafkaEventPattern, ParseEventEnvelopePipe } from '@app/transport';
import { Logger } from '@nestjs/common';
import { Payload } from '@nestjs/microservices';
import type { Redis } from 'ioredis';
import { notificationFromCreatedPayload } from '../../application/mappers/notification.mapper.js';
import { notificationCreatedTrigger } from '../../notifications.constants.js';
import { toNotificationResponse } from '../http/notifications.dto.js';
import { toNotificationView } from '../notification-view.js';
import { NotificationsGateway } from '../ws/notifications.gateway.js';

type NotificationCreatedEnvelope = EventEnvelopeFor<typeof KAFKA_TOPICS.NOTIFICATION_CREATED>;

/**
 * How long an envelope id is remembered for push deduplication. It covers Kafka redeliveries and
 * prompt re-publishes; a replay after that is rare and only costs a duplicate toast.
 */
export const PUSH_DEDUPE_TTL_SEC = 600;

/**
 * Edge fan-out of `notifications.notification-created.v1` (gateway / monolith). All edge replicas
 * share ONE consumer group, so each event is handled once; the socket.io Redis adapter and
 * RedisPubSub then deliver it to the subscriber on whichever replica holds the connection.
 * Pushes are best-effort by nature: a client that was offline reads the inbox instead.
 *
 * Upstream re-processing (at-least-once redelivery, DLQ replay) re-publishes the event with the
 * same envelope id (= the notification id), so the first delivery claims
 * `push:dedupe:<envelope id>` (`SET NX EX`) and later ones push nothing. If Redis cannot answer,
 * the push goes out anyway: a possible duplicate beats a lost notification.
 */
@KafkaConsumerController()
export class NotificationPushConsumer {
  private readonly logger = new Logger(NotificationPushConsumer.name);

  constructor(
    private readonly gateway: NotificationsGateway,
    @InjectPubSub() private readonly pubSub: GraphqlPubSub,
    @InjectRedis() private readonly redis: Redis,
    private readonly keys: RedisKeyService,
  ) {}

  @KafkaEventPattern(KAFKA_TOPICS.NOTIFICATION_CREATED)
  async onNotificationCreated(
    @Payload(new ParseEventEnvelopePipe(KAFKA_TOPICS.NOTIFICATION_CREATED))
    event: NotificationCreatedEnvelope,
  ): Promise<void> {
    if (!(await this.claimFirstDelivery(event.id))) {
      this.logger.debug(`Skipping already pushed notification-created event ${event.id}`);
      return;
    }
    const { payload } = event;
    this.gateway.pushToUser(
      payload.userId,
      toNotificationResponse(toNotificationView(notificationFromCreatedPayload(payload))),
    );
    // Only the owner's subscriptions listen to this trigger; resolve() maps the payload.
    await this.pubSub.publish(notificationCreatedTrigger(payload.userId), payload);
  }

  /** `true` for the first delivery of `eventId` (or when Redis is unavailable: fail open). */
  private async claimFirstDelivery(eventId: string): Promise<boolean> {
    const key = this.keys.key('notifications', 'push', 'dedupe', eventId);
    try {
      return (await this.redis.set(key, '1', 'EX', PUSH_DEDUPE_TTL_SEC, 'NX')) === 'OK';
    } catch (error) {
      this.logger.warn(
        `Push dedupe unavailable, pushing ${eventId} anyway: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }
}
