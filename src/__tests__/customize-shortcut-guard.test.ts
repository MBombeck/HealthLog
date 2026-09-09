/**
 * The customise wrench never leads a delegate into a wall.
 *
 * Every module surface carries the same glyph in the same slot, linking to its
 * section under `/settings/layout/…`. `/settings` is not a shared-record
 * destination: the shell renders "not part of what was shared" there before
 * the page does. So the link has to be withheld inside somebody else's record,
 * and five of the six that a delegate can reach withheld it. `/mood` did not,
 * which made the wrench a control that existed only to explain itself.
 *
 * One missed instance out of six is what a rule looks like when nothing states
 * it, so this states it. It is structural rather than rendered because these
 * pages early-return a loading gate under SSR — the markup a delegate would
 * see is not reachable without a browser, and the property is about the source
 * either way: the link is inside an `inSharedRecord` conditional, or it is
 * not.
 *
 * v1.38.12 — the guard used to name the manage capability, which was true
 * only in one's own record. It answers per section now and is true for a
 * guardian, so a wrench behind it would send a guardian into the wall. The
 * customise pages live under `/settings`, which is the CALLER's and never the
 * record's, so the link is withheld on `inSharedRecord` — the one answer no
 * grant level moves.
 *
 * ## What decides
 *
 * The AST. The `href` is found as a string literal on a JSX attribute and the
 * ancestor chain above it is walked for a `&&` whose left-hand side names
 * `inSharedRecord`. A comment about gating cannot satisfy that, and an
 * `inSharedRecord` used elsewhere in the same file cannot either — which a
 * "does this file mention the symbol" matcher would have accepted, and which
 * is exactly what `/mood` looked like the day it shipped ungated.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** The prefix every customise shortcut points at. */
const LAYOUT_PREFIX = "/settings/layout/";

/** The answer a shared-record surface withholds these on: `!inSharedRecord`. */
const GUARD = "inSharedRecord";

/**
 * The surfaces that carry a layout shortcut and need no gate.
 *
 * All three are `/insights`, which has no `sharedRecord` flag in the nav model
 * — Insights and the Coach drop out of a switch entirely, being AI surfaces —
 * so a delegate never renders any of them. They are exempt by construction
 * rather than by permission, and the exemption is written here so that "every
 * one is guarded" does not have to be softened into something weaker for them.
 * A surface that gains the flag has to leave this list in the same diff.
 */
const NOT_A_SHARED_DESTINATION: Record<string, string> = {
  "components/insights/insights-tab-strip.tsx":
    "The Insights tab strip. `/insights` carries no `sharedRecord` flag, so a switched session never reaches the surface this sits on.",
  "app/insights/page-client.tsx":
    "The Insights page itself. Same flag, same reason.",
  "components/insights/insights-edit-mode.tsx":
    "The Insights arrange mode, reachable only from the page above.",
};

function allSourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map((p) => String(p).split(sep).join("/"))
    .filter((p) => p.endsWith(".tsx"))
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.tsx"))
    .sort();
}

/** Does any ancestor of `node` gate it behind `!<GUARD> && …`? */
function guardedByOwnRecord(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    const parent: ts.Node | undefined = cur.parent;
    if (
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      // Only the RIGHT side is the guarded branch. `!inSharedRecord && x`
      // guards `x`; `x && !inSharedRecord` is the answer being the guarded thing.
      parent.right === cur
    ) {
      const names = new Set<string>();
      const collect = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) names.add(n.text);
        n.forEachChild(collect);
      };
      collect(parent.left);
      if (names.has(GUARD)) return true;
    }
    // A conditional whose whenTrue branch holds the link, guarded on the
    // answer: `!inSharedRecord ? <Link/> : null`, the shape `vorsorge-section`
    // uses.
    if (
      parent &&
      ts.isConditionalExpression(parent) &&
      parent.whenTrue === cur
    ) {
      const names = new Set<string>();
      const collect = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) names.add(n.text);
        n.forEachChild(collect);
      };
      collect(parent.condition);
      if (names.has(GUARD)) return true;
    }
  }
  return false;
}

/** Every unguarded layout-shortcut href in one module, as its literal text. */
function unguardedShortcuts(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) &&
      node.text.startsWith(LAYOUT_PREFIX) &&
      !guardedByOwnRecord(node)
    ) {
      found.push(node.text);
    }
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);
  return found;
}

describe("the customise shortcut is withheld inside somebody else's record", () => {
  const carrying = allSourceFiles().filter((rel) =>
    readFileSync(join(SRC, rel), "utf8").includes(LAYOUT_PREFIX),
  );

  it("finds the surfaces that carry one", () => {
    // The count of MATCHES, not of files walked. An empty result set and a
    // clean tree are the same sentence otherwise, and this is a leg whose
    // verdict is an empty list.
    expect(carrying.length).toBeGreaterThan(4);
    expect(carrying).toContain("app/mood/page-client.tsx");
    expect(carrying).toContain("app/medications/page-client.tsx");
    for (const rel of Object.keys(NOT_A_SHARED_DESTINATION)) {
      expect(carrying, rel).toContain(rel);
    }
  });

  it("gates every one a delegate can reach", () => {
    const offenders: string[] = [];
    for (const rel of carrying) {
      if (rel in NOT_A_SHARED_DESTINATION) continue;
      for (const href of unguardedShortcuts(
        readFileSync(join(SRC, rel), "utf8"),
        rel,
      )) {
        offenders.push(`${rel} → ${href}`);
      }
    }
    expect(
      offenders,
      `a customise link outside a \`!${GUARD}\` branch sends a delegate to /settings, which a switch closes`,
    ).toEqual([]);
  });

  it("the matcher reads the branch, not the file", () => {
    // The shape that shipped: the answer is resolved and used elsewhere in
    // the module while the link itself sits outside any branch. A matcher
    // asking "does this file name inSharedRecord" calls this clean.
    const UNGATED = `
      export function Page() {
        const { inSharedRecord } = useRecordCapabilities();
        return (
          <>
            {!inSharedRecord && <Button data-slot="add" />}
            <Link href="/settings/layout/mood">Customise</Link>
          </>
        );
      }
    `;
    expect(UNGATED.includes(GUARD)).toBe(true);
    expect(unguardedShortcuts(UNGATED, "u.tsx")).toEqual([
      "/settings/layout/mood",
    ]);

    const GATED = `
      export function Page() {
        const { inSharedRecord } = useRecordCapabilities();
        return !inSharedRecord && <Link href="/settings/layout/mood">Customise</Link>;
      }
    `;
    expect(unguardedShortcuts(GATED, "g.tsx")).toEqual([]);

    const TERNARY = `
      export function Page() {
        const { inSharedRecord } = useRecordCapabilities();
        const wrench = !inSharedRecord ? (
          <Link href="/settings/layout/vorsorge">Customise</Link>
        ) : null;
        return wrench;
      }
    `;
    expect(unguardedShortcuts(TERNARY, "t.tsx")).toEqual([]);

    // And the inverted shape is not a gate: `href && !inSharedRecord` puts
    // the answer in the guarded position, not the link.
    const INVERTED = `
      export function Page() {
        const { inSharedRecord } = useRecordCapabilities();
        return <Link href={"/settings/layout/labs"}>{something && !inSharedRecord}</Link>;
      }
    `;
    expect(unguardedShortcuts(INVERTED, "i.tsx")).toEqual([
      "/settings/layout/labs",
    ]);
  });
});
