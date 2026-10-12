import { join } from 'node:path';

/**
 * Folder of the notifications mail templates, next to this module. SWC `copyFiles` ships the
 * `.hbs` files to `dist`, so `import.meta.dirname` resolves the folder from `src` (dev, tests) and
 * from `dist` (production). Processes that deliver notifications mail register it:
 * `AppMailerModule.forRootAsync({ templateDirs: [NOTIFICATIONS_MAIL_TEMPLATES_DIR] })`. The layout
 * partials come from `@platform/mailer`.
 */
export const NOTIFICATIONS_MAIL_TEMPLATES_DIR = join(import.meta.dirname, 'templates');
