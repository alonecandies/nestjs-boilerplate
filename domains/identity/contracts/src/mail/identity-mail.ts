import { join } from 'node:path';

/**
 * Identity's mail templates. Identity enqueues on the shared BullMQ `mail` queue; every process that runs
 * `MailProcessor` (monolith, notifications-service) registers this folder:
 * `AppMailerModule.forRootAsync({ templateDirs: [..., IDENTITY_MAIL_TEMPLATES_DIR] })`. SWC `copyFiles` ships
 * the `.hbs` files to `dist`, so `import.meta.dirname` works from `src` and `dist`.
 */
export const IDENTITY_MAIL_TEMPLATES_DIR = join(import.meta.dirname, 'templates');

export const IDENTITY_MAIL_TEMPLATES = { TENANT_INVITATION: 'tenant-invitation' } as const;

/** Context of `tenant-invitation.hbs` (the layout adds `appName`, `year`, `appUrl`). */
export interface TenantInvitationMailContext {
  tenantName: string;
  inviterName: string;
  /** Human list, e.g. "admin". */
  roles: string;
  /** The raw invitation token (also embedded in `acceptUrl`). */
  token: string;
  /** `${MAIL_APP_URL}/invitations/accept?token=…`, or null when MAIL_APP_URL is not set. */
  acceptUrl: string | null;
  /** ISO-8601 expiry. */
  expiresAt: string;
}
