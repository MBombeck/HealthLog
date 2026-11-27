/**
 * A row's value is the shared `RowValue` family, never a field handed to the
 * row on its own (ui-standards §20).
 *
 * A select or a date dropped into a row's `trailing` slot keeps its own idea
 * of width, padding and glyph: the chosen option sat in the middle of a
 * select as wide as its longest option with the chevron far right, a date
 * came out larger than the text above it, and the gap between value and
 * glyph differed from row to row. `RowValue`, `RowValueSelect`,
 * `RowValueDate` and `RowValueTime` (`ui/row-value.tsx`) end every value in
 * one fixed glyph slot, so a group's values end on one line.
 *
 * The sweep reads every `trailing={…}` prop under `src/` (a `ListItem`'s, a
 * switch row's, any row's) and refuses a field component or a raw `<select>`
 * inside it. It asserts it read more than nothing, and that the shared
 * component is in use, so an empty match set cannot pass.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** A field component that must not stand in a row on its own. */
const AD_HOC =
  /<(NativeSelect|DateField|TimeField|DateTimeField|Select|SelectTrigger|select|input)\b/;

/** Every `trailing={…}` expression in a source text, braces balanced. */
export function trailingProps(source: string): string[] {
  const found: string[] = [];
  const opener = /\btrailing=\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    found.push(source.slice(start, i - 1));
  }
  return found;
}

/** The offending `trailing` props of one file, as `file: snippet`. */
export function adHocRowValues(rel: string, source: string): string[] {
  return trailingProps(stripComments(source, rel))
    .filter((expr) => AD_HOC.test(expr))
    .map((expr) => `${rel}: ${expr.trim().split("\n")[0]}`);
}

describe("row values go through RowValue", () => {
  const files = walkSourceFiles(SRC, { floor: 1000, extensions: [".tsx"] })
    .filter((rel) => !rel.includes("__tests__/"))
    .filter((rel) => rel !== "components/ui/row-value.tsx");

  it("no row's trailing slot holds a field of its own", () => {
    let props = 0;
    let shared = 0;
    const offenders: string[] = [];
    for (const rel of files) {
      const source = readSourceText(join(SRC, rel));
      const trailing = trailingProps(stripComments(source, rel));
      props += trailing.length;
      shared += trailing.filter((expr) => /<RowValue/.test(expr)).length;
      offenders.push(...adHocRowValues(rel, source));
    }
    // Non-zero proof: a sweep that found no trailing props, or none using
    // the shared value, says nothing about the tree.
    expect(props).toBeGreaterThan(0);
    expect(shared).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("catches a select, a date and a time handed to a row", () => {
    const planted = `
      <ListItem title="Type" trailing={<NativeSelect value={k}>{o}</NativeSelect>} />
      <ListItem title="Date" trailing={
        <DateField value={d} onChange={set} />
      } />
      <ListItem title="Time" trailing={<TimeField value={t} />} />
      <ListItem title="Kind" trailing={<RowValueSelect value={k}>{o}</RowValueSelect>} />
      <ListItem title="Name" trailing={<RowValue>{name}</RowValue>} />
    `;
    expect(adHocRowValues("planted.tsx", planted)).toHaveLength(3);
  });
});
