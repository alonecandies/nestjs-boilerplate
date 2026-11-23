import type { Member } from '@domain/identity-contracts';
import type { MemberRecord } from '../persistence/memberships.repository.js';

export function toMemberContract(member: MemberRecord): Member {
  return {
    userId: member.userId,
    email: member.email,
    displayName: member.displayName,
    roles: [...member.roles],
    joinedAt: member.joinedAt,
  };
}

/**
 * A member as the directory shows them to `viewerId` (ARCH-4, "names open, PII gated"): complete
 * for the viewer's own row and for a viewer holding `users:read`; otherwise `email` and `roles`
 * are withheld as `""` and `[]` (the proto3 defaults, so the wire and an old gateway's non-null
 * GraphQL fields still accept them; a real member always has a role). REST and GraphQL show them
 * as `null`. User id, display name and join date are always returned.
 */
export function memberForViewer(member: Member, viewerId: string, directory: boolean): Member {
  if (directory || member.userId === viewerId) return member;
  return { ...member, email: '', roles: [] };
}
