import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  SerializeOptions,
  StandardSchemaSerializerInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { RateLimit } from '@platform/redis';
import { NotificationsPort } from '../../application/ports/notifications.port.js';
import { NotificationsPermission } from '../../notifications.permissions.js';
import { NOTIFICATIONS_RATE_LIMITS } from '../ws/notifications-rate-limit.js';
import {
  type ListNotificationsQueryParams,
  listNotificationsQuerySchema,
  type NotificationPageResponse,
  notificationIdParamSchema,
  notificationPageResponseSchema,
  toNotificationPageResponse,
} from './notifications.dto.js';

/**
 * The caller's inbox. Depends only on `NotificationsPort`, so it is the same class in the
 * monolith (CQRS buses) and the gateway (gRPC). Authentication and RBAC come from the global
 * guards (`JwtAuthGuard` → `RolesGuard` → `PermissionsGuard`); the user id always comes from the
 * token, never from the request.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked access token.' })
@ApiForbiddenResponse({ description: 'The token lacks `notifications:read`.' })
@Controller({ path: 'notifications', version: '1' })
// Response bodies go through the zod response schema: unknown keys are stripped and a contract
// drift fails loudly instead of leaking fields. HTTP-only controller, so no transport branching.
@UseInterceptors(StandardSchemaSerializerInterceptor)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsPort) {}

  @Get()
  @RequirePermissions(NotificationsPermission.Read)
  @ApiOperation({
    summary: 'List my notifications',
    description:
      'Newest first. Paged with an opaque Cassandra paging state: pass `nextPageState` back as `pageState`.',
  })
  @ApiOkResponse({ standardSchema: notificationPageResponseSchema })
  @ApiBadRequestResponse({ description: 'Invalid `limit` or `pageState`.' })
  @SerializeOptions({ schema: notificationPageResponseSchema })
  async list(
    @Query({ schema: listNotificationsQuerySchema }) query: ListNotificationsQueryParams,
    @CurrentUser() user: AuthUser,
  ): Promise<NotificationPageResponse> {
    // The caller's own (tenant, user) inbox: both from the verified token, never from the request.
    const page = await this.notifications.list({
      tenantId: user.tenantId,
      userId: user.id,
      limit: query.limit,
      pageState: query.pageState,
    });
    return toNotificationPageResponse(page);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(NotificationsPermission.Read)
  @RateLimit(NOTIFICATIONS_RATE_LIMITS.MARK_READ)
  @ApiOperation({ summary: 'Mark one of my notifications read', description: 'Idempotent.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Notification id.' })
  @ApiNoContentResponse({ description: 'Marked read (or already read).' })
  @ApiBadRequestResponse({ description: '`id` is not a UUID.' })
  @ApiNotFoundResponse({ description: 'No such notification in the caller’s inbox.' })
  @ApiTooManyRequestsResponse({
    description:
      'Over `NOTIFICATIONS_MARK_READ_LIMIT` marks per window (`notifications.mark-read`, per user).',
  })
  async markRead(
    @Param('id', { schema: notificationIdParamSchema }) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.notifications.markRead({
      tenantId: user.tenantId,
      userId: user.id,
      notificationId: id,
    });
  }
}
