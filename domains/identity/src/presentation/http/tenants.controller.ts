import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { TenantsPort } from '../../application/ports/tenants.port.js';
import { IdentityPermission } from '../../identity.permissions.js';
import { TenantNameDto } from './dto/tenant-name.dto.js';
import { ProblemResponse } from './responses/problem.response.js';
import { MyTenantResponse, TenantResponse } from './responses/tenant.response.js';

/** `/v1/tenants` (mine, create) and `/v1/tenant` (the active tenant), identical in both topologies. */
@ApiTags('tenants')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ProblemResponse })
@Controller({ version: '1' })
export class TenantsController {
  constructor(private readonly tenants: TenantsPort) {}

  @Get('tenants')
  @ApiOperation({ summary: 'My tenants and my roles in each, most recently active first' })
  @ApiOkResponse({ type: MyTenantResponse, isArray: true })
  async listMine(@CurrentUser('id') userId: string): Promise<MyTenantResponse[]> {
    const list = await this.tenants.listMyTenants({ userId });
    return list.items.map((mine) => MyTenantResponse.fromMine(mine));
  }

  @Post('tenants')
  @ApiOperation({ summary: 'Create a tenant with me as its owner' })
  @ApiCreatedResponse({ type: MyTenantResponse })
  async create(
    @Body() body: TenantNameDto,
    @CurrentUser('id') userId: string,
  ): Promise<MyTenantResponse> {
    return MyTenantResponse.fromMine(await this.tenants.createTenant({ userId, name: body.name }));
  }

  @Patch('tenant')
  @RequirePermissions(IdentityPermission.TenantManage)
  @ApiOperation({ summary: 'Rename the active tenant (owners: tenant:manage)' })
  @ApiOkResponse({ type: TenantResponse })
  @ApiForbiddenResponse({ type: ProblemResponse, description: 'Requires `tenant:manage`.' })
  async rename(
    @Body() body: TenantNameDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TenantResponse> {
    return TenantResponse.from(
      await this.tenants.renameTenant({
        tenantId: user.tenantId,
        actorId: user.id,
        name: body.name,
      }),
    );
  }
}
