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
