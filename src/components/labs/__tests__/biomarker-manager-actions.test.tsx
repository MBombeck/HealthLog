import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The biomarker catalog card offers its add action once: the empty state's
// own button while the catalog is empty, otherwise one action row at the
// foot of the card (design standards §12). It used to carry a "Define"
// button above the list AND the empty state's "Define your first biomarker".

const mocks = vi.hoisted(() => ({
  biomarkers: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { biomarkers: mocks.biomarkers },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api/api-fetch", () => ({
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: () => null,
}));
vi.mock("@/components/data-list", () => ({
  DeleteButton: (props: { title: string }) => (
    <button aria-label={props.title}>Delete</button>
  ),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { BiomarkerManager } from "../biomarker-manager";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <BiomarkerManager />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.biomarkers = [];
});

describe("<BiomarkerManager> action grammar", () => {
  it("leaves the add action to the empty state while the catalog is empty", () => {
    const html = render();
    expect(html.match(/Define your first biomarker/g)).toHaveLength(1);
    expect(html).not.toContain('data-slot="settings-card-actions"');
  });

  it("closes a populated catalog with one add action below the list", () => {
    mocks.biomarkers = [
      {
        id: "b1",
        name: "LDL",
        unit: "mg/dL",
        lowerBound: null,
        upperBound: 115,
        panel: null,
        hasContext: false,
        context: null,
        hidden: false,
        createdAt: "2026-07-28T10:00:00.000Z",
        updatedAt: "2026-07-28T10:00:00.000Z",
      },
    ];
    const html = render();
    expect(html).not.toContain("Define your first biomarker");
    const row = html.indexOf('data-slot="settings-card-actions"');
    expect(row).toBeGreaterThan(html.indexOf("LDL"));
    expect(html.slice(row).match(/>Define<\/button>/g)).toHaveLength(1);
  });
});
