import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { Practitioner } from "@/hooks/use-practitioners";

/**
 * The address book groups its rows by specialty. A long list reads by field
 * ("Zahnmedizin", "Hausarzt", …) instead of one undifferentiated column, the
 * unspecified rows collect into one group that sits last, and when nothing
 * carries a specialty the headings are suppressed so a lone "no specialty"
 * heading never floats over every row.
 */

const listMock = vi.fn();
vi.mock("@/hooks/use-practitioners", () => ({
  usePractitioners: () => listMock(),
  usePractitionerMutations: () => ({
    remove: { mutate: vi.fn(), isPending: false },
  }),
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canManage: true,
    canWriteDomain: () => true,
    canManageDomain: () => true,
  }),
}));

vi.mock("@/hooks/use-debounced-value", () => ({
  useDebouncedValue: (value: string) => value,
}));

vi.mock("../practitioner-sheet", () => ({
  PractitionerSheet: () => null,
}));

import { PractitionerList } from "../practitioner-list";

function row(partial: Partial<Practitioner> & { id: string }): Practitioner {
  return {
    name: partial.id,
    specialty: null,
    practice: null,
    location: null,
    phone: null,
    note: null,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...partial,
  } as Practitioner;
}

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <PractitionerList />
    </I18nProvider>,
  );
}

describe("<PractitionerList> specialty grouping", () => {
  it("renders a heading per specialty with the unspecified group last", () => {
    listMock.mockReturnValue({
      data: [
        row({ id: "a", name: "Dr. Meyer", specialty: "Zahnmedizin" }),
        row({ id: "b", name: "Dr. Braun", specialty: "Allgemeinmedizin" }),
        row({ id: "c", name: "Dr. Klein", specialty: null }),
      ],
      isPending: false,
      isError: false,
    });

    const html = render();

    // Named groups render, alphabetically sorted, plus the fallback group.
    expect(html).toContain('data-slot="practitioner-group-heading"');
    expect(html).toContain('data-specialty="Zahnmedizin"');
    expect(html).toContain('data-specialty="Allgemeinmedizin"');
    expect(html).toContain("No specialty");

    // Allgemeinmedizin precedes Zahnmedizin (alphabetical), and the
    // unspecified group sits after both.
    const allgemein = html.indexOf('data-specialty="Allgemeinmedizin"');
    const zahn = html.indexOf('data-specialty="Zahnmedizin"');
    const unspecified = html.indexOf("No specialty");
    expect(allgemein).toBeLessThan(zahn);
    expect(zahn).toBeLessThan(unspecified);
  });

  it("suppresses headings when no row carries a specialty", () => {
    listMock.mockReturnValue({
      data: [
        row({ id: "a", name: "Dr. Meyer" }),
        row({ id: "b", name: "Dr. Braun" }),
      ],
      isPending: false,
      isError: false,
    });

    const html = render();

    expect(html).not.toContain('data-slot="practitioner-group-heading"');
    expect(html).not.toContain("No specialty");
    // The rows themselves still render.
    expect(html).toContain("Dr. Meyer");
    expect(html).toContain("Dr. Braun");
  });
});
