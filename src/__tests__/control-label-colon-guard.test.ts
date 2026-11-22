/**
 * A label that follows its own checkbox, switch or radio names a choice; it
 * is not a field caption, so it carries no colon (`<Label noColon>`). The
 * colon is an `::after` on every `<Label>` by default (`ui/label.tsx`), so a
 * label written after the control picks one up unless it says otherwise;
 * that is how "Blood type:" ended up beside the emergency card's checkboxes.
 *
 * The scanner reads each control's opening tag brace-aware (attribute values
 * hold arrow functions, whose `>` a plain regex would stop at) and checks the
 * `<Label>` that directly follows it.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder } from "./helpers/source-files";

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

describe("labels after their own control carry no colon", () => {
  it("catches the shape it guards against (the scanner is not blind)", () => {
    const bad = `<Checkbox id="a" onCheckedChange={(on) => set(on)} />
      <Label htmlFor="a">Blood type</Label>`;
    expect(controlLabelsWithColon(bad)).toEqual([1]);
    const good = bad.replace("<Label ", "<Label noColon ");
    expect(controlLabelsWithColon(good)).toEqual([]);
  });

  it("holds across every component and page", () => {
    const offenders = ["src/components", "src/app"].flatMap((dir) =>
      readSourceFolder(dir, {
        floor: 50,
        extensions: [".tsx"],
        include: (rel) => !rel.includes("__tests__"),
      }).flatMap(([rel, text]) =>
        controlLabelsWithColon(text).map((line) => `${dir}/${rel}:${line}`),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
