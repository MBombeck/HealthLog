import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import { DocumentCard, UploadStateCard } from "../document-card";
import type { UploadQueueItem } from "../use-document-upload";

/**
 * The vault card's render contract: title falls back filename → "untitled",
 * the meta line stays muted, the attachment-class badge appears ONLY for
 * download-only formats, condition links paint as pills, and the two
 * transient upload cards (in-flight ring / translated failure) render from
 * the same footprint.
 */

function doc(overrides: Partial<InboundDocumentDto> = {}): InboundDocumentDto {
  return {
    id: "doc-1",
    kind: "IMAGING",
    title: "MRT Knie",
    filename: "mrt-knie.pdf",
    mimeType: "application/pdf",
    byteSize: 2_500_000,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: "2025-10-04",
    errorReason: null,
    factCount: 0,
    pendingCount: 0,
    conditionLinks: [{ episodeId: "ep-knee", name: "Knie" }],
    encounterLinks: [],
    servingClass: "inline",
    hasContentIndex: false,
    contentIndexSource: null,
    lastIndexAttemptAt: null,
    lastIndexOutcome: null,
    hasThumbnail: false,
    sourceSystem: null,
    sourceId: null,
    createdAt: "2025-10-05T08:00:00.000Z",
    updatedAt: "2025-10-05T08:00:00.000Z",
    ...overrides,
  };
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const noop = () => {};

describe("<DocumentCard>", () => {
  it("renders title, condition pill, and NO attachment badge for inline docs", () => {
    const html = render(
      <DocumentCard
        document={doc()}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).toContain("MRT Knie");
    expect(html).toContain("Knie");
    expect(html).toContain('data-document-id="doc-1"');
    expect(html).not.toContain("Download only");
  });

  it("announces and shows the Delete shortcut when the card is deletable", () => {
    const html = render(
      <DocumentCard
        document={doc()}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        onDelete={noop}
        highlighted={false}
      />,
    );
    // The keyboard contract used to live only in a code comment. It is now
    // announced to assistive tech and drawn while the card holds focus.
    expect(html).toContain('aria-keyshortcuts="Delete"');
    expect(html).toContain('data-slot="document-delete-hint"');
    expect(html).toContain("Del");
  });

  it("offers no delete shortcut when the card carries no delete handler", () => {
    const html = render(
      <DocumentCard
        document={doc()}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).not.toContain("aria-keyshortcuts");
    expect(html).not.toContain('data-slot="document-delete-hint"');
  });

  it("shows the download-only badge for attachment-class documents", () => {
    const html = render(
      <DocumentCard
        document={doc({
          servingClass: "attachment",
          hasContentIndex: false,
          mimeType: "application/octet-stream",
          filename: "befund.docx",
          title: null,
        })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).toContain("Download only");
    // Title falls back to the filename.
    expect(html).toContain("befund.docx");
  });

  it("never emits a browser-issued /api subresource for the thumbnail", () => {
    // v1.37.0 — this used to assert `src="/api/documents/inbound/…/thumbnail"`
    // in the markup, and that contract is deliberately gone. A `<img src>` is
    // issued by the BROWSER, so it cannot carry the record-session assertion,
    // and the fence refuses an unasserted request on any session that has been
    // inside a shared record — a thumbnail that silently stops rendering for
    // good. The bytes now come through the app transport as an object URL
    // (`useFencedObjectUrl`), which means nothing paints on a server render.
    //
    // The assertion is inverted rather than deleted: the markup must contain no
    // `/api/` reference at all. `src/__tests__/record-fence-headerless-transport-guard.test.ts`
    // holds the same property across the whole client tree, and
    // `src/hooks/__tests__/use-fenced-object-url.test.ts` proves the request
    // really does carry the headers.
    const html = render(
      <DocumentCard
        document={doc({ hasThumbnail: true })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).not.toContain("/api/documents");
    // Until the blob lands the card shows its kind icon, exactly as a card
    // with no thumbnail does — never a broken image.
    expect(html).not.toContain('data-slot="document-thumbnail"');
    expect(html).toContain("lucide-scan-line");
  });

  it("shows the kind icon (no thumbnail image) when hasThumbnail is false", () => {
    const html = render(
      <DocumentCard
        document={doc({ hasThumbnail: false })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).not.toContain('data-slot="document-thumbnail"');
    expect(html).not.toContain("/thumbnail");
  });

  it("does NOT render the AI-read glyph on the card face, even when AI-read", () => {
    // The AI-read state stays surfaced authoritatively in the detail sheet's
    // DocumentAiSection; the card face no longer duplicates it (v1.28.38).
    const html = render(
      <DocumentCard
        document={doc({ hasContentIndex: true, contentIndexSource: "vision" })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).not.toContain('data-slot="document-card-ai-read"');
  });

  it("renders the filename on its own line with the full name in title", () => {
    const html = render(
      <DocumentCard
        document={doc({
          title: "MRT Knie",
          filename: "mrt-knie-2025-10-04.pdf",
        })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    // Dedicated filename line, muted text-xs, full name reachable on hover.
    expect(html).toContain('data-slot="document-card-filename"');
    expect(html).toContain('title="mrt-knie-2025-10-04.pdf"');
    expect(html).toContain("mrt-knie-2025-10-04.pdf");
  });

  it("omits the filename line when the filename equals the title", () => {
    const html = render(
      <DocumentCard
        document={doc({ title: "report.pdf", filename: "report.pdf" })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).not.toContain('data-slot="document-card-filename"');
  });

  it("falls back to the untitled label and rings when highlighted", () => {
    const html = render(
      <DocumentCard
        document={doc({ title: null, filename: null })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted
      />,
    );
    expect(html).toContain("Untitled document");
    expect(html).toContain("ring-2");
  });

  // v1.29.x — the fire-and-forget auto-index job is invisible otherwise;
  // the card surfaces its own "Processing…" chip for a freshly uploaded,
  // not-yet-indexed document. `isDocumentProcessing` (vault-utils) bounds
  // this to the recent-upload window; `doc()`'s default `createdAt` is old,
  // so the baseline render above never shows the chip.
  it("shows the Processing… chip for a freshly uploaded, not-yet-indexed document", () => {
    const html = render(
      <DocumentCard
        document={doc({
          createdAt: new Date().toISOString(),
          hasContentIndex: false,
        })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).toContain('data-slot="document-processing-badge"');
    expect(html).toContain("Processing");
  });

  it("shows no Processing… chip once the document is indexed", () => {
    const html = render(
      <DocumentCard
        document={doc({
          createdAt: new Date().toISOString(),
          hasContentIndex: true,
        })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).not.toContain('data-slot="document-processing-badge"');
  });

  it("shows no Processing… chip for an old, never-indexed document (outside the window)", () => {
    const html = render(
      <DocumentCard
        document={doc({ hasContentIndex: false })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).not.toContain('data-slot="document-processing-badge"');
  });
});

describe("<UploadStateCard>", () => {
  const base: UploadQueueItem = {
    localId: "u1",
    fileName: "scan.jpg",
    byteSize: 4_000_000,
    status: "uploading",
    progress: 0.4,
  };

  it("paints the progress ring while uploading", () => {
    const html = render(<UploadStateCard item={base} onDismiss={noop} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain("scan.jpg");
  });

  it("renders the translated over-limit reason with the configured cap", () => {
    const html = render(
      <UploadStateCard
        item={{
          ...base,
          status: "error",
          failure: {
            ok: false,
            reason: "fileTooLarge",
            maxFileBytes: 26_214_400,
          },
        }}
        onDismiss={noop}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("25 MB");
    expect(html).not.toContain('role="progressbar"');
  });

  it("renders the quota reason with used/quota figures", () => {
    const html = render(
      <UploadStateCard
        item={{
          ...base,
          status: "error",
          failure: {
            ok: false,
            reason: "quotaExceeded",
            quotaBytes: 1_073_741_824,
            usedBytes: 1_020_054_732,
          },
        }}
        onDismiss={noop}
      />,
    );
    expect(html).toContain("Storage is full");
    expect(html).toContain("1 GB");
  });
});
