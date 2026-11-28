/**
 * The domain page blocks: the wrench and the wide-screen add in the header,
 * the records heading with its count, the "show n more" row, the menu select
 * and the chevron in a row value's glyph slot.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { ListHeading, ListMoreRow } from "@/components/ui/list-row";
import { MenuSelect } from "@/components/ui/menu-select";
import {
  PageAddButton,
  PageCustomizeButton,
} from "@/components/ui/page-customize";
import { RowValue } from "@/components/ui/row-value";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("domain page blocks", () => {
  it("names the wrench 'Customize page' and keeps the add off a phone", () => {
    const wrench = render(<PageCustomizeButton onClick={() => {}} />);
    expect(wrench).toContain('data-slot="page-customize"');
    expect(wrench).toContain('aria-label="Customize page"');
    const add = render(<PageAddButton onClick={() => {}} />);
    expect(add).toContain("shell-mobile:hidden");
    expect(add).toContain("Add");
  });

  it("states the count once, beside the heading", () => {
    const html = render(<ListHeading title="Trainings" count={33} />);
    expect(html).toContain("<h2");
    expect(html).toContain('data-slot="list-heading-count"');
    expect(html.match(/33/g)).toHaveLength(1);
  });

  it("ends a group in one 'show more' row that says why it failed", () => {
    expect(
      render(<ListMoreRow label="Weitere 5 zeigen" onSelect={() => {}} />),
    ).toContain("Weitere 5 zeigen");
    expect(
      render(
        <ListMoreRow label="Weitere 5 zeigen" onSelect={() => {}} error="x" />,
      ),
    ).not.toContain("Weitere 5 zeigen");
  });

  it("names the menu select by what is chosen and what it chooses", () => {
    const html = render(
      <MenuSelect
        value="b"
        label="Kalender zeigt"
        slot="m"
        options={[
          { value: "a", label: "Schritte" },
          { value: "b", label: "Aktive Minuten" },
        ]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Kalender zeigt: Aktive Minuten"');
    expect(html).toContain('data-value="b"');
  });

  it("puts the chevron in the row value's glyph slot", () => {
    expect(render(<RowValue chevron>Schritte</RowValue>)).toContain(
      "lucide-chevron-right",
    );
    expect(render(<RowValue>Schritte</RowValue>)).not.toContain(
      "lucide-chevron-right",
    );
  });
});
