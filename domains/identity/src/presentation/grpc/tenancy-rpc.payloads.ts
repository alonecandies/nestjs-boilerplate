import type {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  CreateTenantRequest,
  LeaveTenantRequest,
  ListMembersRequest,
  ListMyTenantsRequest,
  RemoveMemberRequest,
  RenameTenantRequest,
  UpdateMemberRolesRequest,
} from '@domain/identity-contracts';
import { isPlatformTenantId, MAX_CURSOR_LENGTH, TENANT_ROLES } from '@platform/common';
import { z } from 'zod';
import { normalizeEmail } from '../../domain/email.js';
import { IDENTITY_LIMITS } from '../../identity.constants.js';

/* Same limits as the REST DTOs; proto-loader nulls become undefined (see identity-rpc.payloads.ts). */
const id = z.uuid();
const tenantId = z
  .uuid()
  .refine((value) => !isPlatformTenantId(value), 'Must be the UUID of a tenant');
const roles = z.array(z.enum(TENANT_ROLES)).min(1).max(TENANT_ROLES.length);
const name = z.string().trim().min(1).max(IDENTITY_LIMITS.TENANT_NAME_MAX_LENGTH);

export const listMyTenantsRequestSchema = z.object({
  userId: id,
}) satisfies z.ZodType<ListMyTenantsRequest>;
export const createTenantRequestSchema = z.object({
  userId: id,
  name,
}) satisfies z.ZodType<CreateTenantRequest>;
export const renameTenantRequestSchema = z.object({
  tenantId,
  actorId: id,
  name,
}) satisfies z.ZodType<RenameTenantRequest>;
export const listMembersRequestSchema = z.object({
  tenantId,
  limit: z.number().int().min(0).max(100),
  cursor: z
    .string()
    .max(MAX_CURSOR_LENGTH)
    .nullish()
    .transform((cursor) => (cursor === null || cursor === '' ? undefined : cursor)),
}) satisfies z.ZodType<ListMembersRequest, unknown>;
export const updateMemberRolesRequestSchema = z.object({
  tenantId,
  actorId: id,
  userId: id,
  roles,
}) satisfies z.ZodType<UpdateMemberRolesRequest>;
export const removeMemberRequestSchema = z.object({
  tenantId,
  actorId: id,
  userId: id,
}) satisfies z.ZodType<RemoveMemberRequest>;
export const leaveTenantRequestSchema = z.object({
  tenantId,
  userId: id,
}) satisfies z.ZodType<LeaveTenantRequest>;
export const createInvitationRequestSchema = z.object({
  tenantId,
  actorId: id,
  email: z.string().transform(normalizeEmail).pipe(z.email().max(IDENTITY_LIMITS.EMAIL_MAX_LENGTH)),
  roles,
}) satisfies z.ZodType<CreateInvitationRequest, unknown>;
export const acceptInvitationRequestSchema = z.object({
  userId: id,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}) satisfies z.ZodType<AcceptInvitationRequest>;
