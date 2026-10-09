import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { requireFloor } from "@/__tests__/helpers/source-files";
import en from "../../../../messages/en.json";
import {
  SETTINGS_CARDS,
  SETTINGS_LAYOUT_PAGES,
} from "@/lib/command-palette/settings-cards";

/**
 * The palette links each card by an anchor. An anchor that exists nowhere in
 * the settings sources is a link to the top of the page that says it goes
 * somewhere else; this reads the sources and fails on it.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__") out.push(...sourceFiles(path));
    } else if (name.endsWith(".tsx") || name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

// A sweep that read nothing would find no anchor and fail loudly anyway; the
// floor makes a walker that stopped descending fail by name.
const SETTINGS_SRC = requireFloor(
  "settings source files",
  sourceFiles(join(process.cwd(), "src/components/settings")),
  150,
)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

function hasKey(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      return false;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

describe("SETTINGS_CARDS", () => {
  it.each(SETTINGS_CARDS.map((c) => [c.anchor, c] as const))(
    "#%s exists in the settings sources",
    (anchor) => {
      const patterns = [
        `anchor="${anchor}"`,
        `id="${anchor}"`,
        `anchor: "${anchor}"`,
        `id: "${anchor}"`,
      ];
      expect(patterns.some((p) => SETTINGS_SRC.includes(p))).toBe(true);
    },
  );

  it("every title key resolves", () => {
    const missing = [...SETTINGS_CARDS, ...SETTINGS_LAYOUT_PAGES]
      .map((c) => c.titleKey)
      .filter((key) => !hasKey(key));
    expect(missing).toEqual([]);
  });

  it("anchors are unique within a section", () => {
    const seen = new Set<string>();
    for (const card of SETTINGS_CARDS) {
      const key = `${card.section}#${card.anchor}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
