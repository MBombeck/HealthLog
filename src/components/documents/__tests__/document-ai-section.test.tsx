import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

const record = vi.hoisted(() => ({ inSharedRecord: false }));
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ inSharedRecord: record.inSharedRecord }),
}));
import type { DocumentSuggestionDto } from "@/lib/validations/inbound-documents";
import {
  DocumentAiSection,
  useDocumentAiMenuItems,
} from "../document-ai-section";

/**
 * The detail sheet's AI reads are entries of its "⋯", availability-gated: with
 * a provider the menu offers read, summarise, suggest and show-text; without
 * one there is no entry (never an action the endpoint would 422) and the block
 * is the calm settings pointer. The block itself shows only what a read left:
 * where it stands, why it found nothing, a suggestion, the shown text.
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
    suggestErrorKey: null,
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
    ...overrides,
  };
  return <DocumentAiSection {...props} />;
}

type MenuArgs = Parameters<typeof useDocumentAiMenuItems>[0];

/** The menu's entries as `[data-slot, label]` pairs. */
function menu(overrides: Partial<MenuArgs> = {}): [string, string][] {
  const args: MenuArgs = {
    aiEnabled: true,
    autoReadEnabled: false,
    indexEnabled: true,
    hasContentIndex: false,
    contentIndexSource: null,
    canSummarise: true,
    actionsDisabled: false,
    indexPending: false,
    suggestPending: false,
    summaryPending: false,
    onIndex: noop,
    onSuggest: noop,
    onShowText: noop,
    onSummarise: noop,
    ...overrides,
  };
  let items: React.ReactNode[] = [];
  function Probe() {
    items = useDocumentAiMenuItems(args);
    return null;
  }
  render(<Probe />);
  return items.map((item) => {
    const props = (
      item as React.ReactElement<{
        "data-slot": string;
        children: React.ReactNode[];
      }>
    ).props;
    return [props["data-slot"], String(props.children[1])];
  });
}
const slots = (entries: [string, string][]) => entries.map(([slot]) => slot);

describe("the AI entries of the sheet's menu", () => {
  it("offers read, summarise, suggest and show-text with a provider", () => {
    const entries = menu();
    expect(slots(entries)).toEqual([
      "document-read-ai",
      "document-detail-summary-generate",
      "assist-suggest",
      "document-show-text",
    ]);
    expect(entries[0][1]).toBe("Read with AI");
  });

  it("labels the read as a re-read once a provider has read it", () => {
    const entries = menu({
      hasContentIndex: true,
      contentIndexSource: "vision",
    });
    expect(entries[0]).toEqual(["document-read-ai", "Read again"]);
  });

  it("offers nothing without a provider", () => {
    expect(menu({ aiEnabled: false, indexEnabled: false })).toEqual([]);
  });

  it("drops the read when indexing is unavailable but keeps suggest", () => {
    const s = slots(menu({ indexEnabled: false }));
    expect(s).toContain("assist-suggest");
    expect(s).not.toContain("document-read-ai");
  });

  it("with auto-read on and the document read, only summarise is left", () => {
    expect(
      slots(
        menu({
          autoReadEnabled: true,
          hasContentIndex: true,
          contentIndexSource: "vision",
        }),
      ),
    ).toEqual(["document-detail-summary-generate"]);
  });

  it("keeps the read for an unread document even with auto-read on", () => {
    // Auto-read promises reading on upload, but a document with no content
    // index never got that read; without the entry it would have no path to
    // one at all. The promise still covers the extras.
    expect(slots(menu({ autoReadEnabled: true }))).toEqual([
      "document-read-ai",
      "document-detail-summary-generate",
    ]);
  });

  it("offers no second summarise while a stored one is being written", () => {
    expect(slots(menu({ canSummarise: false }))).not.toContain(
      "document-detail-summary-generate",
    );
  });
});

describe("<DocumentAiSection>", () => {
  it("renders nothing when no read has left anything to show", () => {
    expect(render(base())).toBe("");
  });

  it("shows the calm settings pointer when no provider is available", () => {
    const html = render(
      base({
        aiEnabled: false,
        indexEnabled: false,
        unavailableReason: "no-provider",
      }),
    );
    expect(html).toContain('data-slot="assist-unavailable"');
    expect(html).toContain('href="/settings/ai"');
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

  it("renders the shown text panel", () => {
    const html = render(
      base({
        summaryOutput: "summary",
        summaryResult: { summary: "An MRI report of the left knee." },
      }),
    );
    expect(html).toContain('data-slot="document-summary-panel"');
    expect(html).toContain("An MRI report of the left knee.");
  });

  it("renders no per-document egress notice; the settings confirm covers it", () => {
    const html = render(base({ suggestion }));
    expect(html).not.toContain('data-slot="document-ai-egress-notice"');
  });

  it("says an unread document has not been read when auto-read is on", () => {
    const html = render(
      base({ autoReadEnabled: true, hasContentIndex: false }),
    );
    expect(html).toContain('data-slot="document-unread-note"');
    expect(html).toContain("This document has not been read yet.");
  });

  it("stays empty for an unread document when indexing is unavailable", () => {
    const html = render(
      base({
        autoReadEnabled: true,
        hasContentIndex: false,
        indexEnabled: false,
      }),
    );
    expect(html).toBe("");
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
