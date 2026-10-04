import { type GrpcConfig, grpcConfig } from '@app/config';
import {
  GRPC_PACKAGES,
  type ListNotificationsRequest,
  type MarkNotificationReadRequest,
  NOTIFICATIONS_SERVICE_NAME,
  type NotificationPage,
  type NotificationsServiceClient,
} from '@app/contracts';
import {
  callerContextFromCls,
  createOutgoingMetadata,
  GrpcCircuitBreakers,
  grpcCall,
} from '@app/transport';
import type { Metadata } from '@grpc/grpc-js';
import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { ClsService } from 'nestjs-cls';
import type { Observable } from 'rxjs';
import type { NotificationsPort } from '../../../application/ports/notifications.port.js';
import {
  normalizeNotificationPage,
  type WireNotificationPage,
} from './notifications-wire.mapper.js';

const UPSTREAM = 'notifications';

/**
 * Remote binding of `NotificationsPort` (gateway): one unary call per method with a deadline,
 * the `notifications` circuit breaker, and request id / correlation id / user id propagated as
 * metadata. Failures arrive as the same `DomainException`s the local adapter throws (NOT_FOUND →
 * `EntityNotFoundException` with code `NOTIFICATION_NOT_FOUND` via the error trailers), and
 * responses are normalised from proto-loader's `null`s to the local adapter's exact shape.
 */
@Injectable()
export class NotificationsGrpcAdapter implements NotificationsPort, OnModuleInit {
  private service!: NotificationsServiceClient;

  constructor(
    @Inject(GRPC_PACKAGES.notifications.clientToken) private readonly client: ClientGrpc,
    @Inject(grpcConfig.KEY) private readonly cfg: GrpcConfig,
    private readonly breakers: GrpcCircuitBreakers,
    @Optional() private readonly cls?: ClsService,
  ) {}

  onModuleInit(): void {
    this.service = this.client.getService<NotificationsServiceClient>(NOTIFICATIONS_SERVICE_NAME);
  }

  async list(input: ListNotificationsRequest): Promise<NotificationPage> {
    const page = await this.call<WireNotificationPage>(
      'ListNotifications',
      this.service.listNotifications(input, this.metadata(input.userId)),
    );
    return normalizeNotificationPage(page);
  }

  async markRead(input: MarkNotificationReadRequest): Promise<void> {
    await this.call(
      'MarkNotificationRead',
      this.service.markNotificationRead(input, this.metadata(input.userId)),
    );
  }

  private metadata(userId: string): Metadata {
    return createOutgoingMetadata(callerContextFromCls(this.cls, { userId }));
  }

  private call<T>(method: string, source: Observable<T>): Promise<T> {
    return grpcCall(source, {
      timeoutMs: this.cfg.deadlineMs,
      operation: `${GRPC_PACKAGES.notifications.package}.${NOTIFICATIONS_SERVICE_NAME}/${method}`,
      breaker: this.breakers.get(UPSTREAM),
    });
  }
}
