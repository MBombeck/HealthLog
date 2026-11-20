import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { InboundDocumentDetailDto } from "@/lib/validations/inbound-documents";
import { DocumentDetailMeta } from "../detail-sections";
import type { DocumentDetail } from "../use-document-detail";

/**
 * #1394 — the detail sheet links an imported document back to its original
 * when, and only when, the server sent the owner a `sourceUrl`.
 */
const NAMES = { PAPERLESS: "Paperless-ngx", PAPRA: "Papra", OTHER: "Other" };

function render(over: Partial<InboundDocumentDetailDto>) {
  const doc = {
    createdAt: "2026-06-01T00:00:00.000Z",
    byteSize: 1024,
    filename: null,
    sourceSystem: "PAPERLESS",
    sourceId: "123",
    sourceUrl: null,
    ...over,
  } as InboundDocumentDetailDto;
  const detail = {
    labsModuleEnabled: false,
    labFactCount: 0,
    sourceSystemName: (s: keyof typeof NAMES) => NAMES[s],
  } as unknown as DocumentDetail;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentDetailMeta doc={doc} detail={detail} />
    </I18nProvider>,
  );
}

describe("DocumentDetailMeta — archive link", () => {
  it("opens the Paperless-ngx original in a new tab", () => {
    const html = render({
      sourceUrl: "https://paperless.example.com/documents/123/details",
    });
    expect(html).toContain('data-slot="document-detail-source-link"');
    expect(html).toContain(
      'href="https://paperless.example.com/documents/123/details"',
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Open in Paperless-ngx");
    expect(html).toContain("Imported from Paperless-ngx, ID 123");
  });

  it("names Papra for a Papra copy", () => {
    const html = render({
      sourceSystem: "PAPRA",
      sourceId: "doc_1",
      sourceUrl: "http://papra.lan:1221/organizations/o/documents/doc_1",
    });
    expect(html).toContain("Open in Papra");
  });

  it("shows only the provenance line without a link", () => {
    const html = render({ sourceUrl: null });
    expect(html).toContain("Imported from Paperless-ngx, ID 123");
    expect(html).not.toContain("document-detail-source-link");
  });

  it("never turns a non-web address into a link", () => {
    const html = render({ sourceUrl: "javascript:alert(1)" });
    expect(html).not.toContain("document-detail-source-link");
    expect(html).not.toContain("javascript:");
  });
});
