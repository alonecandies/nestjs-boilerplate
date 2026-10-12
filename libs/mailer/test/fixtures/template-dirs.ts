import { join } from 'node:path';

/**
 * Two template folders for the mailer specs, standing in for two domains that register templates:
 * `greeting.hbs` lives in the first, `farewell.hbs` only in the second.
 */
export const FIXTURE_TEMPLATES_DIR = join(import.meta.dirname, 'templates');
export const FIXTURE_MORE_TEMPLATES_DIR = join(import.meta.dirname, 'more-templates');
export const FIXTURE_TEMPLATE_DIRS = [FIXTURE_TEMPLATES_DIR, FIXTURE_MORE_TEMPLATES_DIR] as const;
