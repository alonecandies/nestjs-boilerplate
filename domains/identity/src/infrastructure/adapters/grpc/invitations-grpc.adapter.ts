import {
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  IDENTITY_GRPC_PACKAGE,
  type Invitation,
  type MyTenant,
  TENANTS_SERVICE_NAME,
  type TenantsServiceClient,
} from '@domain/identity-contracts';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import type { InvitationsPort } from '../../../application/ports/invitations.port.js';
import { IdentityGrpcCaller } from './identity-grpc.caller.js';
import { normalizeInvitation, normalizeMyTenant } from './tenancy-grpc.normalizer.js';

const operation = (method: string): string =>
  `${IDENTITY_GRPC_PACKAGE.package}.${TENANTS_SERVICE_NAME}/${method}`;

/** Gateway binding of `InvitationsPort`: `identity.v1.TenantsService` over gRPC. */
@Injectable()
export class InvitationsGrpcAdapter implements InvitationsPort, OnModuleInit {
  private service: TenantsServiceClient;

  constructor(
    @Inject(IDENTITY_GRPC_PACKAGE.clientToken) private readonly client: ClientGrpc,
    private readonly caller: IdentityGrpcCaller,
  ) {}

  onModuleInit(): void {
    this.service = this.client.getService<TenantsServiceClient>(TENANTS_SERVICE_NAME);
  }

  async createInvitation(input: CreateInvitationRequest): Promise<Invitation> {
    return normalizeInvitation(
      await this.caller.call(operation('CreateInvitation'), (md) =>
        this.service.createInvitation(input, md),
      ),
    );
  }

  async acceptInvitation(input: AcceptInvitationRequest): Promise<MyTenant> {
    return normalizeMyTenant(
      await this.caller.call(operation('AcceptInvitation'), (md) =>
        this.service.acceptInvitation(input, md),
      ),
    );
  }
}
