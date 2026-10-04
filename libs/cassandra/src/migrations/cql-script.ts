/**
 * Splits a `.cql` script into single statements — the driver executes exactly ONE statement per
 * `execute()` call (research data-libs GOTCHA 16).
 *
 * A small scanner rather than `split(';')`: a `;` only terminates a statement outside of
 * 'string literals' (with '' escapes), "quoted identifiers", $$ blocks $$ (UDF bodies) and
 * comments. Comments (`--`, `//`, `/* … *\/`) are stripped, blank statements dropped, and a final
 * statement without a trailing `;` is kept.
 */
export function splitCqlStatements(script: string): string[] {
  const statements: string[] = [];
  let chunks: string[] = [];
  let segmentStart = 0;
  let i = 0;

  const flushSegment = (end: number): void => {
    if (end > segmentStart) chunks.push(script.slice(segmentStart, end));
  };
  const endStatement = (): void => {
    const statement = chunks.join('').trim();
    if (statement !== '') statements.push(statement);
    chunks = [];
  };
  /** Index just past the closing delimiter, or throws on an unterminated construct. */
  const closeIndex = (from: number, delimiter: string, what: string): number => {
    const end = script.indexOf(delimiter, from);
    if (end === -1) {
      const line = script.slice(0, from).split('\n').length;
      throw new Error(`Unterminated ${what} starting on line ${line}`);
    }
    return end + delimiter.length;
  };

  while (i < script.length) {
    const char = script[i];
    const pair = script.slice(i, i + 2);
    if (pair === '--' || pair === '//') {
      flushSegment(i);
      const newline = script.indexOf('\n', i);
      i = newline === -1 ? script.length : newline; // keep the newline itself
      segmentStart = i;
    } else if (pair === '/*') {
      flushSegment(i);
      i = closeIndex(i + 2, '*/', 'block comment');
      chunks.push(' ');
      segmentStart = i;
    } else if (pair === '$$') {
      i = closeIndex(i + 2, '$$', '$$ block');
    } else if (char === "'" || char === '"') {
      // Quotes are escaped by doubling ('it''s'); keep scanning past each doubled pair.
      let end = closeIndex(i + 1, char, char === "'" ? 'string literal' : 'quoted identifier');
      while (script[end] === char) end = closeIndex(end + 1, char, 'quoted text');
      i = end;
    } else if (char === ';') {
      flushSegment(i);
      endStatement();
      i += 1;
      segmentStart = i;
    } else {
      i += 1;
    }
  }
  flushSegment(script.length);
  endStatement();
  return statements;
}
