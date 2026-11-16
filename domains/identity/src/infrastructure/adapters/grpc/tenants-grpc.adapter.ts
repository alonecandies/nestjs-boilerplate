import {
  type CreateTenantRequest,
  IDENTITY_GRPC_PACKAGE,
  type ListMyTenantsRequest,
  type MyTenant,
  type MyTenantList,
  type RenameTenantRequest,
  TENANTS_SERVICE_NAME,
  type Tenant,
  type TenantsServiceClient,
} from '@domain/identity-contracts';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import type { TenantsPort } from '../../../application/ports/tenants.port.js';
import { IdentityGrpcCaller } from './identity-grpc.caller.js';
import {
  normalizeMyTenant,
  normalizeMyTenantList,
  normalizeTenant,
} from './tenancy-grpc.normalizer.js';

const operation = (method: string): string =>
  `${IDENTITY_GRPC_PACKAGE.package}.${TENANTS_SERVICE_NAME}/${method}`;

/** Gateway binding of `TenantsPort`: `identity.v1.TenantsService` over gRPC. */
@Injectable()
export class TenantsGrpcAdapter implements TenantsPort, OnModuleInit {
  private service: TenantsServiceClient;

  constructor(
    @Inject(IDENTITY_GRPC_PACKAGE.clientToken) private readonly client: ClientGrpc,
    private readonly caller: IdentityGrpcCaller,
  ) {}

  onModuleInit(): void {
    this.service = this.client.getService<TenantsServiceClient>(TENANTS_SERVICE_NAME);
  }

  async listMyTenants(input: ListMyTenantsRequest): Promise<MyTenantList> {
    return normalizeMyTenantList(
      await this.caller.call(operation('ListMyTenants'), (md) =>
        this.service.listMyTenants(input, md),
      ),
    );
  }

  async createTenant(input: CreateTenantRequest): Promise<MyTenant> {
    return normalizeMyTenant(
      await this.caller.call(operation('CreateTenant'), (md) =>
        this.service.createTenant(input, md),
      ),
    );
  }

  async renameTenant(input: RenameTenantRequest): Promise<Tenant> {
    return normalizeTenant(
      await this.caller.call(operation('RenameTenant'), (md) =>
        this.service.renameTenant(input, md),
      ),
    );
  }
}
