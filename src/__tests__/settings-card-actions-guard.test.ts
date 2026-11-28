/**
 * Buttons in a Settings or Admin card stand on the right, centred on their
 * row, and the row is `SettingsCardActions`.
 *
 * The row used to take `align="start"` for a card whose only action was a
 * link out of it. Seven cards did, among them the Coach's pointer to the
 * proactive nudges, and each read as the odd one out beside every card whose
 * button stands on the right. The prop is gone; this guard keeps it gone and
 * freezes the hand-rolled `justify-*` rows that remain, so a new one goes
 * through the primitive instead.
 *
 * Matched:
 *   - `<SettingsCardActions … align=…>` anywhere under `src/`;
 *   - a `className` literal under `components/settings/` or
 *     `components/admin/` that combines `flex` with `justify-start` or
 *     `justify-end`, outside the frozen list below.
 *
 * Not matched: a row whose alignment is assembled at runtime, or a list row
 * whose button sits at the right through `justify-between`. The guard catches
 * the idiom, not every way to paint one.
 */
import { describe, expect, it } from "vitest";

import { readSource, readSourceFolder } from "./helpers/source-files";

/**
 * Inner rows that predate the guard: a button group inside a list item or a
 * form block, not a card's action row. Shrink this list; never grow it.
 */
const FROZEN = new Set([
  "components/settings/coach-memory-section.tsx",
  "components/settings/medications-section.tsx",
  "components/admin/invite-tokens-section.tsx",
  "components/admin/user-management-section.tsx",
  "components/admin/backups/backup-rows.tsx",
]);

const ALIGN_PROP = /<SettingsCardActions\b[^>]*\balign=/;
const CLASS_LITERAL = /className=["'`]([^"'`]*)["'`]/g;

function handRolledRows(files: { path: string; source: string }[]): string[] {
  const hits = new Set<string>();
  for (const { path, source } of files) {
    for (const match of source.matchAll(CLASS_LITERAL)) {
      const classes = match[1].split(/\s+/);
      if (
        classes.includes("flex") &&
        (classes.includes("justify-start") || classes.includes("justify-end"))
      )
        hits.add(path);
    }
  }
  return [...hits].sort();
}

describe("card buttons stand on the right", () => {
  const all = readSourceFolder("src", {
    floor: 2500,
    include: (p) => !p.includes("__tests__/"),
  }).map(([path, source]) => ({ path, source }));
  const cards = all.filter(
    (f) =>
      f.path.startsWith("components/settings/") ||
      f.path.startsWith("components/admin/"),
  );

  it("walks the tree", () => {
    expect(cards.length).toBeGreaterThan(200);
  });

  it("never aligns the action row by prop", () => {
    expect(
      all.filter((f) => ALIGN_PROP.test(f.source)).map((f) => f.path),
    ).toEqual([]);
  });

  it("the primitive has one alignment: trailing, centred", () => {
    const source = readSource(
      "src/components/settings/_card-actions.tsx",
      "export function SettingsCardActions",
    );
    expect(source).not.toMatch(/\balign\??:/);
    expect(source).not.toContain("justify-start");
    expect(source).toContain("items-center justify-end");
  });

  it("has no new hand-rolled justify row in a Settings or Admin card", () => {
    expect(handRolledRows(cards).filter((p) => !FROZEN.has(p))).toEqual([]);
  });

  it("keeps every frozen entry live", () => {
    const hits = new Set(handRolledRows(cards));
    for (const path of FROZEN) expect(hits.has(path), path).toBe(true);
  });

  it("recognises the idioms it exists to refuse", () => {
    expect(ALIGN_PROP.test(`<SettingsCardActions align="start">`)).toBe(true);
    expect(
      handRolledRows([
        {
          path: "x.tsx",
          source: `<div className="flex justify-start gap-2"><Button /></div>`,
        },
      ]),
    ).toEqual(["x.tsx"]);
    expect(
      handRolledRows([
        { path: "x.tsx", source: `<div className="flex justify-between">` },
      ]),
    ).toEqual([]);
  });
});
