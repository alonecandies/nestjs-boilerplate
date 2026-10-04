import workspaceScopes from '@commitlint/config-workspace-scopes';
import { RuleConfigSeverity, type UserConfig } from '@commitlint/types';

/** Scopes allowed in addition to the workspace package names (`@app/gateway` -> `gateway`). */
const EXTRA_SCOPES = [
  'deps',
  'deps-dev',
  'release',
  'docker',
  'ci',
  'config',
  'repo',
  'tooling',
  'docs',
];

const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': async (ctx) => {
      const packages = await workspaceScopes.utils.getPackages(ctx);
      return [RuleConfigSeverity.Error, 'always', [...packages, ...EXTRA_SCOPES]];
    },
    'scope-case': [RuleConfigSeverity.Error, 'always', 'kebab-case'],
    'body-max-line-length': [RuleConfigSeverity.Warning, 'always', 100],
  },
  prompt: {
    settings: { enableMultipleScopes: true, scopeEnumSeparator: ',' },
  },
};

export default config;
