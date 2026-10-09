/**
 * The archive grid's shape: two tiles side by side on a phone, three or four
 * on a desktop, measured from the grid's own width (the AuthShell inset is
 * already taken off by the time the grid measures itself).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import {
  columnsForWidth,
  DocumentMonthHeading,
  DocumentMonthRow,
  estimatedRowHeight,
  listColumnsForWidth,
} from "../document-month-grid";

function doc(id: string): InboundDocumentDto {
  return {
    id,
    kind: "DOCTOR_REPORT",
    title: `Letter ${id}`,
    filename: null,
    mimeType: "application/pdf",
    byteSize: 1024,
    status: "STORED",
    documentDate: "2026-03-10",
    createdAt: "2026-03-10T10:00:00Z",
    conditionLinks: [],
    servingClass: "inline",
    hasThumbnail: false,
    hasContentIndex: true,
  } as unknown as InboundDocumentDto;
}

function renderRow(props: Partial<Parameters<typeof DocumentMonthRow>[0]>) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentMonthRow
        documents={[doc("a"), doc("b")]}
        columns={2}
        selectedIds={new Set()}
        onOpen={() => {}}
        highlightId={null}
        rovingId="a"
        onCardFocus={() => {}}
        {...props}
      />
    </I18nProvider>,
  );
}

describe("columnsForWidth", () => {
  it("lays a 390 px phone out in two columns, the narrowest screens in one", () => {
    // 390 viewport minus the shell's 16 px gutters.
    expect(columnsForWidth(358)).toBe(2);
    expect(columnsForWidth(320 - 32)).toBe(1);
  });

  it("uses three columns on a small desktop and four on a wide one", () => {
    expect(columnsForWidth(1024 - 48)).toBe(3);
    // 1440 viewport: the shell caps the container at 1280 minus its gutters.
    expect(columnsForWidth(1280 - 48)).toBe(4);
    // 1440 with the sidebar and the day strip docked: about 1 040 px left,
    // still four tiles of about 240 px.
    expect(columnsForWidth(1040)).toBe(4);
  });

  it("never asks for a fifth column", () => {
    expect(columnsForWidth(4000)).toBe(4);
  });
});

describe("estimatedRowHeight", () => {
  it("grows with the tile's width, so the first guess is close to the measured row", () => {
    expect(estimatedRowHeight(358, 2)).toBeLessThan(
      estimatedRowHeight(1232, 2),
    );
    expect(estimatedRowHeight(358, 2)).toBeGreaterThan(200);
  });
});

describe("<DocumentMonthHeading>", () => {
  it("keeps the month heading as the grid's section label", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <DocumentMonthHeading label="March 2026" />
      </I18nProvider>,
    );
    expect(html).toMatch(/^<h2 [^>]*uppercase[^>]*>March 2026<\/h2>$/);
  });
});

describe("listColumnsForWidth", () => {
  it("keeps compact rows single-file on a phone and side by side on a desktop", () => {
    expect(listColumnsForWidth(358)).toBe(1);
    expect(listColumnsForWidth(1024 - 48)).toBe(2);
    expect(listColumnsForWidth(1280 - 48)).toBe(3);
  });
});

describe("<DocumentMonthRow>", () => {
  it("renders preview tiles by default and compact rows in the list view", () => {
    expect(renderRow({})).toContain('data-variant="tile"');
    const list = renderRow({ view: "list" });
    expect(list).toContain('data-variant="row"');
    expect(list).not.toContain('data-variant="tile"');
  });

  it("flowing: the month name rides inline above the document that opens it", () => {
    const html = renderRow({
      monthStarts: { b: "2026-02" },
      formatMonth: () => "February 2026",
    });
    expect(html.match(/data-slot="document-flow-month"/g)).toHaveLength(1);
    expect(html).toContain("February 2026");
    // The marker belongs to b's cell, not a's.
    expect(html.indexOf("February 2026")).toBeGreaterThan(
      html.indexOf('data-document-id="a"'),
    );
    expect(html.indexOf("February 2026")).toBeLessThan(
      html.indexOf('data-document-id="b"'),
    );
  });

  it("stacked rows carry no inline month marker", () => {
    expect(renderRow({})).not.toContain('data-slot="document-flow-month"');
  });
});
