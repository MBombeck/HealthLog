import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { modules: { vaccinations: true } } }),
}));
vi.mock("@/hooks/use-encounters", () => ({
  useEncounters: () => ({
    data: { upcoming: [], past: [] },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
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
  it("lets a manager link the page to doses and visits", () => {
    const html = render(
      <DocumentRecordLinks
        doc={doc()}
        canManage
        seedFresh
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('data-slot="document-vaccination-links"');
    expect(html).toContain('data-slot="document-vaccination-links-add"');
    expect(html).toContain('data-slot="document-visit-links"');
  });

  it("shows a read-only reader the doses the page is filed against", () => {
    const html = render(
      <DocumentRecordLinks
        doc={doc({
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
    expect(html).toContain('data-slot="document-vaccination-link"');
    expect(html).toContain("DTP");
    expect(html).not.toContain('data-slot="document-vaccination-links-add"');
  });

  it("shows no dose block at all when the grant withholds the doses", () => {
    const html = render(
      <DocumentRecordLinks
        doc={doc({ vaccinationLinks: null })}
        canManage
        seedFresh
        onChange={() => undefined}
      />,
    );
    expect(html).not.toContain("document-vaccination-links");
  });

  it("offers no picker until the document has been read since the sheet opened", () => {
    // Each change is a replace-set write seeded from the document's links.
    // Seeded from a cached copy that predates a link made on the dose's or
    // the visit's own form, the first tap would silently delete that link.
    const html = render(
      <DocumentRecordLinks
        doc={doc()}
        canManage
        seedFresh={false}
        onChange={() => undefined}
      />,
    );
    expect(html).not.toContain('data-slot="document-vaccination-links-add"');
    expect(html).not.toContain('data-slot="document-visit-links-add"');
  });

  describe("chips open the record they point at (#1024)", () => {
    it("a manager's dose chip carries the dose date and opens the dose", () => {
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
      const open = html.match(
        /<a[^>]*data-slot="document-vaccination-links-chip-open"[^>]*>/,
      );
      expect(open?.[0]).toContain('href="/vaccinations?dose=dose-1"');
      // The date tells two doses of one vaccine apart.
      expect(open?.[0]).toBeDefined();
      expect(html).toMatch(/>Tetanus<\/span><span[^>]*>04\/02\/1991</);
      // The label is not the unlink control; the X is.
      expect(html).toContain(
        'data-slot="document-vaccination-links-chip-remove"',
      );
    });

    it("a reader's dose chip opens that dose, not the whole list", () => {
      const html = render(
        <DocumentRecordLinks
          doc={doc({
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
      expect(html).toContain('href="/vaccinations?dose=dose-1"');
    });

    it("a reader's visit chip opens the visit", () => {
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
      expect(html).toContain('href="/checkups?visit=enc-1"');
    });
  });
});
