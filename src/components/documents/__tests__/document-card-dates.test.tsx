import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { makeFormatters } from "@/lib/format-locale";
import { I18nProvider } from "@/lib/i18n/context";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

/**
 * A document's filing date is a calendar date. The card used to anchor it at
 * 12:00 UTC and format that instant in the reader's zone, which shows the
 * next day from UTC+12 to UTC+14. A document without a filing date shows its
 * upload day, an instant, in the reader's zone.
 *
 * Server rendering cannot see the reader's profile zone, so the formatter
 * hook is handed one.
 */
const zone = vi.hoisted(() => ({ current: "UTC" }));

vi.mock("@/lib/i18n/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/context")>();
  return {
    ...actual,
    useFormatters: () => makeFormatters("en", zone.current, "AUTO", "AUTO"),
  };
});

const { DocumentCard } = await import("../document-card");

function doc(overrides: Partial<InboundDocumentDto>): InboundDocumentDto {
  return {
    id: "doc-1",
    kind: "IMAGING",
    title: "Scan",
    filename: "scan.pdf",
    mimeType: "application/pdf",
    byteSize: 1000,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: null,
    errorReason: null,
    factCount: 0,
    pendingCount: 0,
    conditionLinks: [],
    encounterLinks: [],
    servingClass: "inline",
    hasContentIndex: false,
    contentIndexSource: null,
    lastIndexAttemptAt: null,
    lastIndexOutcome: null,
    hasThumbnail: false,
    sourceSystem: null,
    sourceId: null,
    sourceUrl: null,
    createdAt: "2025-10-04T20:30:00.000Z",
    updatedAt: "2025-10-04T20:30:00.000Z",
    ...overrides,
  };
}

function render(document: InboundDocumentDto) {
  const noop = () => {};
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentCard
        document={document}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />
    </I18nProvider>,
  );
}

const previousTz = process.env.TZ;

describe("document card dates across zones", () => {
  afterEach(() => {
    process.env.TZ = previousTz;
    zone.current = "UTC";
  });

  describe.each(["Pacific/Kiritimati", "America/Los_Angeles"])(
    "in %s",
    (tz) => {
      beforeEach(() => {
        process.env.TZ = tz;
        zone.current = tz;
      });

      it("shows the filing date as stated", () => {
        const html = render(doc({ documentDate: "2025-10-04" }));
        expect(html).toContain("10/04/2025");
        expect(html).not.toContain("10/05/2025");
        expect(html).not.toContain("10/03/2025");
      });
    },
  );

  it("shows the upload day in the reader's zone when no filing date is set", () => {
    // 20:30 UTC on 4 October is 10:30 on 5 October in Kiritimati.
    process.env.TZ = "Pacific/Kiritimati";
    zone.current = "Pacific/Kiritimati";
    expect(render(doc({ documentDate: null }))).toContain("10/05/2025");
  });
});
