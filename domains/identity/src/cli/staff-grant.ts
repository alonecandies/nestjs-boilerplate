import { normalizeEmail } from '../domain/email.js';
import { createPostgresStaffStore } from './postgres-staff-store.js';

/** The one write the CLI needs: `users.is_platform_staff` by email. */
export interface StaffStore {
  /** @returns the user id, or null when no user has that (normalised) email */
  setPlatformStaff(email: string, staff: boolean): Promise<string | null>;
  close(): Promise<void>;
}

export interface StaffGrantDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  connect(url: string): StaffStore;
  out(line: string): void;
  err(line: string): void;
}

const USAGE = 'Usage: staff:grant <email> [--revoke]';
const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+$/.test(value);

const defaultDeps = (): StaffGrantDeps => ({
  env: process.env,
  connect: createPostgresStaffStore,
  out: (line) => console.info(line),
  err: (line) => console.error(line),
});

/**
 * `bun run --filter @domain/identity staff:grant <email> [--revoke]` (spec §5.2, §9 method 7): the only
 * way to grant or revoke platform staff. Uses DATABASE_MIGRATION_URL (B3-3's owner role) when set,
 * else DATABASE_URL. Exit codes: 0 done, 1 unknown email or database failure, 2 usage/configuration.
 */
export async function runStaffGrantCli(
  args: readonly string[] = process.argv.slice(2),
  deps: StaffGrantDeps = defaultDeps(),
): Promise<number> {
  const flags = args.filter((arg) => arg.startsWith('--'));
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const email = positional.length === 1 ? normalizeEmail(positional[0] ?? '') : '';
  if (!looksLikeEmail(email) || flags.some((flag) => flag !== '--revoke')) {
    deps.err(USAGE);
    return 2;
  }
  const staff = !flags.includes('--revoke');
  const url = deps.env.DATABASE_MIGRATION_URL || deps.env.DATABASE_URL;
  if (!url) {
    deps.err('Set DATABASE_MIGRATION_URL or DATABASE_URL.');
    return 2;
  }

  const store = deps.connect(url);
  try {
    const id = await store.setPlatformStaff(email, staff);
    if (id === null) {
      deps.err(`No user with email ${email}.`);
      return 1;
    }
    deps.out(
      staff
        ? `Granted platform staff to ${email} (${id}).`
        : `Revoked platform staff from ${email} (${id}).`,
    );
    return 0;
  } catch (error) {
    deps.err(`staff:grant failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await store.close();
  }
}
