/**
 * `pass.strings`, the per-language text table of a Wallet pass (v1.50).
 *
 * Wallet shows a pass in the phone's language when the pass has a
 * `<language>.lproj/pass.strings` with an entry for a text: the entry's key is
 * the text as `pass.json` holds it (the owner's language), its value the
 * text in that folder's language. A phone in a language the pass does not
 * carry finds no entry and shows the owner's text.
 *
 * The format is the old-style strings table, `"key" = "value";` per line,
 * UTF-8 here. Every file starts with `"_n"`, 128 random bits drawn for each
 * build: the signing service sees each file's SHA-1, and without the nonce
 * the hash of a short table (a blood type and one allergy) would confirm a
 * guess at its content. `pass.json` needs no such line, because its
 * `authenticationToken` is a 256-bit secret.
 */

export const NONCE_KEY = "_n";
const NONCE_SHAPE = /^[0-9a-f]{32}$/;

/** Escape one key or value for a `"…"` literal. */
export function escapeStringsLiteral(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * One language's table. The first entry for a key wins, so two places that
 * hold the same text in the owner's language read the same in every other;
 * the nonce line comes first.
 */
export function serialisePassStrings(
  nonce: string,
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  if (!NONCE_SHAPE.test(nonce)) throw new Error("nonce: 32 hex characters");
  const seen = new Set<string>([NONCE_KEY]);
  const lines = [`"${NONCE_KEY}" = "${nonce}";`];
  for (const [key, value] of entries) {
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(
      `"${escapeStringsLiteral(key)}" = "${escapeStringsLiteral(value)}";`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The table without its nonce line, for the content hash. */
export function withoutNonce(text: string): string {
  return text.replace(/^"_n" = "[0-9a-f]{32}";\n/, "");
}
