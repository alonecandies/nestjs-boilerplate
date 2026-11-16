import type {
  LeaveTenantRequest,
  ListMembersRequest,
  Member,
  MemberPage,
  RemoveMemberRequest,
  UpdateMemberRolesRequest,
} from '@domain/identity-contracts';

/**
 * Tenant members for the presentation layer: local adapter = CQRS buses, remote adapter =
 * `identity.v1.TenantsService` (Task 11).
 */
export abstract class MembersPort {
  /** @throws TenantAccessDeniedException (403) */
  abstract listMembers(input: ListMembersRequest): Promise<MemberPage>;

  /**
   * @throws TenantAccessDeniedException, PermissionDeniedException FORBIDDEN, OwnerRankRequiredException (403),
   *   EntityNotFoundException (404), InvalidRolesException, LastOwnerException (422)
   */
  abstract updateMemberRoles(input: UpdateMemberRolesRequest): Promise<Member>;

  /** @throws as `updateMemberRoles` (no InvalidRolesException) */
  abstract removeMember(input: RemoveMemberRequest): Promise<void>;

  /** @throws TenantAccessDeniedException (403, also for staff switch-in), LastOwnerException (422) */
  abstract leaveTenant(input: LeaveTenantRequest): Promise<void>;
}
