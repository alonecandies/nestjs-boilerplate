import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { MembersPort } from '../../application/ports/members.port.js';
import { IdentityPermission } from '../../identity.permissions.js';
import { ListMembersQueryDto } from './dto/list-members-query.dto.js';
import { MemberRolesDto } from './dto/member-roles.dto.js';
import { MemberPageResponse, MemberResponse } from './responses/member.response.js';
import { ProblemResponse } from './responses/problem.response.js';

const userIdPipe = new ParseUUIDPipe({ version: '7' });

/** `/v1/tenant/members` and `/v1/tenant/leave`: the active tenant's members, identical in both topologies. */
@ApiTags('tenant members')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ProblemResponse })
@Controller({ path: 'tenant', version: '1' })
export class MembersController {
  constructor(private readonly members: MembersPort) {}

  @Get('members')
  @ApiOperation({ summary: 'Members of the active tenant (keyset pages)' })
  @ApiOkResponse({ type: MemberPageResponse })
  async list(
    @Query() query: ListMembersQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MemberPageResponse> {
    return MemberPageResponse.from(
      await this.members.listMembers({
        tenantId: user.tenantId,
        limit: query.limit ?? 0,
        cursor: query.cursor,
      }),
    );
  }

  @Patch('members/:userId')
  @RequirePermissions(IdentityPermission.MembersManage)
  @ApiOperation({
    summary: "Replace a member's roles",
    description: 'Owner rank to grant or revoke owner; never the last owner.',
  })
  @ApiOkResponse({ type: MemberResponse })
  @ApiForbiddenResponse({
    type: ProblemResponse,
    description: '`FORBIDDEN`, `OWNER_RANK_REQUIRED`',
  })
  @ApiUnprocessableEntityResponse({
    type: ProblemResponse,
    description: '`LAST_OWNER`, `INVALID_ROLES`',
  })
  async updateRoles(
    @Param('userId', userIdPipe) userId: string,
    @Body() body: MemberRolesDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MemberResponse> {
    return MemberResponse.from(
      await this.members.updateMemberRoles({
        tenantId: user.tenantId,
        actorId: user.id,
        userId,
        roles: body.roles,
      }),
    );
  }

  @Delete('members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(IdentityPermission.MembersManage)
  @ApiOperation({ summary: 'Remove a member from the active tenant' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({
    type: ProblemResponse,
    description: '`FORBIDDEN`, `OWNER_RANK_REQUIRED`',
  })
  @ApiUnprocessableEntityResponse({ type: ProblemResponse, description: '`LAST_OWNER`' })
  async remove(
    @Param('userId', userIdPipe) userId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.members.removeMember({ tenantId: user.tenantId, actorId: user.id, userId });
  }

  @Post('leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave the active tenant (the last owner cannot)' })
  @ApiNoContentResponse()
  @ApiUnprocessableEntityResponse({ type: ProblemResponse, description: '`LAST_OWNER`' })
  async leave(@CurrentUser() user: AuthUser): Promise<void> {
    await this.members.leaveTenant({ tenantId: user.tenantId, userId: user.id });
  }
}
