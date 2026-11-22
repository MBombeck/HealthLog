/**
 * A small text action inside a line of content goes through `InlineAction`
 * (`src/components/ui/inline-action.tsx`).
 *
 * Thirty-odd hand-rolled copies of the same "underlined small text link"
 * carried three different focus rings, none at all on half of them, and a
 * 16 px touch target on a phone. The primitive owns the 44 px floor on a
 * coarse pointer and the ring; this guard keeps a new copy from appearing
 * beside it.
 *
 * Matched: a `<button>`, `<Link>` or `<a>` whose static `className` combines
 * the inline-action signature — an underline (`underline` / `hover:underline`)
 * with a small text size (`text-xs` / `text-sm`) and an action tone
 * (`text-primary` / `text-muted-foreground`). A full-width row link or a
 * framed button does not have that combination.
 *
 * Not matched (stated, not hidden): a class list assembled at runtime, and a
 * copy without an underline. The guard catches the idiom, not every way to
 * draw a small link.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(__dirname, "..");

/**
 * Sites that look like an inline action but are something else, each with
 * the reason. Keyed by `path:tag`.
 */
const ALLOWED: Record<string, string> = {
  // A full-width footer row of the glucose clinical panel: icon plus a
  // wrapping sentence under a border, read as part of the card body.
  "components/insights/glucose/glucose-clinical-panel.tsx:Link":
    "full-width footer row, not an inline action",
};

const OPENER_RE = /<(button|Link|a)\b((?:[^>{]|\{[^}]*\})*?)>/g;
const CLASS_RE = /className=(?:"([^"]*)"|\{cn\(\s*"([^"]*)")/;
const INLINE_ACTION_OPENER_RE = /<InlineAction\b(?:[^>{]|\{[^}]*\})*?>/g;

function isInlineActionShape(cls: string): boolean {
  return (
    /(?:^|\s)(?:hover:)?underline(?:\s|$)/.test(cls) &&
    /(?:^|\s)text-(?:xs|sm)(?:\s|$)/.test(cls) &&
    /(?:^|\s)text-(?:primary|muted-foreground)(?:\s|$)/.test(cls)
  );
}

function findHandRolledInlineActions(
  files: { path: string; source: string }[],
): string[] {
  const hits: string[] = [];
  for (const { path, source } of files) {
    for (const match of source.matchAll(OPENER_RE)) {
      const cls = CLASS_RE.exec(match[2]);
      if (!cls) continue;
      if (!isInlineActionShape(cls[1] ?? cls[2] ?? "")) continue;
      hits.push(`${path}:${match[1]}`);
    }
  }
  return hits;
}

describe("small text actions go through InlineAction", () => {
  const files = walkSourceFiles(SRC, { floor: 1200, extensions: [".tsx"] })
    .filter(
      (p) =>
        (p.startsWith("components/") || p.startsWith("app/")) &&
        !p.startsWith("components/ui/") &&
        !p.includes("__tests__/"),
    )
    .map((path) => ({ path, source: readFileSync(join(SRC, path), "utf8") }));

  it("walks the UI tree", () => {
    expect(files.length).toBeGreaterThan(800);
  });

  it("has no hand-rolled copy outside the allowlist", () => {
    const hits = findHandRolledInlineActions(files).filter(
      (key) => !(key in ALLOWED),
    );
    expect(hits).toEqual([]);
  });

  it("keeps every allowlist entry live", () => {
    const hits = new Set(findHandRolledInlineActions(files));
    for (const key of Object.keys(ALLOWED)) {
      expect(hits.has(key), key).toBe(true);
    }
  });

  it("recognises the idiom it exists to refuse", () => {
    const planted = [
      {
        path: "components/x.tsx",
        source:
          '<Link href="/a" className="text-primary text-xs underline-offset-2 hover:underline">Go</Link>',
      },
      {
        path: "components/y.tsx",
        source:
          '<button type="button" onClick={() => go()} className="text-muted-foreground hover:text-foreground text-sm underline">Go</button>',
      },
      {
        path: "components/z.tsx",
        source: '<InlineAction tone="muted">Go</InlineAction>',
      },
    ];
    expect(findHandRolledInlineActions(planted)).toEqual([
      "components/x.tsx:Link",
      "components/y.tsx:button",
    ]);
  });

  it("lets no call site give the action a height of its own", () => {
    // The touch target is the primitive's hit area. A height on the call
    // site brings back the 44 px box around a 12 px link.
    const withHeight = (source: string) =>
      [...source.matchAll(INLINE_ACTION_OPENER_RE)].filter((m) =>
        /className="(?:[^"]*\s)?(?:[a-z-]+:)*(?:min-h|h|py)-/.test(m[0]),
      ).length;
    expect(
      withHeight('<InlineAction asChild className="min-h-11 font-medium">'),
    ).toBe(1);
    expect(withHeight('<InlineAction tone="muted" className="shrink-0">')).toBe(
      0,
    );
    const offenders = files
      .filter((f) => withHeight(f.source) > 0)
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("is used where the copies were", () => {
    const users = files.filter((f) => f.source.includes("<InlineAction"));
    expect(users.length).toBeGreaterThanOrEqual(25);
  });
});
