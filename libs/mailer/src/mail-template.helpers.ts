import type { HelperDeclareSpec } from 'handlebars';
import { dropRight, isString, join, map, toString as stringify } from 'lodash-es';

/**
 * Handlebars helpers available to every template. Kept tiny and logic-free: templates format
 * nothing themselves, callers pass pre-formatted strings (`formatMoney`, dates).
 */
export const MAIL_TEMPLATE_HELPERS = {
  /**
   * `(concat "a" b "c")` → string. HandlebarsAdapter registers the same helper; it is declared
   * here as well so templates render identically when compiled directly (tests, previews).
   */
  concat: (...args: unknown[]): string => join(map(dropRight(args), stringify), ''),
  /** `{{plural count "item" "items"}}` */
  plural: (count: unknown, singular: unknown, plural: unknown): string => {
    const form = count === 1 ? singular : plural;
    return isString(form) ? form : '';
  },
} satisfies HelperDeclareSpec;
