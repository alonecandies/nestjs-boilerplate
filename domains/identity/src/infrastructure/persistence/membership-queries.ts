import { and, desc, eq, sql } from 'drizzle-orm';
import { memberships } from './identity.schema.js';

/** `ORDER BY last_active_at DESC NULLS LAST, created_at DESC`. */
export const RECENT_FIRST = [
  sql`${memberships.lastActiveAt} desc nulls last`,
  desc(memberships.createdAt),
] as const;

export const membershipOf = (tenantId: string, userId: string) =>
  and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId));
