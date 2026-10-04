import { defineConfig } from 'lint-staged/config';

const biome = 'biome check --write --no-errors-on-unmatched --files-ignore-unknown=true';
const eslint =
  'eslint --fix --max-warnings=0 --no-warn-ignored --cache --cache-location node_modules/.cache/eslint/';

// Globs must NOT overlap: lint-staged runs different globs concurrently, and two writers on the
// same file race. Array values run sequentially (Biome first, then type-aware ESLint).
// NOTE: loaded by Node's native type stripping — erasable TypeScript syntax only.
export default defineConfig({
  '*.{ts,mts,cts}': [biome, eslint],
  '*.{js,mjs,cjs,json,jsonc,graphql,gql,css}': biome,
  '*.{md,yml,yaml}': 'prettier --write --log-level=warn',
});
