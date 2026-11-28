/**
 * A form field's label names the field. It is not a question, and it does not
 * carry its own colon.
 *
 * A label is a noun with no colon after it (`ui/label.tsx`), so a string that
 * ends in "?" or ":" reads as the odd one out beside every other field name
 * in the sheet. One rule reads the same in every form: the string is a name.
 *
 * What is read: every `FieldGroup` whose `label` is a `t("…")` literal, and
 * every `Label` whose only child is a `t("…")` literal. The key is resolved
 * in the English bundle; the other bundles are translations of the same name
 * and are held to it by `i18n-locale-integrity.test.ts`.
 *
 * Not read (stated, not hidden): a label built from a variable, a template
 * or more than one child. They are a minority and read differently in a
 * sweep.
 *
 * The other half of the colon rule: a label that follows its own checkbox,
 * switch or radio names a choice, not a field, so it says `noColon`. A label
 * written after the control picks up the default colon otherwise; that is
 * how "Blood type:" ended up beside the emergency card's checkboxes. The
 * control's opening tag is read brace-aware (attribute values hold arrow
 * functions, whose `>` a plain regex would stop at) and the `<Label>` that
 * directly follows it is checked.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(__dirname, "..");
const EN = JSON.parse(readSource("messages/en.json", '"encounters"')) as Record<
  string,
  unknown
>;

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
    if (tag.endsWith("/>")) continue;
    const rest = text.slice(match.index + tag.length);
    const child = /^\s*\{\s*t\(\s*"([^"]+)"\s*\)\s*\}\s*<\/Label>/.exec(rest);
    if (child) keys.push(child[1]);
  }
  return keys;
}

/** Index just past a self-closing tag that starts at `start`, or -1. */
function selfClosingEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && c === "/" && source[i + 1] === ">") return i + 2;
    else if (depth === 0 && c === ">") return -1;
  }
  return -1;
}

/** Lines of a control directly followed by a `<Label>` without `noColon`. */
function controlLabelsWithColon(source: string): number[] {
  const lines: number[] = [];
  const control = /<(Checkbox|Switch|RadioGroupItem)\b/g;
  let match: RegExpExecArray | null;
  while ((match = control.exec(source))) {
    const end = selfClosingEnd(source, match.index + 1);
    if (end < 0) continue;
    const rest = source.slice(end).trimStart();
    if (!rest.startsWith("<Label")) continue;
    const openTag = rest.slice(0, rest.indexOf(">") + 1);
    if (!/\bnoColon\b/.test(openTag)) {
      lines.push(source.slice(0, match.index).split("\n").length);
    }
  }
  return lines;
}

/** Every component and page, with its source. */
const VIEWS = walkSourceFiles(SRC, { floor: 1200, extensions: [".tsx"] })
  .filter(
    (path) => /^(components|app)\//.test(path) && !path.includes("__tests__/"),
  )
  .map((path) => ({ path, source: readSourceText(join(SRC, path)) }));

function sweep(): Array<{ file: string; key: string; text: string }> {
  const found: Array<{ file: string; key: string; text: string }> = [];
  for (const { path, source } of VIEWS) {
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
  it("reads both shapes", () => {
    expect(
      fieldLabelKeys(
        [
          '<FieldGroup htmlFor="a" label={t("x.name")} hint={<b>{1}</b>}>',
          '<Label htmlFor="b">{t("x.kind")}</Label>',
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
      "Name the field with a noun, the way the other fields in the form read, with no colon.",
    ).toEqual([]);
  });
});

describe("labels after their own control carry no colon", () => {
  it("catches the shape it guards against (the scanner is not blind)", () => {
    const bad = `<Checkbox id="a" onCheckedChange={(on) => set(on)} />
      <Label htmlFor="a">Blood type</Label>`;
    expect(controlLabelsWithColon(bad)).toEqual([1]);
    const good = bad.replace("<Label ", "<Label noColon ");
    expect(controlLabelsWithColon(good)).toEqual([]);
  });

  it("holds across every component and page", () => {
    const offenders = VIEWS.flatMap(({ path, source }) =>
      controlLabelsWithColon(source).map((line) => `src/${path}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
