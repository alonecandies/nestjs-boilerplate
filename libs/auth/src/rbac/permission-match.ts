/** How several required permissions combine: every one of them, or at least one. */
export type PermissionMatchMode = 'all' | 'any';

/** `true` when `granted` satisfies `required` (`'all'` = every one, `'any'` = at least one). */
export function hasPermissions(
  granted: readonly string[],
  required: readonly string[],
  mode: PermissionMatchMode = 'all',
): boolean {
  if (required.length === 0) return true;
  const set = new Set(granted);
  return mode === 'all'
    ? required.every((permission) => set.has(permission))
    : required.some((permission) => set.has(permission));
}
