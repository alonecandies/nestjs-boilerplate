import { type EventEnvelopeFor, KAFKA_TOPICS } from '@app/contracts';
import { type GraphqlPubSub, InjectPubSub } from '@app/graphql';
import { KafkaConsumerController, KafkaEventPattern, ParseEventEnvelopePipe } from '@app/transport';
import { Payload } from '@nestjs/microservices';
import { notificationFromCreatedPayload } from '../../application/mappers/notification.mapper.js';
import { NOTIFICATION_CREATED_TRIGGER } from '../../notifications.constants.js';
import { toNotificationResponse } from '../http/notifications.dto.js';
import { toNotificationView } from '../notification-view.js';
import { NotificationsGateway } from '../ws/notifications.gateway.js';

type NotificationCreatedEnvelope = EventEnvelopeFor<typeof KAFKA_TOPICS.NOTIFICATION_CREATED>;

/**
 * Edge fan-out of `notifications.notification-created.v1` (gateway / monolith). All edge replicas
 * share ONE consumer group, so each event is handled once; the socket.io Redis adapter and
 * RedisPubSub then deliver it to the subscriber on whichever replica holds the connection.
 * Pushes are best-effort by nature: a client that was offline reads the inbox instead.
 */
@KafkaConsumerController()
export class NotificationPushConsumer {
  constructor(
    private readonly gateway: NotificationsGateway,
    @InjectPubSub() private readonly pubSub: GraphqlPubSub,
  ) {}

  @KafkaEventPattern(KAFKA_TOPICS.NOTIFICATION_CREATED)
  async onNotificationCreated(
    @Payload(new ParseEventEnvelopePipe(KAFKA_TOPICS.NOTIFICATION_CREATED))
    event: NotificationCreatedEnvelope,
  ): Promise<void> {
    const { payload } = event;
    this.gateway.pushToUser(
      payload.userId,
      toNotificationResponse(toNotificationView(notificationFromCreatedPayload(payload))),
    );
    // The subscription's resolve() maps the payload; its filter keeps it to the owner.
    await this.pubSub.publish(NOTIFICATION_CREATED_TRIGGER, payload);
  }
}
