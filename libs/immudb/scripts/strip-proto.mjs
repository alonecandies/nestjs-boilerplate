// Strips the REST-gateway and Swagger annotations from immudb's upstream schema.proto so buf can
// compile it without googleapis/grpc-gateway: removes their two imports and every `option (...)`
// statement (scalar or `{ ... }` aggregate). Deterministic and idempotent.
// Usage: node scripts/strip-proto.mjs <upstream.proto> <out.proto>
import { readFile, writeFile } from 'node:fs/promises';

const DROPPED_IMPORTS = [
  'import "google/api/annotations.proto";',
  'import "protoc-gen-swagger/options/annotations.proto";',
];

/** Index just past the `}` closing the `{` at `open`, skipping string literals. */
function closingBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i + 1;
    }
  }
  throw new Error(`unbalanced braces from offset ${open}`);
}

export function stripProto(source) {
  let out = '';
  let i = 0;
  const OPTION = /^[ \t]*option \(/gm;
  for (let m = OPTION.exec(source); m !== null; m = OPTION.exec(source)) {
    const start = m.index;
    let j = source.indexOf('=', start) + 1;
    while (source[j] === ' ') j++;
    let end = source[j] === '{' ? closingBrace(source, j) : source.indexOf(';', j);
    if (source[end] === ';') end++;
    if (source[end] === '\n') end++;
    out += source.slice(i, start);
    i = end;
    OPTION.lastIndex = end;
  }
  out += source.slice(i);
  for (const line of DROPPED_IMPORTS) {
    if (!out.includes(`${line}\n`)) throw new Error(`expected upstream import missing: ${line}`);
    out = out.replace(`${line}\n`, '');
  }
  if (/option \(/.test(out)) throw new Error('an option (...) statement survived stripping');
  return out;
}

const [input, output] = process.argv.slice(2);
if (input !== undefined && output !== undefined) {
  await writeFile(output, stripProto(await readFile(input, 'utf8')));
}
