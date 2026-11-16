import type {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  Invitation,
  MyTenant,
} from '@domain/identity-contracts';

/**
 * Invitations for the presentation layer: local adapter = CQRS buses, remote adapter =
 * `identity.v1.TenantsService` (Task 11).
 */
export abstract class InvitationsPort {
  /**
   * @throws TenantAccessDeniedException, PermissionDeniedException FORBIDDEN, OwnerRankRequiredException (403),
   *   InvalidRolesException (422), EntityNotFoundException (404)
   */
  abstract createInvitation(input: CreateInvitationRequest): Promise<Invitation>;

  /**
   * @throws InvitationInvalidException (404), InvitationEmailMismatchException,
   *   TenantAccessDeniedException (403, also for staff switch-in), MembershipAlreadyExistsException (409)
   */
  abstract acceptInvitation(input: AcceptInvitationRequest): Promise<MyTenant>;
}
