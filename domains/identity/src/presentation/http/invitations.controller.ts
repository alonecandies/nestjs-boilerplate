import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { InvitationsPort } from '../../application/ports/invitations.port.js';
import { IdentityPermission } from '../../identity.permissions.js';
import { AcceptInvitationDto } from './dto/accept-invitation.dto.js';
import { CreateInvitationDto } from './dto/create-invitation.dto.js';
import { InvitationResponse } from './responses/invitation.response.js';
import { ProblemResponse } from './responses/problem.response.js';
import { MyTenantResponse } from './responses/tenant.response.js';

/**
 * `POST /v1/tenant/invitations` (invite to the active tenant) and `POST /v1/invitations/accept`,
 * identical in both topologies. Accepting creates no account and sets no password, so it is not a
 * credential endpoint and carries no `@RateLimit`.
 */
@ApiTags('invitations')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ProblemResponse })
@Controller({ version: '1' })
export class InvitationsController {
  constructor(private readonly invitations: InvitationsPort) {}

  @Post('tenant/invitations')
  @RequirePermissions(IdentityPermission.MembersManage)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invite someone to the active tenant by mail',
    description:
      'Owner rank to invite an owner. The mail carries a single-use code valid for 7 days.',
  })
  @ApiCreatedResponse({ type: InvitationResponse })
  @ApiForbiddenResponse({
    type: ProblemResponse,
    description: '`FORBIDDEN`, `OWNER_RANK_REQUIRED`',
  })
  async create(
    @Body() body: CreateInvitationDto,
    @CurrentUser() user: AuthUser,
  ): Promise<InvitationResponse> {
    return InvitationResponse.from(
      await this.invitations.createInvitation({
        tenantId: user.tenantId,
        actorId: user.id,
        email: body.email,
        roles: body.roles,
      }),
    );
  }

  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an invitation with the code from the mail',
    description: 'Any logged-in user whose email equals the invitation email.',
  })
  @ApiOkResponse({ type: MyTenantResponse })
  @ApiForbiddenResponse({
    type: ProblemResponse,
    description: '`INVITATION_EMAIL_MISMATCH`, `TENANT_ACCESS_DENIED` (staff switch-in token)',
  })
  @ApiNotFoundResponse({
    type: ProblemResponse,
    description: '`INVITATION_INVALID` (unknown, expired or already accepted)',
  })
  @ApiConflictResponse({ type: ProblemResponse, description: '`MEMBERSHIP_EXISTS`' })
  async accept(
    @Body() body: AcceptInvitationDto,
    @CurrentUser('id') userId: string,
  ): Promise<MyTenantResponse> {
    return MyTenantResponse.fromMine(
      await this.invitations.acceptInvitation({ userId, token: body.token }),
    );
  }
}
