import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type {
  ExtractedFactDto,
  InboundDocumentDetailDto,
} from "@/lib/validations/inbound-documents";

import { DocumentFactsSection } from "../document-facts-review";

/**
 * The staged-facts block's honest states, pinned by static render:
 *
 *   - a document with PENDING facts shows the review action (the control the
 *     detail view never had — its absence forced a re-upload through Labs);
 *   - a lab-filed, already-read document with nothing staged offers the
 *     stored-text extract (recovery for a skipped automatic run);
 *   - a delegate inside somebody else's record sees neither (staging and
 *     confirming write to the owner's record);
 *   - a fully confirmed document renders nothing — the surface stays calm.
 */

function render(node: React.ReactNode) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

function fact(overrides: Partial<ExtractedFactDto> = {}): ExtractedFactDto {
  return {
    id: "fact-1",
    factType: "OBSERVATION",
    status: "PENDING",
    confidence: 0.95,
    needsReview: false,
    data: {
      label: "Hemoglobin",
      code: null,
      codeSystem: null,
      value: 13.9,
      valueText: null,
      unit: "g/dL",
      referenceLow: 12,
      referenceHigh: 16,
      referenceText: "12-16",
      effectiveDate: "2026-08-01",
    },
    provenance: {
      sourceText: "Hemoglobin 13.9 g/dL",
      anchored: true,
      sourceOffset: 10,
      page: 0,
      confidence: 0.95,
    },
    committedRecordId: null,
    committedRecordType: null,
    ...overrides,
  };
}

function doc(
  overrides: Partial<InboundDocumentDetailDto> = {},
): InboundDocumentDetailDto {
  return {
    id: "doc-1",
    kind: "LAB_RESULT",
    title: "Blood panel",
    filename: "panel.pdf",
    mimeType: "application/pdf",
    byteSize: 1000,
    status: "EXTRACTED",
    providerType: "anthropic",
    reportDate: "2026-08-01",
    documentDate: null,
    errorReason: null,
    factCount: 1,
    pendingCount: 1,
    conditionLinks: [],
    encounterLinks: [],
    vaccinationLinks: [],
    servingClass: "inline",
    hasContentIndex: true,
    contentIndexSource: "vision",
    lastIndexAttemptAt: null,
    lastIndexOutcome: null,
    hasThumbnail: false,
    sourceSystem: null,
    sourceId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    facts: [fact()],
    summary: null,
    summaryGeneratedAt: null,
    summaryState: "NONE",
    ...overrides,
  };
}

const baseProps = {
  canManage: true,
  aiEnabled: true,
  labsModuleEnabled: true,
};

describe("<DocumentFactsSection>", () => {
  it("shows the review action for a lab document with pending facts", () => {
    const html = render(<DocumentFactsSection doc={doc()} {...baseProps} />);
    expect(html).toContain('data-slot="document-facts-review-open"');
    expect(html).toContain("Review extracted value");
  });

  it("offers the stored-text extract for a read lab document with nothing staged", () => {
    const html = render(
      <DocumentFactsSection
        doc={doc({ status: "STORED", facts: [], factCount: 0 })}
        {...baseProps}
      />,
    );
    expect(html).toContain('data-slot="document-facts-extract"');
    expect(html).toContain("Extract lab values");
    // Honest about the mechanism: stored text, review-first, no auto-save.
    expect(html).toContain("nothing is saved automatically");
  });

  it("withdraws the extract offer once facts were approved", () => {
    const html = render(
      <DocumentFactsSection
        doc={doc({
          facts: [fact({ status: "APPROVED", committedRecordId: "lab-1" })],
        })}
        {...baseProps}
      />,
    );
    expect(html).not.toContain('data-slot="document-facts-extract"');
    expect(html).not.toContain('data-slot="document-facts-review-open"');
  });

  it("renders nothing for a delegate inside somebody else's record", () => {
    const html = render(
      <DocumentFactsSection doc={doc()} {...baseProps} canManage={false} />,
    );
    expect(html).toBe("");
  });

  it("renders nothing for an unread non-lab document", () => {
    const html = render(
      <DocumentFactsSection
        doc={doc({ kind: "DOCTOR_REPORT", facts: [], factCount: 0 })}
        {...baseProps}
      />,
    );
    expect(html).toBe("");
  });
});
