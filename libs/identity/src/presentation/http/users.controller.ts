import { type AuthUser, CurrentUser, Permission, RequirePermissions } from '@app/auth';
import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { UsersPort } from '../../application/ports/users.port.js';
import { assertCanReadUser } from '../shared/user-access.policy.js';
import { UserReadCache } from '../shared/user-read.cache.js';
import { ListUsersQueryDto } from './dto/list-users-query.dto.js';
import { UpdateUserRolesDto } from './dto/update-user-roles.dto.js';
import { ProblemResponse } from './responses/problem.response.js';
import { UserResponse } from './responses/user.response.js';
import { UserPageResponse } from './responses/user-page.response.js';

/** uuidv7 ids only: anything else is a 400 before it reaches the cache or the database. */
const userIdPipe = new ParseUUIDPipe({ version: '7' });

@ApiTags('users')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ProblemResponse })
@Controller({ path: 'users', version: '1' })
@UseInterceptors(ClassSerializerInterceptor)
export class UsersController {
  constructor(
    private readonly users: UsersPort,
    private readonly cache: UserReadCache,
  ) {}

  @Get()
  @RequirePermissions(Permission.UsersRead)
  @ApiOperation({ summary: 'List users (keyset pagination, newest first)' })
  @ApiOkResponse({ type: UserPageResponse })
  @ApiBadRequestResponse({ type: ProblemResponse })
  @ApiForbiddenResponse({ type: ProblemResponse, description: 'Requires `users:read`.' })
  @ApiUnprocessableEntityResponse({ type: ProblemResponse, description: '`INVALID_CURSOR`' })
  async list(@Query() query: ListUsersQueryDto): Promise<UserPageResponse> {
    const page = await this.users.listUsers({
      limit: query.limit,
      cursor: query.cursor,
      search: query.search,
    });
    return UserPageResponse.from(page);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user (yourself, or anyone with `users:read`)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: UserResponse })
  @ApiBadRequestResponse({ type: ProblemResponse, description: 'Not a uuidv7.' })
  @ApiForbiddenResponse({ type: ProblemResponse })
  @ApiNotFoundResponse({ type: ProblemResponse })
  async getById(
    @Param('id', userIdPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<UserResponse> {
    assertCanReadUser(actor, id);
    return UserResponse.from(await this.cache.getUser(id));
  }

  @Patch(':id/roles')
  @RequirePermissions(Permission.UsersManageRoles)
  @ApiOperation({
    summary: "Replace a user's roles",
    description:
      'Effective on the next token refresh. Admins cannot remove their own admin role, and the last admin cannot be demoted.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: UserResponse })
  @ApiBadRequestResponse({ type: ProblemResponse })
  @ApiForbiddenResponse({ type: ProblemResponse, description: 'Requires `users:manage-roles`.' })
  @ApiNotFoundResponse({ type: ProblemResponse })
  @ApiUnprocessableEntityResponse({
    type: ProblemResponse,
    description: '`CANNOT_REVOKE_OWN_ADMIN`, `CANNOT_REMOVE_LAST_ADMIN`',
  })
  async updateRoles(
    @Param('id', userIdPipe) id: string,
    @Body() body: UpdateUserRolesDto,
    @CurrentUser('id') actorId: string,
  ): Promise<UserResponse> {
    const user = await this.users.updateUserRoles({ id, roles: body.roles, actorId });
    await this.cache.invalidate(id);
    return UserResponse.from(user);
  }
}
