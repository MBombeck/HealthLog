import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

const record = vi.hoisted(() => ({ inSharedRecord: false }));
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ inSharedRecord: record.inSharedRecord }),
}));
import type { DocumentSuggestionDto } from "@/lib/validations/inbound-documents";
import { DocumentAiSection } from "../document-ai-section";

/**
 * The detail sheet's "Read with AI" block is availability-gated: with a provider
 * it offers the prominent "Read with AI" action alongside suggest / summary;
 * without one the actions collapse to the calm settings pointer (never an action
 * the endpoint would 422). The searchable status pill reflects the auto-index in
 * both states. The summary panel, when open, keeps the session-only note visible.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const noop = () => {};

const suggestion: DocumentSuggestionDto = {
  title: "MRI knee report",
  kind: "IMAGING",
  documentDate: "2026-02-14",
};

function base(
  overrides: Partial<React.ComponentProps<typeof DocumentAiSection>> = {},
) {
  const props: React.ComponentProps<typeof DocumentAiSection> = {
    aiEnabled: true,
    indexEnabled: true,
    unavailableReason: null,
    actionsDisabled: false,
    onSuggest: noop,
    suggestPending: false,
    suggestErrorKey: null,
    onSummarise: noop,
    summaryPending: false,
    suggestion: null,
    suggestionKindLabel: null,
    suggestionDateLabel: null,
    appliedFields: { title: false, kind: false, date: false },
    onUseTitle: noop,
    onUseKind: noop,
    onUseDate: noop,
    onDismissSuggestion: noop,
    summaryOutput: null,
    summaryResult: null,
    summaryErrorKey: null,
    onCloseSummary: noop,
    hasContentIndex: false,
    contentIndexSource: null,
    indexPending: false,
    onIndex: noop,
    ...overrides,
  };
  return <DocumentAiSection {...props} />;
}

describe("<DocumentAiSection>", () => {
  it("leads with the prominent Read-with-AI action when a provider is available", () => {
    const html = render(base({ aiEnabled: true }));
    expect(html).toContain('data-slot="document-read-ai"');
    expect(html).toContain("Read with AI");
    expect(html).toContain('data-slot="assist-suggest"');
    expect(html).toContain("Suggest details");
    expect(html).toContain("Summarise");
    expect(html).toContain("Show extracted text");
    // No unavailable pointer when the actions are offered.
    expect(html).not.toContain('data-slot="assist-unavailable"');
  });

  it("labels the action as a re-read once a provider has already read it", () => {
    const html = render(
      base({ hasContentIndex: true, contentIndexSource: "vision" }),
    );
    expect(html).toContain('data-slot="document-read-ai"');
    expect(html).toContain("Read again");
    // v1.28.22 — no status pill any more; the re-read label alone carries the
    // provenance in this block (the marker lives on the vault card).
    expect(html).not.toContain('data-state="ai-read"');
  });

  it("shows the calm settings pointer (no 422 actions) when no provider is available", () => {
    const html = render(
      base({
        aiEnabled: false,
        indexEnabled: false,
        unavailableReason: "no-provider",
      }),
    );
    expect(html).toContain('data-slot="assist-unavailable"');
    expect(html).toContain('href="/settings/ai"');
    // Every AI action must be absent — never a 422-guaranteed tap.
    expect(html).not.toContain('data-slot="assist-suggest"');
    expect(html).not.toContain('data-slot="document-read-ai"');
    // v1.28.22 — the status pill is gone entirely (provenance lives on the
    // vault card's meta row); only the calm hint renders here.
    expect(html).not.toContain('data-slot="content-search-status"');
  });

  it("keeps a locally-indexed document honestly searchable without a provider", () => {
    const html = render(
      base({
        aiEnabled: false,
        indexEnabled: false,
        unavailableReason: "no-provider",
        hasContentIndex: true,
        contentIndexSource: "local-pdf",
      }),
    );
    // v1.28.22 — the searchable pill is gone; only the calm provider hint
    // renders for a locally-indexed document without a provider.
    expect(html).not.toContain('data-state="searchable"');
    expect(html).toContain('data-slot="assist-unavailable"');
    expect(html).not.toContain("Read by AI");
  });

  it("renders the reviewed suggestion drafts when present", () => {
    const html = render(
      base({
        suggestion,
        suggestionKindLabel: "Imaging",
        suggestionDateLabel: "14 Feb 2026",
      }),
    );
    expect(html).toContain('data-slot="assist-suggestion-review"');
    expect(html).toContain("MRI knee report");
  });

  it("renders the transient summary panel", () => {
    const html = render(
      base({
        summaryOutput: "summary",
        summaryResult: { summary: "An MRI report of the left knee." },
      }),
    );
    expect(html).toContain('data-slot="document-summary-panel"');
    expect(html).toContain("An MRI report of the left knee.");
  });

  it("renders no per-document egress notice — the settings confirm covers it", () => {
    // The per-document egress notice was retired; the settings-toggle honesty
    // confirm is now the single place the egress trade is stated.
    const html = render(base({ aiEnabled: true }));
    expect(html).not.toContain('data-slot="document-ai-egress-notice"');
    // The actions are still offered.
    expect(html).toContain('data-slot="assist-suggest"');
    expect(html).toContain('data-slot="document-read-ai"');
  });

  it("hides the Read-with-AI action when indexing is unavailable but keeps suggest", () => {
    const html = render(base({ aiEnabled: true, indexEnabled: false }));
    expect(html).toContain('data-slot="assist-suggest"');
    expect(html).not.toContain('data-slot="document-read-ai"');
  });

  it("collapses entirely when auto-read is on and the document is read", () => {
    const html = render(
      base({
        aiEnabled: true,
        autoReadEnabled: true,
        hasContentIndex: true,
        contentIndexSource: "vision",
      }),
    );
    // v1.28.22 — with auto-read ON, the document read, and nothing pending
    // the WHOLE block collapses: no chrome, no status pill; the sheet content
    // starts straight with the document fields under the preview.
    expect(html).toBe("");
  });

  it("keeps the read action for an unread document even with auto-read on", () => {
    // Auto-read promises reading on upload — but a document with no content
    // index never got that read (it may predate the preference, or the pass
    // did not complete). Collapsing here would leave the document with no
    // path to a read at all; the recovery action must stay visible.
    const html = render(
      base({ aiEnabled: true, autoReadEnabled: true, hasContentIndex: false }),
    );
    expect(html).toContain('data-slot="document-read-ai"');
    expect(html).toContain("Read with AI");
    expect(html).toContain('data-slot="document-unread-note"');
    expect(html).toContain("This document has not been read yet.");
    // The auto-read promise still covers the extras: no suggest / summarise.
    expect(html).not.toContain('data-slot="assist-suggest"');
    expect(html).not.toContain("Summarise");
    expect(html).not.toContain("Show extracted text");
  });

  it("still collapses an unread document when indexing is unavailable", () => {
    // No transport can index here, so there is no action to recover with —
    // an empty chrome box would be the only thing left to render.
    const html = render(
      base({
        aiEnabled: true,
        autoReadEnabled: true,
        hasContentIndex: false,
        indexEnabled: false,
      }),
    );
    expect(html).toBe("");
  });

  it("shows the manual AI action row when auto-read is off", () => {
    const html = render(base({ aiEnabled: true, autoReadEnabled: false }));
    expect(html).toContain('data-slot="document-read-ai"');
    expect(html).toContain('data-slot="assist-suggest"');
    expect(html).toContain("Summarise");
  });
});

describe("<DocumentAiSection> index outcome (#776)", () => {
  it("explains a failed index attempt in plain words, muted", () => {
    const html = render(
      base({ hasContentIndex: false, lastIndexOutcome: "local-empty" }),
    );
    expect(html).toContain('data-slot="document-index-outcome"');
    expect(html).toContain("No readable text was found");
    expect(html).toContain("text-muted-foreground");
  });

  it("also explains it on the auto-read unread branch", () => {
    const html = render(
      base({
        autoReadEnabled: true,
        hasContentIndex: false,
        lastIndexOutcome: "raster-failed",
      }),
    );
    expect(html).toContain('data-slot="document-index-outcome"');
    expect(html).toContain("couldn&#x27;t be rendered");
  });

  it("says nothing once the document IS indexed (a past failure is history)", () => {
    const html = render(
      base({
        hasContentIndex: true,
        contentIndexSource: "vision",
        lastIndexOutcome: "provider-error",
      }),
    );
    expect(html).not.toContain('data-slot="document-index-outcome"');
  });

  it("says nothing when no attempt ever ran (never tried is not a failure)", () => {
    const html = render(
      base({ hasContentIndex: false, lastIndexOutcome: null }),
    );
    expect(html).not.toContain('data-slot="document-index-outcome"');
  });
});

describe("<DocumentAiSection> background reads (v1.40)", () => {
  it("a running suggestion or summary says it reads in the background without promising it is kept", () => {
    const html = render(base({ assistRunPhase: "background" }));
    expect(html).toContain('data-slot="document-assist-run-phase"');
    expect(html).toContain("With a slow model this can take a few minutes.");
    expect(html).not.toContain("You can leave this page");
  });

  it("a read whose result lands on the document says the person may leave", () => {
    const html = render(
      base({
        indexRunPhase: "background",
        assistRunPhase: "background",
      }),
    );
    expect(html).toContain('data-slot="document-index-run-phase"');
    expect(html).toContain("You can leave this page");
    // One line at a time, never two stacked notes.
    expect(html).not.toContain('data-slot="document-assist-run-phase"');
  });

  it("says when no worker has picked the read up yet", () => {
    const html = render(base({ assistRunPhase: "waitingForWorker" }));
    expect(html).toContain("Waiting for the background worker.");
  });

  it("renders no note while nothing runs", () => {
    const html = render(base());
    expect(html).not.toContain("run-phase");
  });
});
