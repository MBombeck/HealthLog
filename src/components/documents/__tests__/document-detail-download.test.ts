/**
 * The detail sheet fetches the original once, and only when it will show it.
 *
 * Two regressions this pins, both introduced by the fix that moved these
 * controls off a bare `/api/…` href and neither visible in any rendered
 * assertion:
 *
 *   * **Two eager fetches per open.** `InlinePreview` loaded the original and
 *     the sheet-level download href loaded it AGAIN, so opening a document
 *     decrypted and held two copies of it — including for a non-inline
 *     document, where the old href cost nothing until somebody clicked. The
 *     vault meets large scans.
 *   * **A download control that could not be pressed and would not say so.**
 *     `href="#"` plus `aria-disabled` announces "unavailable" and still
 *     activates, and it ignored the failure flag entirely, so a permanently
 *     unfetchable original left a control that silently did nothing.
 *
 * Asserted on source shape rather than by rendering: the project's component
 * convention is SSR-only (no DOM, no testing-library), and both properties are
 * about which code paths EXIST — how many loaders there are, and whether the
 * disabled state is real. A render could not see either.
 */
import { describe, expect, it } from "vitest";

import { documentDetailSource } from "@/__tests__/helpers/document-detail-source";

const SHEET = documentDetailSource();

describe("the detail sheet's original-document transport", () => {
  it("has exactly one eager loader for the original", () => {
    const eager = [...SHEET.matchAll(/useFencedObjectUrl\(/g)];
    // Non-zero proof first: a sheet that fetched nothing would satisfy a bare
    // "not more than one" check.
    expect(eager.length).toBe(1);
  });

  it("only fetches eagerly for a document it is going to render inline", () => {
    // The whole point of the single loader: a non-inline document — a large
    // scan, a download-only format — fetches and decrypts nothing on open.
    expect(SHEET).toMatch(
      /useFencedObjectUrl\(\s*\n?\s*doc && doc\.servingClass === "inline"/,
    );
  });

  it("hands the blob down rather than letting the preview fetch its own", () => {
    expect(SHEET).toMatch(/<InlinePreview\s+src=\{inlineSrc\}/);
    // And the preview declares it takes bytes, not an id to fetch from.
    expect(SHEET).toMatch(/function InlinePreview\(\{\s*\n\s*src,/);
    expect(SHEET).not.toMatch(
      /function InlinePreview\([\s\S]{0,400}documentId/,
    );
  });

  it("downloads at click time when the bytes are not already in hand", () => {
    expect(SHEET).toContain("createFencedBlobLoader()");
    expect(SHEET).toMatch(
      /const onClick = async \(\) => \{[\s\S]{0,200}readyUrl/,
    );
  });

  it("gives the download a real disabled state that reflects failure", () => {
    // `aria-disabled` on an anchor is an announcement, not a behaviour.
    expect(SHEET).not.toMatch(/aria-disabled=/);
    expect(SHEET).not.toMatch(/href=\{originalHref/);
    expect(SHEET).toMatch(/disabled=\{blocked \|\| pending\}/);
    expect(SHEET).toMatch(/const blocked = unavailable \|\| failed;/);
    // And it says why, with the existing unavailable messaging.
    expect(SHEET).toMatch(
      /blocked\s*\n?\s*\?\s*t\("documents\.detail\.loadError"\)/,
    );
  });

  it("revokes what it fetched", () => {
    // A decrypted health document left in an object URL lives as long as the
    // tab does, and nothing in the UI ever shows it.
    expect(SHEET).toMatch(
      /useEffect\(\(\) => \(\) => loaderRef\.current\?\.dispose\(\), \[\]\)/,
    );
  });
});

/**
 * "Open in new tab" hands the browser the types it renders itself, so a long
 * report gets the browser's zoom and search. It must open the object URL the
 * sheet already holds (a bare navigation to the route carries no record-session
 * assertion and is refused once the session has been inside a shared record),
 * and it must never appear for a type outside the inline serving class.
 */
describe("the detail sheet's open-in-new-tab control", () => {
  const control = SHEET.slice(
    SHEET.indexOf("function DocumentOpenInTabButton("),
    SHEET.indexOf("/** Inline preview for Class A documents"),
  );

  it("exists", () => {
    expect(control.length).toBeGreaterThan(0);
    expect(SHEET).toMatch(/<DocumentOpenInTabButton\s/);
  });

  it("renders only for the inline serving class", () => {
    expect(SHEET).toMatch(
      /doc\.servingClass === "inline" \? \(\s*\n\s*<DocumentOpenInTabButton\s+readyUrl=\{inlineSrc\}/,
    );
    expect([...SHEET.matchAll(/<DocumentOpenInTabButton\s/g)]).toHaveLength(1);
  });

  it("opens the fetched object URL, never the route, without an opener", () => {
    expect(control).toContain('window.open(readyUrl, "_blank", "noopener")');
    expect(control).not.toContain("/api/documents");
  });

  it("is disabled until the bytes are in hand, and when they failed", () => {
    expect(control).toMatch(/disabled=\{readyUrl === null \|\| unavailable\}/);
    expect(SHEET).toMatch(
      /<DocumentOpenInTabButton\s+readyUrl=\{inlineSrc\}\s+unavailable=\{inlineFailed\}/,
    );
  });
});
