import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { modules: { vaccinations: true } } }),
}));
vi.mock("@/components/links/use-link-picker-pages", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/links/use-link-picker-pages")
  >()),
  // The visit picker's pages: none loaded, nothing more to page.
  useLinkPickerPages: () => ({
    items: [],
    pending: false,
    error: false,
    retry: vi.fn(),
    term: "",
    setTerm: vi.fn(),
    searchPending: false,
    filterLocally: true,
    period: null,
    hasOlder: false,
    hasNewer: false,
    loadingOlder: false,
    loadingNewer: false,
    loadOlder: vi.fn(),
    loadNewer: vi.fn(),
  }),
}));
vi.mock("@/components/vaccinations/use-vaccinations", () => ({
  useVaccinations: () => ({
    data: {
      vaccinations: [
        {
          id: "dose-1",
          occurredAt: "1991-04-02T00:00:00.000Z",
          catalogEntry: {
            slug: "tetanus",
            atc: "J07AM01",
            category: "standard",
          },
          vaccineName: null,
        },
      ],
    },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import type { InboundDocumentDetailDto } from "@/lib/validations/inbound-documents";
import { DocumentRecordLinks, recordOptions } from "../document-record-links";

function doc(
  over: Partial<InboundDocumentDetailDto> = {},
): InboundDocumentDetailDto {
  return {
    id: "doc-1",
    kind: "VACCINATION",
    title: "Childhood record",
    filename: null,
    mimeType: "application/pdf",
    byteSize: 1,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: "1991-04-02",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    facts: [],
    vaccinationLinks: [],
    summary: null,
    summaryGeneratedAt: null,
    summaryState: "NONE",
    ...over,
  } as InboundDocumentDetailDto;
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("recordOptions", () => {
  it("puts records near the document first and groups the rest by year", () => {
    const options = recordOptions(
      [
        {
          id: "late",
          label: "Tetanus",
          occurredAt: "2010-06-01T00:00:00.000Z",
        },
        { id: "near", label: "Polio", occurredAt: "1991-04-05T00:00:00.000Z" },
      ],
      "1991-04-02",
      { suggested: "Around this date", date: (iso) => iso.slice(0, 10) },
    );
    expect(options.map((o) => o.id)).toEqual(["near", "late"]);
    expect(options[0]!.group?.key).toBe("suggested");
    expect(options[1]!.group).toEqual({ key: "2010", label: "2010" });
  });
});

describe("<DocumentRecordLinks>", () => {
  const ADD = 'data-slot="document-links-add"';

  it("writes nothing at all for a reader of a page filed against nothing", () => {
    const html = render(
      <DocumentRecordLinks
        doc={doc()}
        canManage={false}
        seedFresh
        onChange={() => undefined}
      />,
    );
    expect(html).toBe("");
  });

  it("gives a manager one link button, without any empty line", () => {
    const html = render(
      <DocumentRecordLinks
        doc={doc()}
        canManage
        seedFresh
        onChange={() => undefined}
      />,
    );
    expect(html).toContain(ADD);
    // Visits and doses: the button asks which family first.
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain("Nothing to link yet");
    expect(html).not.toContain("No vaccinations recorded");
  });

  it("shows every link as one row of chips, conditions, visits and doses alike", () => {
    const html = render(
      <DocumentRecordLinks
        doc={doc({
          conditionLinks: [{ episodeId: "ep-1", name: "Knee pain" }],
          encounterLinks: [
            {
              encounterId: "enc-1",
              kind: "CHECKUP",
              occurredAt: "2026-03-01T09:00:00.000Z",
            },
          ],
          vaccinationLinks: [
            {
              vaccinationId: "dose-1",
              occurredAt: "1991-04-02T00:00:00.000Z",
              catalogSlug: null,
              vaccineName: "DTP",
            },
          ],
        })}
        canManage={false}
        seedFresh
        onChange={() => undefined}
      />,
    );
    expect(html.match(/data-slot="document-links-chips"/g)?.length).toBe(1);
    expect(html).toContain('href="/illness/ep-1"');
    expect(html).toContain('href="/care?visit=enc-1"');
    expect(html).toContain('href="/vaccinations?dose=dose-1"');
    expect(html).not.toContain(ADD);
  });

  it("shows no dose chip and offers no dose picker when the grant withholds the doses", () => {
    const html = render(
      <DocumentRecordLinks
        doc={doc({ vaccinationLinks: null })}
        canManage
        seedFresh
        onChange={() => undefined}
      />,
    );
    expect(html).not.toContain('data-kind="vaccination"');
    // Visits alone: the button opens that picker straight away, no menu.
    expect(html).toContain(ADD);
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  it("holds the link button until the document has been read since the sheet opened", () => {
    // Each change is a replace-set write seeded from the document's links.
    // Seeded from a cached copy that predates a link made on the dose's or
    // the visit's own form, the first tap would silently delete that link.
    const stale = render(
      <DocumentRecordLinks
        doc={doc()}
        canManage
        seedFresh={false}
        onChange={() => undefined}
      />,
    );
    expect(stale).toMatch(
      /<button[^>]*disabled=""[^>]*data-slot="document-links-add"|<button[^>]*data-slot="document-links-add"[^>]*disabled=""/,
    );
    // A failed fresh read lets the picker open on its retry row.
    const failed = render(
      <DocumentRecordLinks
        doc={doc()}
        canManage
        seedFresh={false}
        seedError
        onChange={() => undefined}
      />,
    );
    expect(failed).not.toMatch(
      /<button[^>]*disabled=""[^>]*data-slot="document-links-add"|<button[^>]*data-slot="document-links-add"[^>]*disabled=""/,
    );
  });

  describe("chips open the record they point at (#1024)", () => {
    it("a dose chip carries the dose date and opens the dose", () => {
      const html = render(
        <DocumentRecordLinks
          doc={doc({
            vaccinationLinks: [
              {
                vaccinationId: "dose-1",
                occurredAt: "1991-04-02T00:00:00.000Z",
                catalogSlug: "tetanus",
                vaccineName: null,
              },
            ],
          })}
          canManage
          seedFresh
          onChange={() => undefined}
        />,
      );
      const open = html.match(/<a[^>]*data-kind="vaccination"[^>]*>/);
      expect(open?.[0]).toContain('href="/vaccinations?dose=dose-1"');
      // The date tells two doses of one vaccine apart.
      expect(html).toMatch(/>Tetanus<\/span>.*04\/02\/1991/);
    });

    it("a visit chip opens the visit", () => {
      const html = render(
        <DocumentRecordLinks
          doc={doc({
            encounterLinks: [
              {
                encounterId: "enc-1",
                kind: "CHECKUP",
                occurredAt: "2026-03-01T09:00:00.000Z",
              },
            ],
          } as never)}
          canManage={false}
          seedFresh
          onChange={() => undefined}
        />,
      );
      expect(html).toContain('href="/care?visit=enc-1"');
    });
  });
});
