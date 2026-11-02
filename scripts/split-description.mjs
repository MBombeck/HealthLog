/**
 * Splits an over-long description at its first sentence boundary, in every
 * locale, WITHOUT retranslating anything: the tail is already written in each
 * language, it is just in the wrong slot.
 *
 *   node scripts/split-description.mjs --dry <key> [<key> …]
 *   node scripts/split-description.mjs drop <key> [<key> …]
 *   node scripts/split-description.mjs move <key> <tailKey>
 *
 *   drop  — the description keeps sentence 1; the tail is deleted.
 *   move  — the description keeps sentence 1; the tail lands under `tailKey`,
 *           to be rendered in the card body as foreground `text-sm`.
 *   --dry — print what each locale would become, change nothing.
 *
 * A terminator followed by whitespace and an upper-case letter (or a digit,
 * or an opening quote) is a sentence boundary. `Claude.ai` and `z. B.` do not
 * match: the first has no whitespace, the second continues lower-case.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LOCALES = ["de", "en", "es", "fr", "it", "pl", "ko", "nl", "pt-BR", "ru"];
const BOUNDARY = /(?<=[.!?])\s+(?=[A-ZÄÖÜÀÂÉÈÊÎÔÙÛÇŁŚŹŻĄĆĘŃÓ0-9„"„«])/u;

/**
 * Abbreviations whose full stop is not a sentence end.
 *
 * The boundary above demands an upper-case letter after the space, which
 * already rejects `z. B.` mid-sentence in German (`B.` continues lower-case
 * more often than not) — but not reliably: "… z. B. Blutdruck." splits after
 * `z.`, because `B` IS upper-case. The same hole exists for `d. h.`, `u. a.`,
 * `e.g.` / `i.e.` before a capitalised noun, and French `p. ex.`. A split
 * there produces a head that ends mid-abbreviation and a tail that starts
 * with a fragment, in a file nobody re-reads afterwards.
 */
const ABBREVIATIONS = [
  "bzw.",
  "ca.",
  "vgl.",
  "usw.",
  "e.g.",
  "i.e.",
  "cf.",
  "etc.",
  "ej.",
  "es.",
  "np.",
  "tzn.",
  "ecc.",
  "ex.",
];

/**
 * A single letter followed by a full stop is an abbreviation part, never a
 * sentence: `z. B.`, `d. h.`, `u. a.`, `p. ex.`. Both halves have to be
 * caught, which is why this is a shape rather than a list — catching only
 * `z.` still splits after the `B.`.
 */
const SINGLE_LETTER = /(^|\s)\p{L}\.$/u;

/** Split on sentence boundaries, skipping the ones an abbreviation created. */
function splitSentences(text) {
  const rough = text.split(BOUNDARY);
  const out = [];
  for (const part of rough) {
    const previous = out[out.length - 1];
    const lower = previous?.toLowerCase() ?? "";
    const endsInAbbreviation =
      previous !== undefined &&
      (SINGLE_LETTER.test(previous) ||
        ABBREVIATIONS.some(
          (abbr) => lower.endsWith(` ${abbr}`) || lower === abbr,
        ));
    // Merge, then let the NEXT iteration re-test the merged tail: `z. B.`
    // needs two merges, and a single pass would stop after the first.
    if (endsInAbbreviation) out[out.length - 1] = `${previous} ${part}`;
    else out.push(part);
  }
  return out;
}

function get(bundle, path) {
  return path
    .split(".")
    .reduce((node, part) => (node == null ? node : node[part]), bundle);
}
function set(bundle, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  let node = bundle;
  for (const part of parts) {
    if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[last] = value;
}

const [mode, ...rest] = process.argv.slice(2);
const dry = mode === "--dry";
const keys = dry ? rest : mode === "move" ? [rest[0]] : rest;
const tailKey = mode === "move" ? rest[1] : null;
if (!mode || keys.length === 0) {
  console.error("usage: --dry|drop|move <key> [tailKey]");
  process.exit(1);
}

for (const locale of LOCALES) {
  const file = `messages/${locale}.json`;
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  let changed = false;
  for (const key of keys) {
    const value = get(bundle, key);
    if (typeof value !== "string") {
      console.log(`${locale} ${key}: MISSING`);
      continue;
    }
    const parts = splitSentences(value);
    if (parts.length < 2) {
      console.log(`${locale} ${key}: single sentence, untouched`);
      continue;
    }
    const head = parts[0].trim();
    const tail = parts.slice(1).join(" ").trim();
    if (dry) {
      console.log(
        `${locale} ${key}\n  head(${head.length}): ${head}\n  tail: ${tail}`,
      );
      continue;
    }
    set(bundle, key, head);
    if (tailKey) set(bundle, tailKey, tail);
    changed = true;
  }
  if (changed) {
    writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    console.log(`${locale}: written`);
  }
}
