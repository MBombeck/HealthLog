import { describe, expect, it } from "vitest";
import { documentDetailSource } from "@/__tests__/helpers/document-detail-source";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.28.52 (Documents R3) — "Ask the Coach" opens the REAL fenced coach
 * conversation in the shared SIDE DRAWER, scoped to the document, instead of a
 * full-page nav to `/coach?doc=<id>` (the v1.28.51 behaviour, since corrected).
 *
 * The wiring is source-structural (the send-path fence itself is covered by the
 * coach-send-target unit tests — untouched here). These guards pin:
 *   1. the detail sheet drives the drawer via `askCoach(..., doc.id)`, closing
 *      the sheet first, and no longer navigates to `/coach?doc=`;
 *   2. the launch context → mount → drawer → conversation `documentId` thread
 *      stays connected end-to-end.
 */
const ROOT = join(__dirname, "../../../..");
const MOUNT = join(ROOT, "src/components/insights/layout-coach-mount.tsx");
const DRAWER = join(
  ROOT,
  "src/components/insights/coach-panel/coach-drawer.tsx",
);

function load(path: string): string {
  return readFileSync(path, "utf8");
}

describe("document detail sheet — Ask the Coach opens the drawer", () => {
  const src = documentDetailSource();

  it("launches the doc-scoped coach drawer via askCoach(..., doc.id)", () => {
    expect(src).toContain("useCoachLaunch");
    expect(src).toMatch(/askCoach\(null,\s*undefined,\s*false,\s*doc\.id\)/);
  });

  it("closes the detail sheet when handing off to the drawer", () => {
    // The Ask-the-Coach onClick closes the sheet before opening the drawer so
    // the drawer owns the surface (no stacked dialogs).
    expect(src).toMatch(
      /onClick=\{\(\)\s*=>\s*\{[\s\S]*?onOpenChange\(false\);[\s\S]*?askCoach\(null,\s*undefined,\s*false,\s*doc\.id\)/,
    );
  });

  it("no longer navigates to the full-page /coach?doc= route", () => {
    expect(src).not.toContain("/coach?doc=");
    expect(src).not.toContain('from "next/navigation"');
  });
});

describe("documentId threads launch context → mount → drawer", () => {
  it("the mount forwards launch.documentId to the drawer", () => {
    expect(load(MOUNT)).toContain("documentId={launch.documentId}");
  });

  it("the drawer seeds CoachConversation with initialDocumentId + a conversation-id getter", () => {
    const src = load(DRAWER);
    expect(src).toContain("initialDocumentId={documentId}");
    expect(src).toContain(
      "registerConversationIdGetter={registerConversationIdGetter}",
    );
  });
});
