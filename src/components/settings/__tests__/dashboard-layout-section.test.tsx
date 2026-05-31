import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DEFAULT_DASHBOARD_LAYOUT,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

// Mutable holder so individual tests can inject a layout (e.g. one that
// carries iOS-only ids) into the mocked `useQuery` without re-mocking
// the module. Defaults to the 16-tile web default layout.
const queryState: { layout: DashboardLayout } = {
  layout: DEFAULT_DASHBOARD_LAYOUT,
};

/**
 * v1.4.15 Fix 5 — independent strip-tile + chart toggles.
 *
 * The settings section grew a SECOND switch column for the upper-row
 * tile, distinct from the existing chart switch. SSR smoke tests are
 * sufficient here; full state-mutation testing would require a DOM
 * runtime which the rest of the settings suite doesn't pull in.
 *
 * v1.4.47 W4 — drag-and-drop reorder via @dnd-kit. The SSR markup picks
 * up the new drag handle, the shared describedby hint paragraph, and
 * keeps the legacy arrow buttons + switches. The reorder contract is
 * exercised via the exported `reorderWidgets` helper so we pin the
 * mutation payload shape without a DOM runtime.
 */

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: queryState.layout, isLoading: false }),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  DashboardLayoutSection,
  reorderWidgets,
} from "../dashboard-layout-section";

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

beforeEach(() => {
  queryState.layout = DEFAULT_DASHBOARD_LAYOUT;
});

describe("<DashboardLayoutSection> — tile + chart split", () => {
  it("renders both Tile and Chart column headers in English", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Column headers — the v1.4.15 split.
    expect(html).toContain("Tile");
    expect(html).toContain("Chart");
  });

  it("renders both column headers in German", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />, "de");
    expect(html).toContain("Kachel");
    expect(html).toContain("Chart");
  });

  it("paints both switch slots per widget", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // The two new data-slots distinguish tile vs chart switches in
    // visual-verify and other consumers.
    expect(html).toContain('data-slot="widget-tile-switch"');
    expect(html).toContain('data-slot="widget-chart-switch"');
  });

  it("each widget paints exactly one tile-switch and one chart-switch", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const tileSwitches = html.match(/data-slot="widget-tile-switch"/g) ?? [];
    const chartSwitches = html.match(/data-slot="widget-chart-switch"/g) ?? [];
    // Default layout has 13 widgets — both switch counts must match
    // exactly so the split control covers every widget.
    expect(tileSwitches).toHaveLength(DEFAULT_DASHBOARD_LAYOUT.widgets.length);
    expect(chartSwitches).toHaveLength(DEFAULT_DASHBOARD_LAYOUT.widgets.length);
  });
});

/**
 * v1.4.47 W4 — drag-and-drop reorder surface.
 *
 * The audit (v1.4.43 QoL M1) asked for drag-to-reorder while keeping the
 * arrow-button keyboard fallback. Tests pin (a) the visual surface
 * (drag handle + describedby hint), (b) the keyboard fallback survived,
 * (c) the reorder contract — same `widgets[]` shape with `order: 0..n-1`
 * the existing PUT already accepts.
 */
describe("<DashboardLayoutSection> — drag-and-drop reorder", () => {
  it("paints a drag handle for every widget row", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(DEFAULT_DASHBOARD_LAYOUT.widgets.length);
  });

  it("each drag handle has an aria-describedby pointing to a shared hint", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Split the markup into per-handle button fragments so we don't need
    // to care about attribute ordering inside the rendered <button>.
    const handleButtons =
      html.match(/<button[^>]*data-slot="widget-drag-handle"[^>]*>/g) ?? [];
    expect(handleButtons).toHaveLength(DEFAULT_DASHBOARD_LAYOUT.widgets.length);
    // Every handle declares aria-describedby and they all share the
    // same id (one hint paragraph below the list — single source of
    // truth for screen readers).
    const describedByIds = handleButtons.map((button) => {
      const m = button.match(/aria-describedby="([^"]+)"/);
      expect(m).not.toBeNull();
      return m![1];
    });
    const unique = new Set(describedByIds);
    expect(unique.size).toBe(1);
    const hintId = describedByIds[0];
    // The matching hint paragraph is rendered exactly once.
    expect(html).toMatch(new RegExp(`id="${hintId}"`));
  });

  it("keeps the arrow buttons present after the drag handle lands (a11y fallback)", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Move up + Move down translation keys resolve to the English
    // strings — counted once per row.
    const moveUpCount = (html.match(/aria-label="Move up"/g) ?? []).length;
    const moveDownCount = (html.match(/aria-label="Move down"/g) ?? []).length;
    expect(moveUpCount).toBe(DEFAULT_DASHBOARD_LAYOUT.widgets.length);
    expect(moveDownCount).toBe(DEFAULT_DASHBOARD_LAYOUT.widgets.length);
  });

  it("hint string localises to German", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />, "de");
    // v1.4.48 L9 — copy trimmed to ~12 words so screen readers do
    // not spend ~6 s reading the hint on focus. Anchor on the
    // shortened phrase.
    expect(html).toContain("Pfeiltasten Hoch/Runter");
  });
});

describe("reorderWidgets — pure mutation contract", () => {
  // Synthetic small list so the assertions are readable; the helper is
  // shape-only and doesn't care which ids are dashboard widgets.
  const initial = [
    { id: "a", order: 0 },
    { id: "b", order: 1 },
    { id: "c", order: 2 },
    { id: "d", order: 3 },
  ];

  it("moves an item down and rewrites order to 0..n-1", () => {
    const out = reorderWidgets(initial, "a", "c");
    expect(out.map((w) => w.id)).toEqual(["b", "c", "a", "d"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("moves an item up and rewrites order to 0..n-1", () => {
    const out = reorderWidgets(initial, "d", "a");
    expect(out.map((w) => w.id)).toEqual(["d", "a", "b", "c"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("no-op when source equals target", () => {
    const out = reorderWidgets(initial, "b", "b");
    expect(out.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("no-op when an id is missing — still normalises order", () => {
    const out = reorderWidgets(initial, "missing", "a");
    expect(out.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("preserves stable sort by `order` before reordering", () => {
    const shuffled = [
      { id: "c", order: 2 },
      { id: "a", order: 0 },
      { id: "d", order: 3 },
      { id: "b", order: 1 },
    ];
    const out = reorderWidgets(shuffled, "a", "d");
    // Sort first → [a, b, c, d]; move a → d position → [b, c, d, a].
    expect(out.map((w) => w.id)).toEqual(["b", "c", "d", "a"]);
    expect(out.map((w) => w.order)).toEqual([0, 1, 2, 3]);
  });

  it("returns a fresh array — does not mutate the input", () => {
    const snapshot = JSON.parse(JSON.stringify(initial));
    reorderWidgets(initial, "a", "c");
    expect(initial).toEqual(snapshot);
  });
});

/**
 * v1.7.0 W1 — the stored layout now round-trips the 11 iOS-only widget
 * ids. The web Settings list has no tile/chart surface for them, so the
 * render must SKIP an id with no web component rather than paint an
 * unlabelled row with dead toggles.
 */
describe("<DashboardLayoutSection> — iOS-only id skip (v1.7.0)", () => {
  it("renders only web-known rows when the layout carries iOS-only ids", () => {
    // Inject a layout = the 16 web defaults + the 11 iOS-only ids.
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: [
        ...DEFAULT_DASHBOARD_LAYOUT.widgets,
        ...DASHBOARD_IOS_ONLY_WIDGET_IDS.map((id, i) => ({
          id,
          visible: true,
          tileVisible: true,
          order: DEFAULT_DASHBOARD_LAYOUT.widgets.length + i,
        })),
      ],
    };

    const html = render(<DashboardLayoutSection id="dashboard-layout" />);

    // One row (= one tile switch) per WEB-known widget — the iOS-only
    // ids are skipped, not rendered as raw-id rows.
    const tileSwitches = html.match(/data-slot="widget-tile-switch"/g) ?? [];
    expect(tileSwitches).toHaveLength(DEFAULT_DASHBOARD_LAYOUT.widgets.length);

    // No iOS-only raw id leaks into the markup as a row label.
    for (const iosId of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(html).not.toContain(`>${iosId}<`);
    }
  });

  it("does not crash when the layout is ENTIRELY iOS-only ids", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: DASHBOARD_IOS_ONLY_WIDGET_IDS.map((id, i) => ({
        id,
        visible: true,
        tileVisible: true,
        order: i,
      })),
    };

    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // No web-known rows → zero switches, but the section still renders.
    const tileSwitches = html.match(/data-slot="widget-tile-switch"/g) ?? [];
    expect(tileSwitches).toHaveLength(0);
    expect(html).toContain("dashboard-layout");
  });
});
