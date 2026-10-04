import { Role } from '@app/auth';
import { registerEnumType } from '@nestjs/graphql';

/**
 * GraphQL `Role` enum: conventional SCREAMING_CASE names, internal values = @app/auth `Role`
 * (`ADMIN` ↔ `'admin'`), so resolvers and inputs work with plain `Role` values. Registered once,
 * here; other domains reference it through `UserModel`.
 */
export const RoleEnum = {
  ADMIN: Role.Admin,
  MODERATOR: Role.Moderator,
  USER: Role.User,
} as const satisfies Record<string, Role>;

registerEnumType(RoleEnum, {
  name: 'Role',
  description: 'RBAC role',
  valuesMap: {
    ADMIN: { description: 'Everything, including role management' },
    MODERATOR: { description: 'Reads users; manages notifications and files' },
    USER: { description: 'Default role of every account' },
  },
});
