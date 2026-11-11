/**
 * The Coach's "Choose from documents" picker reads one page of the vault, the
 * newest fifty. With a longer vault it listed those and said nothing, so an
 * older report seemed not to exist unless one already knew to search for it.
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
        hasContentIndex: true,
      })),
      nextCursor: page.nextCursor,
    },
    isPending: false,
    isError: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { AttachmentPicker } from "../attachment-picker";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AttachmentPicker
        open
        onOpenChange={() => undefined}
        remainingSlots={3}
        excludeIds={[]}
        onConfirm={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("AttachmentPicker", () => {
  it("says the list is cut, and how to reach the rest", () => {
    page.nextCursor = "d49";
    const html = render();
    expect(html).toContain('data-slot="coach-attachment-picker-capped"');
    expect(html).toContain("Showing the newest 50");
  });

  it("says nothing when every document is listed", () => {
    page.nextCursor = null;
    const html = render();
    expect(html).not.toContain('data-slot="coach-attachment-picker-capped"');
    expect(
      html.match(/data-slot="coach-attachment-picker-item"/g),
    ).toHaveLength(3);
  });
});
