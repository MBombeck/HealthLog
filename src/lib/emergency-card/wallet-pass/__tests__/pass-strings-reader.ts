/** A reader for the `pass.strings` tables `strings.ts` writes, for the tests. */
const LINE = /^"((?:[^"\\]|\\.)*)" = "((?:[^"\\]|\\.)*)";$/;
const UNESCAPES: Record<string, string> = {
  "\\": "\\",
  '"': '"',
  n: "\n",
  r: "\r",
  t: "\t",
};

function unescape(text: string): string {
  return text.replace(/\\(.)/g, (_, c: string) => {
    const out = UNESCAPES[c];
    if (out === undefined) throw new Error(`unknown escape \\${c}`);
    return out;
  });
}

/** Read a table back, nonce included. */
export function parsePassStrings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = LINE.exec(line);
    if (!m) throw new Error(`not a strings line: ${line}`);
    out.set(unescape(m[1]), unescape(m[2]));
  }
  return out;
}
