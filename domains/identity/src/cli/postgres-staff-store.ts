import postgres from 'postgres';
import type { StaffStore } from './staff-grant.js';

/** postgres.js over one connection; `email` is already normalised (users.email stores that form). */
export function createPostgresStaffStore(url: string): StaffStore {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  return {
    async setPlatformStaff(email, staff) {
      const rows = await sql<{ id: string }[]>`
        update identity.users
           set is_platform_staff = ${staff}, updated_at = now()
         where email = ${email}
     returning id`;
      return rows[0]?.id ?? null;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
