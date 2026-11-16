import {
  IDENTITY_GRPC_PACKAGE,
  type LeaveTenantRequest,
  type ListMembersRequest,
  type Member,
  type MemberPage,
  type RemoveMemberRequest,
  TENANTS_SERVICE_NAME,
  type TenantsServiceClient,
  type UpdateMemberRolesRequest,
} from '@domain/identity-contracts';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import type { MembersPort } from '../../../application/ports/members.port.js';
import { IdentityGrpcCaller } from './identity-grpc.caller.js';
import { normalizeMember, normalizeMemberPage } from './tenancy-grpc.normalizer.js';

const operation = (method: string): string =>
  `${IDENTITY_GRPC_PACKAGE.package}.${TENANTS_SERVICE_NAME}/${method}`;

/** Gateway binding of `MembersPort`: `identity.v1.TenantsService` over gRPC. */
@Injectable()
export class MembersGrpcAdapter implements MembersPort, OnModuleInit {
  private service: TenantsServiceClient;

  constructor(
    @Inject(IDENTITY_GRPC_PACKAGE.clientToken) private readonly client: ClientGrpc,
    private readonly caller: IdentityGrpcCaller,
  ) {}

  onModuleInit(): void {
    this.service = this.client.getService<TenantsServiceClient>(TENANTS_SERVICE_NAME);
  }

  async listMembers(input: ListMembersRequest): Promise<MemberPage> {
    return normalizeMemberPage(
      await this.caller.call(operation('ListMembers'), (md) => this.service.listMembers(input, md)),
    );
  }

  async updateMemberRoles(input: UpdateMemberRolesRequest): Promise<Member> {
    return normalizeMember(
      await this.caller.call(operation('UpdateMemberRoles'), (md) =>
        this.service.updateMemberRoles(input, md),
      ),
    );
  }

  async removeMember(input: RemoveMemberRequest): Promise<void> {
    await this.caller.call(operation('RemoveMember'), (md) => this.service.removeMember(input, md));
  }

  async leaveTenant(input: LeaveTenantRequest): Promise<void> {
    await this.caller.call(operation('LeaveTenant'), (md) => this.service.leaveTenant(input, md));
  }
}
