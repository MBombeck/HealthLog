/**
 * #650 — the intake import says what actually happened.
 *
 * The report was a file of 28 doses where 27 were "skipped" and the dialog
 * answered in success tone with a duplicate count, so nothing on screen said
 * the history had not landed. The cause is fixed elsewhere; this pins the
 * telling, which is what turned a recoverable problem into a silent one.
 *
 * Project convention is SSR-only component tests (vitest runs `node`;
 * `@testing-library/react` is not installed), so the view takes its state as a
 * prop and each case is rendered directly.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  IntakeImportResultView,
  type IntakeImportResultState,
} from "../intake-import-result";

/** `<li>` elements only — the lucide icon markup carries `<line>` tags. */
function countListItems(html: string): number {
  return html.split("<li>").length - 1;
}

function render(state: IntakeImportResultState): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <IntakeImportResultView result={state} />
    </I18nProvider>,
  );
}

/** What the reported run would have produced before the key was fixed. */
const ALL_SKIPPED: IntakeImportResultState = {
  kind: "outcome",
  imported: 0,
  skipped: 27,
  skipReasons: [{ reason: "duplicate_in_file", count: 27 }],
};

describe("<IntakeImportResultView> — an import that wrote nothing", () => {
  it("renders as a failure, never a success", () => {
    const html = render(ALL_SKIPPED);
    expect(html).toContain('data-outcome="failed"');
    expect(html).not.toContain('data-outcome="success"');
    expect(html).toContain("Nothing was imported");
    expect(html).toContain("27");
  });

  it("names the skip reason once with its count, not once per entry", () => {
    const html = render(ALL_SKIPPED);
    expect(html).toContain("27 entries skipped");
    expect(html).toContain("same date and time");
    // One list item for one reason — 27 entries must not become 27 lines.
    expect(countListItems(html)).toBe(1);
  });

  it("separates the two skip reasons instead of calling both duplicates", () => {
    const html = render({
      kind: "outcome",
      imported: 4,
      skipped: 5,
      skipReasons: [
        { reason: "already_recorded", count: 3 },
        { reason: "duplicate_in_file", count: 2 },
      ],
    });
    expect(html).toContain("3 entries skipped");
    expect(html).toContain("already recorded");
    expect(html).toContain("2 entries skipped");
    expect(html).toContain("another entry in the same file");
    expect(countListItems(html)).toBe(2);
  });

  it("calls an all-existing replay already recorded instead of a failed import", () => {
    const html = render({
      kind: "outcome",
      imported: 0,
      skipped: 3386,
      skipReasons: [{ reason: "already_recorded", count: 3386 }],
    });
    expect(html).toContain("3386 intakes are already recorded");
    expect(html).toContain("Nothing new was added");
    expect(html).not.toContain("Nothing was imported");
  });

  it("uses the already-recorded headline when preflight refusals also exist", () => {
    const html = render({
      kind: "outcome",
      imported: 0,
      skipped: 3395,
      skipReasons: [
        { reason: "already_recorded", count: 3386 },
        { reason: "status_no_dose_information", count: 8 },
        { reason: "duplicate_in_file", count: 1 },
      ],
    });
    expect(html).toContain("3386 intakes are already recorded");
    expect(html).toContain("8 entries skipped");
    expect(html).toContain("1 entry skipped");
    expect(html).not.toContain("Nothing was imported");
  });

  it("shows bounded line-and-reason detail without health data", () => {
    const html = render({
      kind: "outcome",
      imported: 0,
      skipped: 3,
      skipReasons: [{ reason: "already_recorded", count: 3 }],
      skipDetails: [
        { line: 2, reason: "already_recorded" },
        { line: 9, reason: "already_recorded" },
      ],
      skippedDetailsOmitted: 1,
    });
    expect(html).toContain('data-testid="intake-import-skip-details"');
    expect(html).toContain("Line 2");
    expect(html).toContain("Line 9");
    expect(html).toContain("1 more skipped row is not shown");
    expect(html).not.toContain("medicationId");
    expect(html).not.toContain("takenAt");
  });
});

describe("<IntakeImportResultView> — the other outcomes", () => {
  it("renders a mixed run as a warning, not a tick", () => {
    const html = render({
      kind: "outcome",
      imported: 26,
      skipped: 2,
      skipReasons: [{ reason: "already_recorded", count: 2 }],
    });
    expect(html).toContain('data-outcome="partial"');
    expect(html).toContain("26 imported, 2 skipped");
  });

  it("renders a clean run as a success", () => {
    const html = render({
      kind: "outcome",
      imported: 28,
      skipped: 0,
      skipReasons: [],
    });
    expect(html).toContain('data-outcome="success"');
    expect(html).toContain("28 intakes imported");
    expect(countListItems(html)).toBe(0);
  });

  it("gives a file with no intakes its own message rather than either", () => {
    const html = render({
      kind: "outcome",
      imported: 0,
      skipped: 0,
      skipReasons: [],
    });
    expect(html).toContain('data-outcome="empty"');
    expect(html).not.toContain('data-outcome="success"');
    expect(html).toContain("no intakes");
  });

  it("falls back to a stated absence for an unrecognised reason", () => {
    const html = render({
      kind: "outcome",
      imported: 0,
      skipped: 1,
      skipReasons: [{ reason: "something_new", count: 1 }],
    });
    expect(html).toContain("reason not recorded");
  });
});

describe("<IntakeImportResultView> — notices are not outcomes", () => {
  it("reports a loaded file in neutral tone, not as an import success", () => {
    const html = render({
      kind: "notice",
      tone: "info",
      text: 'File "intakes.json" loaded',
    });
    expect(html).toContain('data-tone="info"');
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("data-outcome");
  });

  it("reports a refusal in destructive tone", () => {
    const html = render({
      kind: "notice",
      tone: "error",
      text: "Import failed",
    });
    expect(html).toContain("text-destructive");
  });
});
