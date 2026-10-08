/**
 * The archive grid's shape: two tiles side by side on a phone, three or four
 * on a desktop, measured from the grid's own width (the AuthShell inset is
 * already taken off by the time the grid measures itself).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  columnsForWidth,
  DocumentMonthHeading,
  estimatedRowHeight,
} from "../document-month-grid";

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
