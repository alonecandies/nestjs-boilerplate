import type {
  Invitation,
  Member,
  MemberPage,
  MyTenant,
  MyTenantList,
  Tenant,
} from '@domain/identity-contracts';
import { isEmpty } from 'lodash-es';

/** proto-loader decodes absent message fields as null; return the local adapters' exact shapes. */
type Wire<T> = { [K in keyof T]?: T[K] | null };

export const normalizeTenant = (t: Wire<Tenant>): Tenant => ({
  id: t.id ?? '',
  slug: t.slug ?? '',
  name: t.name ?? '',
  personal: t.personal ?? false,
  createdAt: t.createdAt ?? undefined,
});

export function normalizeMyTenant(m: Wire<MyTenant>): MyTenant {
  return {
    ...(m.tenant ? { tenant: normalizeTenant(m.tenant) } : {}),
    roles: m.roles ?? [],
    ...(m.lastActiveAt ? { lastActiveAt: m.lastActiveAt } : {}),
  };
}

export const normalizeMyTenantList = (l: Wire<MyTenantList>): MyTenantList => ({
  items: (l.items ?? []).map(normalizeMyTenant),
});

export const normalizeMember = (m: Wire<Member>): Member => ({
  userId: m.userId ?? '',
  email: m.email ?? '',
  displayName: m.displayName ?? '',
  roles: m.roles ?? [],
  joinedAt: m.joinedAt ?? undefined,
});

export function normalizeMemberPage(p: Wire<MemberPage>): MemberPage {
  return {
    items: (p.items ?? []).map(normalizeMember),
    ...(isEmpty(p.nextCursor) ? {} : { nextCursor: p.nextCursor ?? undefined }),
  };
}

export const normalizeInvitation = (i: Wire<Invitation>): Invitation => ({
  id: i.id ?? '',
  tenantId: i.tenantId ?? '',
  email: i.email ?? '',
  roles: i.roles ?? [],
  expiresAt: i.expiresAt ?? undefined,
  createdAt: i.createdAt ?? undefined,
});
