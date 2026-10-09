import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DEFAULT_DASHBOARD_LAYOUT,
  serializeDashboardLayout,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  DASHBOARD_WIDGET_IDS,
  IOS_PIN_ONLY_WIDGET_IDS,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { NATIVE_ONLY_WIDGET_LABEL_KEYS } from "@/lib/dashboard/widget-modules";

// v1.11.2 HIGH-1 — the web Settings list renders one row per WRITABLE id
// (`DASHBOARD_WIDGET_IDS`) MINUS the `IOS_PIN_ONLY_WIDGET_IDS` (writable so
// the iOS pin PUT validates, but with no web render path). The default
// layout still carries all 24 writable widgets; only this subset renders.
const WEB_RENDERABLE_ROW_COUNT =
  DASHBOARD_WIDGET_IDS.length - IOS_PIN_ONLY_WIDGET_IDS.length;

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

// v1.18.0 — mutable module map so the widget-toggle gating tests can flip a
// module off without re-mocking. Defaults to `undefined` (no map → fail-open,
// every web-renderable row shown), preserving the pre-existing row counts.
const authState: {
  modules: Partial<Record<string, boolean>> | undefined;
} = { modules: undefined };

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { modules: authState.modules } }),
}));

// The hero fieldset gates its presence via `useMounted()` (v1.34, hydration
// fix). Under SSR (`renderToStaticMarkup`) `useMounted()` returns `false`,
// which would hide the fieldset from every test below regardless of
// `layout`. Force it to the hydrated (`true`) snapshot so these tests
// exercise the real post-mount content — same convention as
// layout-section.test.tsx for the identical `LayoutModuleGate` pattern.
vi.mock("@/hooks/use-mounted", () => ({
  useMounted: () => true,
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  DashboardLayoutSection,
  reorderWidgets,
  setHeroItemKindEnabled,
} from "../dashboard-layout-section";

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

beforeEach(() => {
  queryState.layout = DEFAULT_DASHBOARD_LAYOUT;
  authState.modules = undefined;
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
    // One tile + one chart switch per row: the WEB-renderable widgets in
    // the sortable list, plus the native-only rows below it (issue #581 —
    // the iOS-pin-only ids the default layout carries).
    const nativeRows = (html.match(/data-slot="native-widget-row"/g) ?? [])
      .length;
    expect(nativeRows).toBe(IOS_PIN_ONLY_WIDGET_IDS.length);
    expect(tileSwitches).toHaveLength(WEB_RENDERABLE_ROW_COUNT + nativeRows);
    expect(chartSwitches).toHaveLength(WEB_RENDERABLE_ROW_COUNT + nativeRows);
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
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
  });

  it("each drag handle has an aria-describedby pointing to a shared hint", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Split the markup into per-handle button fragments so we don't need
    // to care about attribute ordering inside the rendered <button>.
    const handleButtons =
      html.match(/<button[^>]*data-slot="widget-drag-handle"[^>]*>/g) ?? [];
    expect(handleButtons).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
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
    // Move up + Move down translation keys resolve once per widget row.
    const expected = WEB_RENDERABLE_ROW_COUNT;
    const moveUpCount = (html.match(/aria-label="Move up"/g) ?? []).length;
    const moveDownCount = (html.match(/aria-label="Move down"/g) ?? []).length;
    expect(moveUpCount).toBe(expected);
    expect(moveDownCount).toBe(expected);
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
 * v1.7.0 W1 — the stored layout round-trips the iOS-only widget ids. The
 * web tile/chart LIST still has no surface for them (no drag handle, no
 * reorder, no web render path), so the sortable list must skip them.
 *
 * issue #581 — but skipping them everywhere left the account holding rows
 * it never set and could not change from any surface, so they now appear in
 * a separate, clearly-labelled group with their visibility flags.
 */
describe("<DashboardLayoutSection> — iOS-only ids stay out of the web list (v1.7.0)", () => {
  it("keeps iOS-only ids out of the sortable web list", () => {
    // Inject a layout = the web defaults + every catalogue-only iOS id.
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

    // The sortable list is exactly the web-renderable widgets: one drag
    // handle each, and no more.
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);

    // No iOS-only raw id leaks into the markup as a row label — every one
    // of them resolves through a translation key.
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
    // No web-renderable rows → no sortable list at all, but the section
    // still renders and every id lands in the native-only group.
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(0);
    const nativeRows = html.match(/data-slot="native-widget-row"/g) ?? [];
    expect(nativeRows).toHaveLength(DASHBOARD_IOS_ONLY_WIDGET_IDS.length);
    expect(html).toContain("dashboard-layout");
  });
});

/**
 * issue #581 — BMI rendered on the native dashboard and was configurable
 * from nowhere: the widgets PUT accepts and persists it, the native client
 * writes it, and the web Settings list filtered it out because the web has
 * no render path for it. The account was left holding
 * `{"id":"bmi","visible":false,…}` — a value it never set and could not
 * change. The native-only group is where those flags become reachable.
 */
describe("<DashboardLayoutSection> — native-only widget group (issue #581)", () => {
  const NATIVE_ONLY_IDS = [
    ...IOS_PIN_ONLY_WIDGET_IDS,
    ...DASHBOARD_IOS_ONLY_WIDGET_IDS,
  ];

  it("offers a tile and a chart switch for BMI when the layout carries it", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: [
        ...DEFAULT_DASHBOARD_LAYOUT.widgets,
        {
          id: "bmi",
          visible: false,
          tileVisible: true,
          order: DEFAULT_DASHBOARD_LAYOUT.widgets.length,
        },
      ],
    };

    const html = render(<DashboardLayoutSection id="dashboard-layout" />);

    expect(html).toContain('data-widget-id="bmi"');
    expect(html).toContain('aria-label="BMI: Tile"');
    expect(html).toContain('aria-label="BMI: Chart"');
    // Reflects the stored flags rather than inventing a default.
    const row = html.match(
      /data-widget-id="bmi"[\s\S]*?(?=data-slot="native-widget-row"|$)/,
    )![0];
    expect(row).toContain('data-slot="widget-tile-switch"');
    expect(row).toContain('data-slot="widget-chart-switch"');
    // ...and it is NOT in the sortable web list (no drag handle for it).
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
  });

  it("labels the group and says which client draws these widgets", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: [
        ...DEFAULT_DASHBOARD_LAYOUT.widgets,
        { id: "bmi", visible: false, tileVisible: true, order: 99 },
      ],
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(html).toContain('data-slot="native-only-widgets"');
    expect(html).toContain("Shown in the mobile app");
    expect(html).toContain("The mobile app draws these");
  });

  it("shows nothing when the layout holds no native-only id", () => {
    // The stock web default layout carries the pin-only writable ids but
    // no catalogue-only ones; strip both so a pure web account is modelled.
    const nativeOnly = new Set<string>(NATIVE_ONLY_IDS);
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets.filter(
        (w) => !nativeOnly.has(w.id),
      ),
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(html).not.toContain('data-slot="native-only-widgets"');
    expect(html).not.toContain("Shown in the mobile app");
  });

  it("every native-only id has a label key, so no row can render raw", () => {
    for (const id of NATIVE_ONLY_IDS) {
      expect(
        NATIVE_ONLY_WIDGET_LABEL_KEYS[id],
        `${id} has no label key — its row would render its raw id`,
      ).toBeTruthy();
    }
  });

  it("hides a native-only row whose owning module is off", () => {
    authState.modules = { recovery: false };
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: [
        ...DEFAULT_DASHBOARD_LAYOUT.widgets,
        { id: "bmi", visible: false, tileVisible: true, order: 99 },
      ],
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // `cardioRecovery` belongs to the recovery module and drops out; BMI
    // belongs to none and stays.
    expect(html).not.toContain('data-widget-id="cardioRecovery"');
    expect(html).toContain('data-widget-id="bmi"');
    authState.modules = undefined;
  });
});

/**
 * v1.11.2 HIGH-1 — the 8 B5 ids are WRITABLE (in DASHBOARD_WIDGET_IDS so the
 * iOS pin PUT validates them) but have NO web render path, so the web
 * Settings list must NOT offer a dead toggle for them.
 */
describe("<DashboardLayoutSection> — iOS-pin-only ids hidden from web (v1.11.2)", () => {
  it("renders one fewer sortable row per iOS-pin-only id than the writable id count", () => {
    // Default layout carries all writable widgets incl. the pin-only ones.
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
    // Sanity: WEB_RENDERABLE_ROW_COUNT == writable − pin-only.
    expect(WEB_RENDERABLE_ROW_COUNT).toBe(
      DASHBOARD_WIDGET_IDS.length - IOS_PIN_ONLY_WIDGET_IDS.length,
    );
  });

  it("paints the pin-only labels ONLY in the native-only group", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // The pin-only ids reuse `measurements.type*` labels that resolve to
    // distinctive English strings; none should appear as a toggle aria-label.
    const pinOnlyLabels: Record<
      (typeof IOS_PIN_ONLY_WIDGET_IDS)[number],
      string
    > = {
      cardioRecovery: "Cardio recovery",
      sixMinuteWalk: "Six-minute walk distance",
      stairAscentSpeed: "Stair ascent speed",
      stairDescentSpeed: "Stair descent speed",
      breathingDisturbances: "Breathing disturbances",
      // v1.28.52 — `wristTemperature` is no longer pin-only; it now renders
      // a web row, so it left both IOS_PIN_ONLY_WIDGET_IDS and this map.
      falls: "Falls",
      walkingSteadiness: "Walking steadiness",
    };
    // The sortable web list must not offer them (issue #581 note: the
    // native-only group below it does, which is where the markup match
    // now comes from — so anchor on the sortable rows themselves).
    const sortableList = html.slice(
      0,
      html.indexOf('data-slot="native-only-widgets"'),
    );
    for (const id of IOS_PIN_ONLY_WIDGET_IDS) {
      expect(sortableList).not.toContain(`${pinOnlyLabels[id]}: `);
      // ...and each is reachable exactly once, in the native-only group.
      expect(html).toContain(`data-widget-id="${id}"`);
    }
  });
});

/**
 * v1.18.0 — a dashboard widget toggle whose owning module is disabled is a
 * dead control: the snapshot gates the tile/chart out server-side no matter
 * what the switch says. The Settings list must hide those rows. Core widgets
 * (no module entry in `WIDGET_MODULE_BY_ID`) always show; the gate fails open
 * when the module map is absent or the key is unset.
 */
describe("<DashboardLayoutSection> — disabled-module widget toggles", () => {
  // The achievements widget label drives its switch aria-label; it is the
  // canonical disabled-module probe (label resolves to "Achievements").
  const ACHIEVEMENTS_ARIA = "Achievements: ";
  // Mood is a module-owned widget too; weight is a core widget with NO module
  // entry, so it must survive any module-off state.
  const MOOD_ARIA = "Mood: ";
  const WEIGHT_ARIA = "Weight: ";

  it("hides a widget toggle whose owning module is disabled", () => {
    authState.modules = { achievements: false };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // The achievements row (and its switches) are gone…
    expect(html).not.toContain(ACHIEVEMENTS_ARIA);
    // …and exactly one fewer sortable row renders.
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT - 1);
  });

  it("keeps an enabled-module widget and core (no-module) widgets shown", () => {
    authState.modules = { achievements: false };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    // Enabled module (mood) still renders…
    expect(html).toContain(MOOD_ARIA);
    // …and a core widget with no module entry (weight) always shows.
    expect(html).toContain(WEIGHT_ARIA);
  });

  it("shows every row when the module map is absent (fail-open)", () => {
    authState.modules = undefined;
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const handles = html.match(/data-slot="widget-drag-handle"/g) ?? [];
    expect(handles).toHaveLength(WEB_RENDERABLE_ROW_COUNT);
    expect(html).toContain(ACHIEVEMENTS_ARIA);
  });
});

describe("<DashboardLayoutSection> — hero content", () => {
  it("keeps the removed score and comparison controls out of the UI", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    for (const removedLabel of [
      "Compare to",
      "Last month",
      "Last year",
      "Readiness",
      "Recovery score",
      "Sleep score",
    ]) {
      expect(html).not.toContain(removedLabel);
    }
  });

  it("renders one switch for every current priority-item kind", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(html).toContain('data-slot="hero-content-settings"');
    const switches = html.match(/data-slot="hero-item-switch"/g) ?? [];
    expect(switches).toHaveLength(PRIORITY_ITEM_KINDS.length);

    for (const kind of PRIORITY_ITEM_KINDS) {
      const control = html.match(
        new RegExp(
          `<button[^>]*data-slot="hero-item-switch"[^>]*data-kind="${kind}"[^>]*>`,
        ),
      );
      expect(control, kind).not.toBeNull();
      expect(control![0]).toContain('data-state="checked"');
    }
  });

  it("treats a missing API field as every current kind enabled", () => {
    const layoutWithoutHeroKinds: DashboardLayout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
    };
    delete layoutWithoutHeroKinds.enabledHeroItemKinds;
    queryState.layout = layoutWithoutHeroKinds;
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const switches =
      html.match(/<button[^>]*data-slot="hero-item-switch"[^>]*>/g) ?? [];
    expect(switches).toHaveLength(PRIORITY_ITEM_KINDS.length);
    for (const control of switches) {
      expect(control).toContain('data-state="checked"');
    }
  });

  it("permits an explicit all-off layout", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      enabledHeroItemKinds: [],
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const switches = html.match(
      /<button[^>]*data-slot="hero-item-switch"[^>]*>/g,
    );
    expect(switches).toHaveLength(PRIORITY_ITEM_KINDS.length);
    for (const control of switches ?? []) {
      expect(control).toContain('data-state="unchecked"');
      expect(control).not.toContain('disabled=""');
    }
    expect(html).toContain("Custom layout active");
  });

  it("switches off the last enabled kind and persists an explicit empty array", () => {
    const lastEnabled = ["coach_checkin"] as const;
    const enabledHeroItemKinds = setHeroItemKindEnabled(
      lastEnabled,
      "coach_checkin",
      false,
    );
    expect(enabledHeroItemKinds).toEqual([]);
    expect(lastEnabled).toEqual(["coach_checkin"]);

    const serialized = serializeDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      enabledHeroItemKinds,
    });
    expect(serialized.enabledHeroItemKinds).toEqual([]);
  });

  it("labels the switch collection and associates both explanatory texts", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const fieldset = html.match(
      /<fieldset[^>]*data-slot="hero-content-settings"[^>]*>/,
    );
    expect(fieldset).not.toBeNull();
    expect(fieldset![0]).toContain("rounded-lg");
    const describedBy = fieldset![0].match(/aria-describedby="([^"]+)"/);
    expect(describedBy).not.toBeNull();
    const descriptionIds = describedBy![1].split(" ");
    expect(descriptionIds).toHaveLength(2);
    for (const descriptionId of descriptionIds) {
      expect(html).toContain(`id="${descriptionId}"`);
    }
    expect(html).toContain("<legend");
    expect(html).toContain("Today highlights");
  });

  it("keeps every kind visible when unrelated modules are disabled", () => {
    authState.modules = {
      coach: false,
      medications: false,
      insights: false,
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    const switches = html.match(/data-slot="hero-item-switch"/g) ?? [];
    expect(switches).toHaveLength(PRIORITY_ITEM_KINDS.length);
  });

  it("renders localized Today-highlight labels", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />, "de");
    expect(html).toContain("Highlights für heute");
    expect(html).toContain("Medikamentendosen");
    expect(html).toContain("Neue EKG-Aufzeichnungen");
  });

  it("states that notification settings are managed separately", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(html).toContain("Notification settings are managed separately.");
  });
});

describe("<DashboardLayoutSection> — the top card switch", () => {
  function control(html: string): string {
    const match = html.match(/<button[^>]*data-slot="today-card-switch"[^>]*>/);
    expect(match).not.toBeNull();
    return match![0];
  }

  it("offers one labelled switch, on by default", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(html.match(/data-slot="today-card-switch"/g)).toHaveLength(1);
    expect(control(html)).toContain('data-state="checked"');
    const id = control(html).match(/id="([^"]+)"/)![1];
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain("Show the top card");
    expect(html).toContain("Using default layout");
  });

  it("reads a layout that predates the field as shown", () => {
    const legacy: DashboardLayout = { ...DEFAULT_DASHBOARD_LAYOUT };
    delete legacy.todayCardVisible;
    queryState.layout = legacy;
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(control(html)).toContain('data-state="checked"');
  });

  it("shows a hidden top card as off, and as a customised layout", () => {
    queryState.layout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      todayCardVisible: false,
    };
    const html = render(<DashboardLayoutSection id="dashboard-layout" />);
    expect(control(html)).toContain('data-state="unchecked"');
    expect(html).toContain("Custom layout active");
  });

  it("labels it in German", () => {
    const html = render(<DashboardLayoutSection id="dashboard-layout" />, "de");
    expect(html).toContain("Obere Karte anzeigen");
  });
});
