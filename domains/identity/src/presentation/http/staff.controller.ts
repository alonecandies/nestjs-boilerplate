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
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '@platform/auth';
import type { RequestLike } from '@platform/common';
import { AuthPort } from '../../application/ports/auth.port.js';
import { clientInfoOf } from '../shared/client-info.util.js';
import { StaffSwitchInDto } from './dto/staff-switch-in.dto.js';
import { ProblemResponse } from './responses/problem.response.js';
import { StaffAccessTokenResponse } from './responses/staff-access-token.response.js';

/** Platform-staff support access (spec §5.2): switch-in here, switch-out in Task 16. */
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
      '(admin + staff, `STAFF_SWITCH_IN_TTL_SEC`), no refresh token. Audited in the tenant.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiCreatedResponse({ type: StaffAccessTokenResponse })
  @ApiBadRequestResponse({ type: ProblemResponse })
  @ApiForbiddenResponse({ type: ProblemResponse, description: '`STAFF_ONLY`' })
  @ApiNotFoundResponse({ type: ProblemResponse })
  async switchIn(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: StaffSwitchInDto,
    @CurrentUser() user: AuthUser,
    @Req() request: RequestLike,
  ): Promise<StaffAccessTokenResponse> {
    const token = await this.auth.staffSwitchIn({
      staffUserId: user.id,
      tenantId,
      reason: body.reason,
      client: clientInfoOf(request),
    });
    return StaffAccessTokenResponse.from(token);
  }
}
