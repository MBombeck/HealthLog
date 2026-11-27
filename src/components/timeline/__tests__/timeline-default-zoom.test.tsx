/**
 * v1.42.2 — the timeline never opens on a dead end.
 *
 *   - Opened without a zoom, when the default three months hold nothing but
 *     the record has older entries, the page shows everything (and leaves
 *     the URL alone).
 *   - A window named in the URL stays that window; when it is empty and the
 *     record has entries before it, it offers "Show everything".
 *   - An empty record keeps the plain empty state.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { TimelineResponse, TimelineZoom } from "@/lib/day/contract";
import { I18nProvider } from "@/lib/i18n/context";

import { TODAY, fullTimeline, readiness } from "./timeline-fixture";

let search = new URLSearchParams();
let dataFrom: string | null = "2019-01-01";
/** A young record: everything sits inside the default three months. */
let young = false;
const asked: TimelineZoom[] = [];

/** Everything for `all`; any other window holds nothing. */
function answer(zoom: TimelineZoom, from: string | null, to: string | null) {
  const full = fullTimeline();
  if (young) {
    return {
      ...full,
      zoom,
      range: { from: from ?? "2026-08-01", to: to ?? TODAY, dataFrom },
    };
  }
  if (zoom === "all" && dataFrom !== null) return { ...full, zoom };
  const empty: TimelineResponse = {
    ...full,
    zoom,
    range: { from: from ?? "2026-08-01", to: to ?? TODAY, dataFrom },
    lanes: full.lanes.map((lane) => ({ ...lane, items: [] })),
    standing: [],
    series: [],
  };
  return empty;
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/timeline",
  useSearchParams: () => search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", timezone: "Europe/Berlin", modules: {} },
  }),
}));
vi.mock("@/hooks/use-record-capabilities", async (importOriginal) => ({
  holdsOwnerRights: (
    await importOriginal<typeof import("@/hooks/use-record-capabilities")>()
  ).holdsOwnerRights,
  useRecordCapabilities: () => ({ inSharedRecord: false }),
}));
vi.mock("../use-timeline", () => ({
  useTimeline: (
    zoom: TimelineZoom,
    from: string | null,
    to: string | null,
    _values: readonly string[],
    enabled = true,
  ) => {
    if (!enabled) {
      return {
        data: undefined,
        isPending: true,
        isError: false,
        isPlaceholderData: false,
        refetch: vi.fn(),
      };
    }
    asked.push(zoom);
    return {
      data: answer(zoom, from, to),
      isPending: false,
      isError: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    };
  },
  useTimelineReadiness: () => ({
    data: readiness(),
    isPending: false,
    isError: false,
  }),
  useLifeEvents: () => ({ data: { events: [] } }),
  useLifeEventMutations: () => ({
    create: { isPending: false },
    update: { isPending: false },
    remove: { isPending: false },
  }),
}));
vi.mock("../timeline-dates", async (importOriginal) => {
  const real = await importOriginal<typeof import("../timeline-dates")>();
  return { ...real, todayKeyIn: () => TODAY };
});

let TimelineView: typeof import("../timeline-view").TimelineView;

beforeAll(async () => {
  ({ TimelineView } = await import("../timeline-view"));
}, 60_000);

beforeEach(() => {
  search = new URLSearchParams();
  dataFrom = "2019-01-01";
  young = false;
  asked.length = 0;
});

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <TimelineView />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("the timeline's default window", () => {
  it("opens on everything when three months hold nothing but the record is older", () => {
    const html = render();
    expect(asked).toContain("quarter");
    expect(asked).toContain("all");
    expect(html).toMatch(/data-slot="timeline-desktop"[^>]*data-zoom="all"/);
    expect(html).not.toContain('data-slot="timeline-window-empty"');
  });

  it("an unreadable zoom opens the same way as none", () => {
    search = new URLSearchParams({ zoom: "decade" });
    const html = render();
    // It asks for the default three months first, as without a zoom.
    expect(asked[0]).toBe("quarter");
    expect(html).toMatch(/data-slot="timeline-desktop"[^>]*data-zoom="all"/);
  });

  it("a window named in the URL stays, and offers everything", () => {
    search = new URLSearchParams({ zoom: "quarter" });
    const html = render();
    expect(asked).not.toContain("all");
    expect(html).toContain('data-slot="timeline-window-empty"');
    expect(html).toContain('data-slot="timeline-show-everything"');
    expect(html).not.toContain('data-slot="timeline-desktop"');
  });

  it("a young record opens on three months clamped to its first entry", () => {
    young = true;
    dataFrom = "2026-09-01";
    const html = render();
    expect(asked).not.toContain("all");
    expect(html).toMatch(
      /data-slot="timeline-desktop"[^>]*data-zoom="quarter"/,
    );
    expect(html).toMatch(/data-window-from="2026-09-01"/);
    expect(html).toMatch(/data-window-to="2026-10-31"/);
  });

  it("an older record with entries in the three months opens on them", () => {
    young = true;
    const html = render();
    expect(asked).not.toContain("all");
    expect(html).toMatch(/data-window-from="2026-08-01"/);
  });

  it("an empty record keeps the plain empty state", () => {
    dataFrom = null;
    const html = render();
    expect(asked).not.toContain("all");
    expect(html).not.toContain('data-slot="timeline-show-everything"');
    expect(html).not.toContain('data-slot="timeline-desktop"');
  });
});
