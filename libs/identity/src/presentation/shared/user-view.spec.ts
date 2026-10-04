import { generateId, uuidV7Timestamp } from '@app/common';
import { describe, expect, it } from 'vitest';
import { makeUser } from '../../../test/fixtures.js';
import { reviveUser, toUserView } from './user-view.js';

describe('user view', () => {
  it('revives ISO strings from a JSON cache tier into Dates', () => {
    const user = makeUser();
    const fromCache = JSON.parse(JSON.stringify(user)) as typeof user;
    expect(typeof fromCache.createdAt).toBe('string');
    expect(reviveUser(fromCache)).toEqual(user);
  });

  it('falls back to the uuidv7 timestamp when the wire omitted createdAt', () => {
    const id = generateId();
    const view = toUserView(makeUser({ id, createdAt: undefined, updatedAt: undefined }));
    expect(view.createdAt).toEqual(uuidV7Timestamp(id));
    expect(view.updatedAt).toEqual(view.createdAt);
  });

  it('drops role names the RBAC enum does not know', () => {
    expect(toUserView(makeUser({ roles: ['admin', 'root'] })).roles).toEqual(['admin']);
  });
});
