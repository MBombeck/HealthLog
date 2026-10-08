/**
 * Every way of deleting from the vault asks first.
 *
 * Until v1.42 the bulk bar's Delete and a focused card's Delete key both
 * called the bulk delete straight away; only the transient undo toast stood
 * between a stray press and a medical document leaving the vault. The page now
 * routes both through one confirmation (`requestDelete` → `ConfirmDialog` →
 * `confirmDelete`), and the detail sheet's Delete opens its own.
 *
 * Structural rather than behavioural because the unit layer renders statically;
 * the e2e journey (`documents-qol.spec.ts`) clicks through the real dialog. The
 * matchers assert a non-zero count, so a rename that leaves them matching
 * nothing fails instead of passing quietly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "src/components/documents");
const view = readFileSync(join(dir, "documents-view.tsx"), "utf8");
const sheet = readFileSync(join(dir, "document-detail-sheet.tsx"), "utf8");
const bar = readFileSync(join(dir, "document-bulk-bar.tsx"), "utf8");

describe("vault delete paths confirm before deleting", () => {
  it("the page calls the bulk delete only from the confirmation", () => {
    const calls = [...view.matchAll(/deleteBulk\(\s*([^)]*)\)/g)].map((m) =>
      m[1].trim(),
    );
    // One call site, and it is the confirmed id list.
    expect(calls).toEqual(["pendingDeleteIds"]);
    expect(view).toMatch(
      /const confirmDelete = useCallback\(\(\) => \{\s*if \(pendingDeleteIds\) deleteBulk\(pendingDeleteIds\);/,
    );
    expect(view).toContain("<ConfirmDialog");
  });

  it("the bulk bar and the card key both go through requestDelete", () => {
    expect(view).toMatch(
      /onDelete=\{\s*canManageDocuments \? \(id\) => requestDelete\(\[id\]\)/,
    );
    expect(view).toMatch(
      /onRequestDelete=\{\(\) => requestDelete\(\[\.\.\.selectedIds\]\)\}/,
    );
    // The bar has no delete of its own to call.
    expect(bar).not.toMatch(/\bonDelete\b/);
    expect(bar).toMatch(/onClick=\{onRequestDelete\}/);
  });

  it("the detail sheet's Delete opens a confirmation instead of deleting", () => {
    const mutateCalls = [...sheet.matchAll(/remove\.mutate\(/g)];
    expect(mutateCalls.length).toBe(1);
    expect(sheet).toMatch(/onConfirm=\{\(\) => remove\.mutate\(doc\.id\)\}/);
    expect(sheet).toMatch(/onClick=\{\(\) => setConfirmDeleteOpen\(true\)\}/);
  });
});
