/**
 * #1034 — the units-per-dose control: curated buttons plus an Other field,
 * and the mixed glyph wherever a stored value is shown.
 *
 * Project convention is SSR-only component tests (`renderToStaticMarkup`).
 * The field's open state is derived from the value on mount, which is the
 * part a static render can pin: a stored value no button holds must open
 * the field showing it, never fall back to a button.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { summariseSupply } from "@/lib/medications/inventory/summary";
import { UnitsPerDoseField } from "../units-per-dose-field";

const useQueryMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useQueryClient: () => ({
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { InventorySection } = await import("../sections/inventory-section");

function render(node: React.ReactNode, locale: "de" | "en" = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

function field(value: string, inherit?: { label: string }) {
  return (
    <UnitsPerDoseField
      value={value}
      onChange={() => {}}
      labelId="upd-label"
      inputId="upd-other"
      dataSlot="upd"
      inherit={inherit}
    />
  );
}

function pressed(html: string): string[] {
  return [...html.matchAll(/aria-pressed="true"[^>]*>([^<]*)</g)].map(
    (m) => m[1],
  );
}

describe("<UnitsPerDoseField>", () => {
  it("a button value selects its button and keeps the Other field closed", () => {
    const html = render(field("0.5"));
    expect(pressed(html)).toEqual(["½"]);
    expect(html).not.toContain('id="upd-other"');
    expect(html).toContain("Other…");
  });

  it("a stored mixed value opens the Other field with it and a glyph preview", () => {
    const html = render(field("1.5"));
    expect(pressed(html)).toEqual(["Other…"]);
    expect(html).toContain('id="upd-other"');
    expect(html).toContain('value="1.5"');
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain("Counts as 1½ per dose");
    expect(html).not.toContain('role="alert"');
  });

  it("reads a decimal comma and previews the value in the reader's locale", () => {
    const html = render(field("1,2"), "de");
    expect(html).toContain("Zählt als 1,2 pro Dosis");
  });

  it("text that does not read shows an alert and marks the field invalid", () => {
    const html = render(field("1,5x"));
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Enter a number above 0 and up to 100");
    expect(html).not.toContain("Counts as");
  });

  it("the per-slot variant selects Default for an empty value", () => {
    const html = render(field("", { label: "Default" }));
    expect(pressed(html)).toEqual(["Default"]);
    expect(html).not.toContain('id="upd-other"');
  });
});

describe("<InventorySection> with a mixed units-per-dose value", () => {
  it("shows the packaging line as a glyph and counts doses by 1.5", () => {
    const items = [
      {
        id: "i1",
        state: "IN_USE" as const,
        containerType: "BLISTER",
        unitsTotal: 30,
        unitsRemaining: 30,
      },
    ];
    useQueryMock.mockReturnValue({
      data: {
        items,
        summary: summariseSupply(items, 1.5),
        meta: { total: 1 },
      },
      isLoading: false,
    });
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1.5} />,
      "de",
    );
    expect(html).toContain("1 Dosis = 1½ Einheiten");
    expect(html).toContain("20 von 20 Dosen übrig");
  });
});
