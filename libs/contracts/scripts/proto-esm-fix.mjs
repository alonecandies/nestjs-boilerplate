// Post-`buf generate` fixes that make ts-proto's NestJS output load under native ESM (Node 24) and
// type-check under the repo's strict tsconfig. Idempotent; run by `bun run proto:gen`.
//
// 1. `import { wrappers } from "protobufjs";` -> default import + destructure.
//    protobufjs 7 is CommonJS and Node's cjs-module-lexer cannot see the `wrappers` named export, so
//    the named import throws `SyntaxError: Named export 'wrappers' not found` at link time
//    (research nest-distributed §2.4).
// 2. Cross-file imports of generated modules -> `import type`.
//    With nestJs=true ts-proto emits no encode/decode code, so symbols imported from sibling
//    `*.pb.js` files (e.g. google.protobuf.Empty) are only referenced in type positions. A plain
//    import of an interface is TS1484 under `verbatimModuleSyntax`. If ts-proto ever uses such a
//    symbol as a value, tsc fails loudly with TS1361 instead of silently shipping a broken import.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'src', 'generated'));

const WRAPPERS_NAMED = /^import \{ wrappers \} from "protobufjs";$/m;
const WRAPPERS_FIXED = 'import protobufjs from "protobufjs";\nconst { wrappers } = protobufjs;';
const SIBLING_VALUE_IMPORT = /^import \{([^}]+)\} from "(\.{1,2}\/[^"]+\.pb\.js)";$/gm;

let patched = 0;
const problems = [];

for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  const file = join(entry.parentPath, entry.name);
  const source = await readFile(file, 'utf8');

  const output = source
    .replace(WRAPPERS_NAMED, WRAPPERS_FIXED)
    .replace(
      SIBLING_VALUE_IMPORT,
      (_match, names, specifier) => `import type {${names}} from "${specifier}";`,
    );

  // Guard against ts-proto changing its output shape: `wrappers` must come from the default import.
  if (output.includes('wrappers[') && !output.includes(WRAPPERS_FIXED)) {
    problems.push(`${relative(root, file)}: unrecognised protobufjs 'wrappers' import`);
  }

  if (output !== source) {
    await writeFile(file, output);
    patched++;
  }
}

if (problems.length > 0) {
  console.error(`proto-esm-fix: ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.info(
  `proto-esm-fix: patched ${patched} file(s) in ${relative(process.cwd(), root) || '.'}`,
);
