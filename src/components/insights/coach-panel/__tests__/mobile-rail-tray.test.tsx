import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.4.28 R3c (BK-F-M6) — pin the carved-out mobile rail tray's
 * presentational contract. The carve-out is pure render: the parent
 * owns open/closed state + the rail content; this component just
 * paints two side-sheets with the right slots when open.
 *
 * The shadcn `<Sheet>` portals its content out of the React tree, so
 * we mock the primitives down to plain wrappers (same pattern as
 * `coach-settings-sheet.test.tsx`) to keep the slot assertions
 * reachable in static markup.
 */
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-slot="mock-sheet">{children}</div> : null,
  SheetContent: ({
    children,
    "data-slot": dataSlot,
    className,
  }: {
    children: React.ReactNode;
    "data-slot"?: string;
    className?: string;
  }) => (
    <div data-slot={dataSlot} className={className}>
      {children}
    </div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

import { MobileRailTray } from "../mobile-rail-tray";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const baseProps = {
  historyOpen: true,
  onHistoryOpenChange: () => undefined,
  historyRail: <span>history-content</span>,
  sourcesOpen: true,
  onSourcesOpenChange: () => undefined,
  sourcesRail: <span>sources-content</span>,
};

describe("<MobileRailTray>", () => {
  it("renders both trays with their data-slot identifiers when open", () => {
    const html = render(<MobileRailTray {...baseProps} />);
    expect(html).toContain('data-slot="coach-drawer-history-tray"');
    expect(html).toContain('data-slot="coach-drawer-sources-tray"');
  });

  it("forwards the rail content slots verbatim", () => {
    const html = render(<MobileRailTray {...baseProps} />);
    expect(html).toContain("history-content");
    expect(html).toContain("sources-content");
  });

  it("hides the history tray on lg+ and the sources tray on xl+", () => {
    // Matches the breakpoints documented inline: the history rail
    // mounts inline at lg+, so the tray is `lg:hidden`. The sources
    // rail mounts inline at xl+ only, so the tray is `xl:hidden`.
    const html = render(<MobileRailTray {...baseProps} />);
    expect(html).toMatch(
      /data-slot="coach-drawer-history-tray"[^>]*class="[^"]*lg:hidden/,
    );
    expect(html).toMatch(
      /data-slot="coach-drawer-sources-tray"[^>]*class="[^"]*xl:hidden/,
    );
  });

  it("renders both header titles localised", () => {
    const enHtml = render(<MobileRailTray {...baseProps} />, "en");
    expect(enHtml).toContain("Conversations");
    expect(enHtml).toContain("What I can see");

    const deHtml = render(<MobileRailTray {...baseProps} />, "de");
    expect(deHtml).toContain("Unterhaltungen");
    expect(deHtml).toContain("Worauf ich zugreife");
  });

  it("does not render either tray when its open prop is false", () => {
    // The mock's `Sheet` returns `null` when `open === false`. Pin
    // that contract so the carve-out stays gated on `historyOpen` /
    // `sourcesOpen` and never paints orphan overlays.
    const html = render(
      <MobileRailTray
        {...baseProps}
        historyOpen={false}
        sourcesOpen={false}
      />,
    );
    expect(html).not.toContain('data-slot="coach-drawer-history-tray"');
    expect(html).not.toContain('data-slot="coach-drawer-sources-tray"');
  });
});
