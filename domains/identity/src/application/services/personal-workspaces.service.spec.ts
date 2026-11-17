import { isUuidV7 } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { TENANT_SLUG_PATTERN } from '../../domain/tenant-slug.js';
import { PersonalWorkspaces } from './personal-workspaces.service.js';

const ada = { email: 'ada.lovelace+test@example.com', displayName: 'Ada' };

describe('PersonalWorkspaces.plan', () => {
  it('plans a personal tenant slugged from the email, with its id generated up front (no writes)', () => {
    const tenant = new PersonalWorkspaces().plan(ada);
    expect(tenant).toEqual({
      id: expect.any(String),
      slug: expect.stringMatching(/^ada-lovelace-test-[0-9a-f]{8}$/),
      name: "Ada's workspace",
      personal: true,
    });
    expect(isUuidV7(tenant.id)).toBe(true);
    expect(tenant.slug.endsWith(tenant.id.slice(-8))).toBe(true);
  });

  it('uses the tenant id the caller chose (register hands it to UserRegisteredEvent too)', () => {
    const id = '0190f3b2-0000-7000-8000-0000000000a1';
    const tenant = new PersonalWorkspaces().plan(ada, id);
    expect(tenant).toMatchObject({ id, personal: true });
    expect(tenant.slug.endsWith(id.slice(-8))).toBe(true);
  });

  it('gives the same local part on two domains two slugs, and slug-less local parts a valid one', () => {
    const workspaces = new PersonalWorkspaces();
    const slugs = [
      workspaces.plan({ ...ada, email: 'ada@a.io' }),
      workspaces.plan({ ...ada, email: 'ada@b.io' }),
      workspaces.plan({ ...ada, email: '+++@x.io' }),
    ].map((tenant) => tenant.slug);
    expect(new Set(slugs).size).toBe(3);
    for (const slug of slugs) expect(slug).toMatch(TENANT_SLUG_PATTERN);
    expect(slugs[2]).toMatch(/^workspace-[0-9a-f]{8}$/);
  });
});
