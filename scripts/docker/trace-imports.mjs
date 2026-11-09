// Static import tracer shared by scripts/check-api-subpaths.mjs (TypeScript sources) and
// scripts/docker/assemble-image.mjs (compiled dist/). Pure Node, no dependencies: the Dockerfile runs
// it on the toolchain image before anything is installed globally.
//
// It reads specifiers with regular expressions, not a parser. That is enough for our own code (Biome-
// formatted sources and swc output): string-literal specifiers only; template literals and computed
// `import(x)` are invisible (assemble-image's load check catches those). Comment stripping is
// lexical too: a `/*` inside a string (a glob such as '/*.js') hides the code up to the next `*/`.
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
// `//` not preceded by `:` (URLs), a quote or a backslash.
const LINE_COMMENT = /(^|[^:'"`\\])\/\/.*$/gm;
// `import type …` / `export type … from …`: erased by the compiler, never loaded.
const TYPE_ONLY = /(^|[;\n])\s*(?:import|export)\s+type\s[^;]*?\bfrom\s*(['"])[^'"\n]+\2\s*;?/g;
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\brequire\.resolve\s*\(\s*|\)\.resolve\s*\(\s*)(['"])([^'"\n]+)\1/g;

/** Unique module specifiers of one JS/TS source, in order of appearance. */
export function collectSpecifiers(code) {
  const stripped = code
    .replace(BLOCK_COMMENT, '')
    .replace(LINE_COMMENT, '$1')
    .replace(TYPE_ONLY, '$1');
  return [...new Set([...stripped.matchAll(SPECIFIER)].map((match) => match[2]))];
}

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`; undefined for relative and builtin specifiers. */
export function packageNameOf(specifier) {
  if (/^[./#]/.test(specifier) || isBuiltin(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Follows imports from `entries` (absolute paths). `resolveFile(specifier, fromFile)` returns the absolute
 * file a specifier loads, or undefined when the specifier leaves the traced tree. Bare specifiers that
 * are not followed are collected by package name in `externals` (name → first importing file);
 * relative specifiers that resolve to nothing are reported in `unresolved`.
 */
export function traceImports(
  entries,
  resolveFile,
  readFile = (file) => readFileSync(file, 'utf8'),
) {
  const files = new Set();
  const externals = new Map();
  const unresolved = [];
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of collectSpecifiers(readFile(file))) {
      const target = resolveFile(specifier, file);
      if (target !== undefined) {
        pending.push(target);
        continue;
      }
      if (specifier.startsWith('.')) {
        unresolved.push({ file, specifier });
        continue;
      }
      const name = packageNameOf(specifier);
      if (name !== undefined && !externals.has(name)) externals.set(name, file);
    }
  }
  return { files: [...files].sort(), externals, unresolved };
}
