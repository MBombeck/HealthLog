/**
 * The document picker reads one page of the vault, the newest fifty. With a
 * longer vault it listed those and said nothing, so an older report seemed
 * not to exist unless one already knew to search for it.
 *
 * ResponsiveSheet portals its body, which static markup does not render, so it
 * is mocked down to a wrapper that always shows its children.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const page = vi.hoisted(() => ({ nextCursor: null as string | null }));

vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="mock-sheet">{children}</div>
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      // A cut page is a full one.
      documents: Array.from({ length: page.nextCursor ? 50 : 3 }, (_, i) => ({
        id: `d${i}`,
        kind: "LAB_RESULT",
        title: `Blood panel ${i}`,
        filename: null,
        documentDate: "2026-10-01",
        createdAt: "2026-10-01T08:00:00.000Z",
      })),
      nextCursor: page.nextCursor,
    },
    isPending: false,
    isError: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { DocumentPickerSheet } from "../document-picker-sheet";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentPickerSheet
        open
        onOpenChange={() => undefined}
        title="Link documents"
        description="Pick documents"
        searchPlaceholder="Search"
        emptyLabel="No documents"
        isPicked={() => false}
        onToggle={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("DocumentPickerSheet", () => {
  it("says the list is cut, and how to reach the rest", () => {
    page.nextCursor = "d49";
    const html = render();
    expect(html).toContain('data-slot="document-picker-capped"');
    expect(html).toContain("Showing the newest 50");
  });

  it("says nothing when every document is listed", () => {
    page.nextCursor = null;
    expect(render()).not.toContain('data-slot="document-picker-capped"');
  });
});
