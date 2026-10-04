// @commitlint/config-workspace-scopes ships no type declarations.
declare module '@commitlint/config-workspace-scopes' {
  import type { RuleConfigContext } from '@commitlint/types';

  const config: {
    utils: { getPackages(ctx?: RuleConfigContext): Promise<string[]> };
    rules: Record<string, unknown>;
  };
  export default config;
}
