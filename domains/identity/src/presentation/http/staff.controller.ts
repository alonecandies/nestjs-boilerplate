import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser, StaffOnly } from '@platform/auth';
import type { RequestLike } from '@platform/common';
import { AuthPort } from '../../application/ports/auth.port.js';
import { StaffTokenNotAllowedException } from '../../domain/identity.errors.js';
import { clientInfoOf } from '../shared/client-info.util.js';
import { StaffSwitchInDto } from './dto/staff-switch-in.dto.js';
import { ProblemResponse } from './responses/problem.response.js';
import { StaffAccessTokenResponse } from './responses/staff-access-token.response.js';

/** Platform-staff support access (spec §5.2): switch-in and switch-out (the first `@StaffOnly()` route). */
@ApiTags('staff')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ProblemResponse })
@Controller({ path: 'staff', version: '1' })
@UseInterceptors(ClassSerializerInterceptor)
export class StaffController {
  constructor(private readonly auth: AuthPort) {}

  @Post('tenants/:tenantId/switch-in')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Enter a tenant as platform staff',
    description:
      'Needs `users.is_platform_staff` (re-read on every call). Returns a short-lived access token ' +
      '(admin + staff, `STAFF_SWITCH_IN_TTL_SEC`), no refresh token. Audited in the tenant. ' +
      'The caller must use its own login token: a switch-in token cannot mint another one.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiCreatedResponse({ type: StaffAccessTokenResponse })
  @ApiBadRequestResponse({ type: ProblemResponse })
  @ApiForbiddenResponse({
    type: ProblemResponse,
    description: '`STAFF_ONLY`, `STAFF_TOKEN_NOT_ALLOWED`',
  })
  @ApiNotFoundResponse({ type: ProblemResponse })
  async switchIn(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: StaffSwitchInDto,
    @CurrentUser() user: AuthUser,
    @Req() request: RequestLike,
  ): Promise<StaffAccessTokenResponse> {
    // A switch-in token must not mint its successor (or a token for another tenant): that would
    // outlive its TTL and session revocation (spec §5.2 "short-lived, no refresh").
    if (user.staff) throw new StaffTokenNotAllowedException();
    const token = await this.auth.staffSwitchIn({
      staffUserId: user.id,
      tenantId,
      reason: body.reason,
      client: clientInfoOf(request),
    });
    return StaffAccessTokenResponse.from(token);
  }

  @Post('switch-out')
  @StaffOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave the tenant (platform staff)',
    description:
      'Revokes the presented switch-in token and records `staff.switch_out`. Switch-in tokens only.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ type: ProblemResponse, description: '`STAFF_ONLY`' })
  async switchOut(@CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.staffSwitchOut({
      staffUserId: user.id,
      tenantId: user.tenantId,
      accessTokenJti: user.jti,
      accessTokenExp: String(user.exp),
    });
  }
}
