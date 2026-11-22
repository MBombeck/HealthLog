import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DocumentSummaryStateValue } from "@/lib/validations/inbound-documents";
import { DocumentSummaryBlock } from "../document-summary-block";

/**
 * The detail view used to read a null summary as "being generated" and say so
 * forever — for a document nobody ever enqueued as readily as for one actually
 * in flight. These pin the states apart: only PENDING may claim generation is
 * running, a stored summary comes from storage, and every dead end offers a way
 * out.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const noop = () => {};

function base(
  overrides: Partial<React.ComponentProps<typeof DocumentSummaryBlock>> = {},
) {
  const props: React.ComponentProps<typeof DocumentSummaryBlock> = {
    summary: null,
    summaryState: "NONE",
    generatedAtLabel: null,
    aiEnabled: true,
    isGenerating: false,
    actionsDisabled: false,
    onGenerate: noop,
    ...overrides,
  };
  return render(<DocumentSummaryBlock {...props} />);
}

/** Every state that has no summary to show. */
const ABSENT_STATES: DocumentSummaryStateValue[] = [
  "NONE",
  "WITHHELD",
  "UNAVAILABLE",
];

describe("DocumentSummaryBlock — a stored summary", () => {
  it("renders the stored summary from storage, with its date", () => {
    const html = base({
      summary: "A discharge letter from a city hospital.",
      summaryState: "READY",
      generatedAtLabel: "14 Feb 2026",
    });

    expect(html).toContain("A discharge letter from a city hospital.");
    expect(html).toContain("14 Feb 2026");
    expect(html).toContain('data-slot="document-detail-summary"');
    // Opening a stored result is read-only: the detail surface no longer
    // exposes the redundant regenerate action.
    expect(html).not.toContain("being prepared");
    expect(html).not.toContain(
      'data-slot="document-detail-summary-regenerate"',
    );
    expect(html).not.toContain("Generate again");
    const header = html.match(
      /<div[^>]*data-slot="document-detail-summary-header"[^>]*>/,
    );
    expect(header?.[0]).toMatch(/\bflex-col\b/);
    expect(header?.[0]).toMatch(/\bsm:flex-row\b/);
    expect(html).not.toContain("document-detail-summary-generate");
  });

  it("keeps stored prose visible without surfacing replacement state", () => {
    const html = base({
      summary: "Stored prose.",
      summaryState: "READY",
      isGenerating: true,
    });

    expect(html).toContain("Stored prose.");
    expect(html).not.toContain(
      'data-slot="document-detail-summary-regenerate"',
    );
    expect(html).not.toContain("Generating");
  });

  it("shows a stored summary even if the state disagrees", () => {
    // The bytes are the truth. A stale state must never hide a real summary.
    const html = base({ summary: "Stored prose.", summaryState: "PENDING" });

    expect(html).toContain("Stored prose.");
    expect(html).not.toContain("being prepared");
  });
});

describe("DocumentSummaryBlock — honest absent states", () => {
  it("claims generation is running ONLY for PENDING", () => {
    const pending = base({ summaryState: "PENDING" });

    expect(pending).toContain("being prepared");
    expect(pending).toContain('data-slot="document-detail-summary-pending"');
    // A job is running; offering a second one would double-spend.
    expect(pending).not.toContain("document-detail-summary-generate");
  });

  it.each(ABSENT_STATES)(
    "never says 'being generated' for %s",
    (summaryState) => {
      const html = base({ summaryState });

      expect(html).not.toContain("being prepared");
      expect(html).toContain('data-slot="document-detail-summary-absent"');
    },
  );

  it("says a summary was never generated for NONE", () => {
    expect(base({ summaryState: "NONE" })).toContain(
      "No summary has been generated for this document yet.",
    );
  });

  it("says the summary was withheld, and never shows blocked prose", () => {
    const html = base({ summaryState: "WITHHELD" });

    expect(html).toContain("did not pass the safety check");
    // The withheld state carries no summary text — that is the whole contract.
    expect(html).not.toContain("document-detail-summary&quot;");
  });

  it("says none could be produced for UNAVAILABLE", () => {
    expect(base({ summaryState: "UNAVAILABLE" })).toContain(
      "No summary could be generated for this document.",
    );
  });

  it.each(ABSENT_STATES)("offers a way out of %s", (summaryState) => {
    const html = base({ summaryState });

    expect(html).toContain('data-slot="document-detail-summary-generate"');
    expect(html).toContain("Generate summary");
  });
});

describe("DocumentSummaryBlock — the action", () => {
  it("states the outcome but offers no action without a provider", () => {
    const html = base({ summaryState: "UNAVAILABLE", aiEnabled: false });

    // The state is still honest; only the button that would 422 is gone.
    expect(html).toContain("No summary could be generated for this document.");
    expect(html).not.toContain("document-detail-summary-generate");
  });

  it("disables the action while generating, and says so", () => {
    const html = base({ summaryState: "NONE", isGenerating: true });

    expect(html).toContain("disabled");
    expect(html).toContain("Generating");
  });

  it("disables the action while the capability probe resolves", () => {
    expect(base({ summaryState: "NONE", actionsDisabled: true })).toContain(
      "disabled",
    );
  });
});

describe("DocumentSummaryBlock — a background read (v1.40)", () => {
  it("says the read runs in the background and is stored with the document", () => {
    const html = base({ isGenerating: true, runPhase: "background" });
    expect(html).toContain('data-slot="document-detail-summary-run-phase"');
    expect(html).toContain("You can leave this page");
  });

  it("renders no note while nothing runs", () => {
    expect(base()).not.toContain("run-phase");
  });
});

describe("DocumentSummaryBlock — a recorded failure (#1404)", () => {
  const failure = {
    job: "documentSummary" as const,
    code: "provider_unreachable" as const,
    documentId: "doc-1",
    providerType: "local",
    failCount: 3,
    firstFailedAt: "2026-11-20T08:00:00.000Z",
    lastFailedAt: "2026-11-21T08:00:00.000Z",
  };

  it("says why the summary stopped and offers to try again", () => {
    const html = base({ summaryState: "UNAVAILABLE", failures: [failure] });
    expect(html).toContain('data-slot="document-detail-summary-failure"');
    expect(html).toContain("The AI provider could not be reached.");
    expect(html).toContain("Failed 3 times in a row");
    expect(html).toContain("Try again");
    expect(html).not.toContain("No summary could be generated");
  });

  it("ignores another kind's failure", () => {
    const html = base({
      summaryState: "UNAVAILABLE",
      failures: [{ ...failure, job: "documentIndex" }],
    });
    expect(html).not.toContain("document-detail-summary-failure");
    expect(html).toContain("No summary could be generated");
  });

  it("keeps the safety screen's own sentence for a withheld summary", () => {
    const html = base({ summaryState: "WITHHELD", failures: [failure] });
    expect(html).not.toContain("document-detail-summary-failure");
    expect(html).toContain("did not pass the safety check");
  });
});
