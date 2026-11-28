/**
 * A form label is a name with no colon after it (`ui/label.tsx`).
 *
 * The colon used to be an `::after` on every `Label`, with a `noColon`
 * opt-out and a punctuation exception, and three fieldset legends copied it
 * by hand. Half the labels on a screen ended in a colon and half did not.
 * The colon is gone at the one place that drew it; this guard keeps it from
 * coming back at a call site:
 *
 * - `Label` renders no `::after` content and takes no `noColon` switch;
 * - no component or page draws a colon with `after:content-[':']`;
 * - no `Label` or `legend` whose child is literal text ends that text in a
 *   colon. A label named by a `t("…")` key is held to the same rule by
 *   `form-label-wording-guard.test.ts`, which resolves the key.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Label } from "@/components/ui/label";

import {
  readSource,
  readSourceFolder,
  stripComments,
} from "./helpers/source-files";

const DRAWN_COLON = /after:content-\[['"]:['"]\]/g;
/** `<Label …>Text:</Label>` or `<legend …>Text:</legend>`, literal text only. */
const LITERAL_COLON = /<(Label|legend)\b[^>{]*>\s*([^<{}]*?):\s*<\/\1>/g;

function offenders(text: string): string[] {
  const source = stripComments(text);
  const found: string[] = [];
  for (const pattern of [DRAWN_COLON, LITERAL_COLON, /\bnoColon\b/g]) {
    for (const match of source.matchAll(pattern)) {
      found.push(
        `${source.slice(0, match.index).split("\n").length}: ${match[0]}`,
      );
    }
  }
  return found;
}

describe("labels carry no colon", () => {
  it("the primitive draws none", () => {
    const source = readSource("src/components/ui/label.tsx", "function Label");
    expect(stripComments(source)).not.toMatch(/after:content|noColon/);
    const html = renderToStaticMarkup(<Label htmlFor="x">Weight</Label>);
    expect(html).not.toContain("after:content");
    expect(html).toContain(">Weight</label>");
  });

  it("catches the shapes it guards (the scanner is not blind)", () => {
    expect(
      offenders(`<legend className="a after:content-[':']">{t("x")}</legend>`),
    ).toHaveLength(1);
    expect(offenders(`<Label htmlFor="a">Blood type:</Label>`)).toHaveLength(1);
    expect(offenders(`<Label htmlFor="a" noColon>Note</Label>`)).toHaveLength(
      1,
    );
    expect(offenders(`<Label htmlFor="a">Blood type</Label>`)).toEqual([]);
  });

  it("no component or page draws one", () => {
    const files = ["src/components", "src/app"].flatMap((dir) =>
      readSourceFolder(dir, {
        floor: 50,
        extensions: [".tsx"],
        include: (rel) => !rel.includes("__tests__"),
      }).map(([rel, text]) => [`${dir}/${rel}`, text] as const),
    );
    const found = files.flatMap(([rel, text]) =>
      offenders(text).map((hit) => `${rel}:${hit}`),
    );
    expect(found).toEqual([]);
  });
});
