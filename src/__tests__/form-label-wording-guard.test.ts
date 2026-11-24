/**
 * A form field's label names the field. It is not a question, and it does not
 * carry its own colon.
 *
 * `Label` puts the colon after every field name itself, and leaves it off a
 * text that already ends in punctuation. So a field named by a question ("What
 * is it?") stood without a colon beside "Sessions:" and "Kind:" in the same
 * sheet, and a name whose string ended in ":" depended on that exception to
 * avoid a double colon. One rule reads the same in every form: the string is
 * a name, and the colon comes from `Label`.
 *
 * What is read: every `FieldGroup` whose `label` is a `t("…")` literal, and
 * every `Label` without `noColon` whose only child is a `t("…")` literal (a
 * `noColon` label is not followed by its field, by the primitive's own
 * contract). The key is resolved in the English bundle; the other bundles are
 * translations of the same name and are held to it by
 * `i18n-locale-integrity.test.ts`.
 *
 * Not read (stated, not hidden): a label built from a variable, a template
 * or more than one child. They are a minority and read differently in a
 * sweep.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(__dirname, "..");
const EN = JSON.parse(
  readFileSync(join(SRC, "..", "messages", "en.json"), "utf8"),
) as Record<string, unknown>;

/** Ends in a question mark, an exclamation mark or a colon (any script). */
const NOT_A_NAME = /[?!:？！：]\s*$/;

function resolve(key: string): string | null {
  let node: unknown = EN;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

/** The opening tag that starts at `start`, braces respected. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/** The `t("…")` keys a source file names its form fields with. */
function fieldLabelKeys(source: string): string[] {
  const text = stripComments(source);
  const keys: string[] = [];
  for (const match of text.matchAll(/<FieldGroup\b/g)) {
    const tag = openingTag(text, match.index);
    const label = /\blabel=\{\s*t\(\s*"([^"]+)"\s*\)\s*\}/.exec(tag);
    if (label) keys.push(label[1]);
  }
  for (const match of text.matchAll(/<Label\b/g)) {
    const tag = openingTag(text, match.index);
    if (/\bnoColon\b/.test(tag) || tag.endsWith("/>")) continue;
    const rest = text.slice(match.index + tag.length);
    const child = /^\s*\{\s*t\(\s*"([^"]+)"\s*\)\s*\}\s*<\/Label>/.exec(rest);
    if (child) keys.push(child[1]);
  }
  return keys;
}

function sweep(): Array<{ file: string; key: string; text: string }> {
  const found: Array<{ file: string; key: string; text: string }> = [];
  for (const path of walkSourceFiles(SRC, {
    floor: 1200,
    extensions: [".tsx"],
  })) {
    if (!/^(components|app)\//.test(path) || path.includes("__tests__/")) {
      continue;
    }
    const source = readSourceText(join(SRC, path));
    if (!source.includes("<FieldGroup") && !source.includes("<Label")) {
      continue;
    }
    for (const key of fieldLabelKeys(source)) {
      const text = resolve(key);
      if (text !== null) found.push({ file: path, key, text });
    }
  }
  return found;
}

describe("form label wording", () => {
  it("reads both shapes and skips a noColon label", () => {
    expect(
      fieldLabelKeys(
        [
          '<FieldGroup htmlFor="a" label={t("x.name")} hint={<b>{1}</b>}>',
          '<Label htmlFor="b">{t("x.kind")}</Label>',
          '<Label noColon>{t("x.prompt")}</Label>',
          '// <Label>{t("x.comment")}</Label>',
        ].join("\n"),
      ),
    ).toEqual(["x.name", "x.kind"]);
  });

  it("names every field with a name, never a question or its own colon", () => {
    const labels = requireFloor("resolved form field labels", sweep(), 400);
    const offenders = labels
      .filter(({ text }) => NOT_A_NAME.test(text))
      .map(({ file, key, text }) => `${file}: ${key} = "${text}"`);
    expect(
      offenders,
      "Name the field (a noun, the way the other fields in the form read) and let Label add the colon.",
    ).toEqual([]);
  });
});
