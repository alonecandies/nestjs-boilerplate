import { ROLE_VALUES } from '@app/auth';
import { sortBy } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { isUserRole, USER_ROLES } from './user-role.js';

describe('USER_ROLES', () => {
  it('lists exactly the RBAC roles of @app/auth (pgEnum user_role stays in sync)', () => {
    expect(sortBy([...USER_ROLES])).toEqual(sortBy([...ROLE_VALUES]));
  });

  it('isUserRole narrows known names only', () => {
    expect(isUserRole('admin')).toBe(true);
    expect(isUserRole('root')).toBe(false);
    expect(isUserRole(1)).toBe(false);
  });
});
