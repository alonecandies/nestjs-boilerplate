import { defineConfig, globalIgnores } from 'eslint/config';
import biome from 'eslint-config-biome';
import tseslint from 'typescript-eslint';

/**
 * ESLint = ONLY type-aware rules. Biome owns formatting + all syntactic lint rules.
 *
 * Order matters: `eslint-config-biome` turns off every ESLint rule that has a Biome equivalent —
 * including type-aware ones Biome only implements in its (disabled) nursery `types` domain
 * (no-floating-promises, no-misused-promises, switch-exhaustiveness-check, consistent-type-imports).
 * The block AFTER it re-enables the ones we want from ESLint.
 */
export default defineConfig(
  globalIgnores([
    '**/dist/',
    '**/coverage/',
    '**/generated/',
    '**/node_modules/',
    '.nx/',
    '**/*.d.ts',
    '**/*.{js,mjs,cjs}',
  ]),
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [tseslint.configs.recommendedTypeCheckedOnly],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  biome,
  {
    files: ['**/*.{ts,mts,cts}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      // Safe with Nest DI: with experimentalDecorators + emitDecoratorMetadata (read from the
      // tsconfig via projectService) the rule skips every file that contains a decorator, so
      // constructor-injected classes are never turned into `import type`.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          disallowTypeAnnotations: true,
        },
      ],
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/no-deprecated': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: false },
      ],
      // Nest lifecycle hooks / resolvers are frequently `async` to satisfy an interface.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.{spec,test,e2e-spec,int-spec}.ts', '**/test/**/*.ts', '**/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
