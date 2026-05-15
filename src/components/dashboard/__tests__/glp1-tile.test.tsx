import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.4.25 W6 — `<Glp1Tile>` rendering contract.
 *
 * Suite pins three scenarios:
 *   1. No active GLP-1 medication → the tile suppresses itself
 *      entirely (returns null, no DOM output).
 *   2. Single active GLP-1 medication (Mounjaro 7.5 mg, weekly) →
 *      drug + dose caption, last + next injection lines, weight
 *      delta caption, vertical injection markers wired to the chart.
 *   3. Dose-changed mid-period (Mounjaro 5 mg → 7.5 mg titration) →
 *      the displayed current-dose follows the latest titration row
 *      (the snapshot already does this server-side; the tile just
 *      surfaces it).
 *
 * Approach: mock the React Query hook + the auth hook so the suite
 * can render `<Glp1Tile />` to static markup and assert the visible
 * DOM. The chart itself is dynamic-imported so it's a `<div>` shell
 * in SSR — we assert the data-slot wires by reading the surrounding
 * markup rather than the rendered chart canvas.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { id: "marc", timezone: "Europe/Berlin" },
  }),
}));

let queryReturn: { data: unknown; isPending: boolean } = {
  data: null,
  isPending: false,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryReturn,
}));

// `next/dynamic` returns the lazy-loaded component reference; for
// renderToStaticMarkup the dynamic shell is a sufficient placeholder
// (we never render the chart canvas — only assert the tile wires).
vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const Mock = () => null;
    Mock.displayName = "DynamicChart";
    return Mock;
  },
}));

import { Glp1Tile } from "../glp1-tile";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <Glp1Tile />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  queryReturn = { data: null, isPending: false };
});

describe("<Glp1Tile>", () => {
  it("renders nothing when the user has no active GLP-1 medication", () => {
    queryReturn = { data: null, isPending: false };
    const html = render();
    // The route returns `data: null` for users with no active GLP-1.
    // The tile must suppress itself entirely so the dashboard layout
    // doesn't paint a hollow card.
    expect(html).toBe("");
  });

  it("renders nothing when the medications array is empty", () => {
    queryReturn = {
      data: { active: false, medications: [] },
      isPending: false,
    };
    const html = render();
    expect(html).toBe("");
  });

  it("renders a skeleton while the fetch is pending", () => {
    queryReturn = { data: undefined, isPending: true };
    const html = render();
    expect(html).toContain("glp1-tile-skeleton");
  });

  it("renders drug + dose + injection captions for a single active GLP-1", () => {
    queryReturn = {
      data: {
        active: true,
        medications: [
          {
            name: "Mounjaro",
            genericName: "tirzepatide",
            medicationId: "med-1",
            currentDose: {
              value: 7.5,
              unit: "mg",
              since: "2026-04-01",
              weeksOnDose: 6,
            },
            doseHistory: [
              {
                value: 2.5,
                unit: "mg",
                effectiveFrom: "2026-01-01",
                note: null,
              },
              {
                value: 5,
                unit: "mg",
                effectiveFrom: "2026-02-01",
                note: null,
              },
              {
                value: 7.5,
                unit: "mg",
                effectiveFrom: "2026-04-01",
                note: null,
              },
            ],
            lastInjection: {
              date: "2026-05-10",
              site: "ABDOMEN_LEFT",
              weeksAgo: 0,
            },
            nextInjection: { date: "2026-05-17", daysAway: 3 },
            startWeight: 92.0,
            currentWeight: 87.8,
            weightDeltaKg: -4.2,
            weightSeries: [
              { date: "2026-01-01", weight: 92.0 },
              { date: "2026-05-13", weight: 87.8 },
            ],
            injectionDates: ["2026-04-26", "2026-05-03", "2026-05-10"],
          },
        ],
      },
      isPending: false,
    };
    const html = render();
    expect(html).toContain('data-slot="glp1-tile"');
    expect(html).toContain('data-medication-id="med-1"');
    // Drug-and-dose caption.
    expect(html).toContain("Mounjaro 7.5mg");
    // The "−4.2 kg since start" delta caption with the loss tone.
    expect(html).toContain('data-tone="loss"');
    expect(html).toContain("−4.2 kg since start");
    // Last + next injection slots wired into the DOM.
    expect(html).toContain('data-slot="glp1-tile-last"');
    expect(html).toContain('data-slot="glp1-tile-next"');
    expect(html).toContain('data-slot="glp1-tile-chart"');
  });

  it("reflects the LATEST titration step when the dose changed mid-period", () => {
    // Mounjaro titration: 2.5 → 5 → 7.5 mg. The most recent dose-change
    // row dictates the tile's headline dose. The route's snapshot
    // already does this server-side; this test pins the tile's
    // dependence on `currentDose.value` rather than e.g. the first
    // entry in doseHistory.
    queryReturn = {
      data: {
        active: true,
        medications: [
          {
            name: "Mounjaro",
            genericName: "tirzepatide",
            medicationId: "med-1",
            currentDose: {
              value: 10,
              unit: "mg",
              since: "2026-05-01",
              weeksOnDose: 1,
            },
            doseHistory: [
              {
                value: 2.5,
                unit: "mg",
                effectiveFrom: "2026-01-01",
                note: null,
              },
              {
                value: 5,
                unit: "mg",
                effectiveFrom: "2026-02-01",
                note: null,
              },
              {
                value: 7.5,
                unit: "mg",
                effectiveFrom: "2026-03-01",
                note: null,
              },
              {
                value: 10,
                unit: "mg",
                effectiveFrom: "2026-05-01",
                note: "tolerated 10 mg step-up",
              },
            ],
            lastInjection: null,
            nextInjection: null,
            startWeight: 95.0,
            currentWeight: 88.0,
            weightDeltaKg: -7.0,
            weightSeries: [
              { date: "2026-01-01", weight: 95.0 },
              { date: "2026-05-13", weight: 88.0 },
            ],
            injectionDates: [],
          },
        ],
      },
      isPending: false,
    };
    const html = render();
    // Latest titration step (10 mg) wins — not the first entry (2.5).
    expect(html).toContain("Mounjaro 10mg");
    expect(html).not.toContain("Mounjaro 2.5mg");
    // weightDelta = -7.0 → loss tone with the "since start" suffix.
    expect(html).toContain('data-tone="loss"');
  });

  it("falls back to the medication name alone when no current dose is set", () => {
    // Some legacy meds have no titration history; the tile should
    // still render the rest of the info without crashing on the
    // missing dose row.
    queryReturn = {
      data: {
        active: true,
        medications: [
          {
            name: "Ozempic",
            genericName: "semaglutide",
            medicationId: "med-1",
            currentDose: null,
            doseHistory: [],
            lastInjection: null,
            nextInjection: null,
            startWeight: null,
            currentWeight: null,
            weightDeltaKg: null,
            weightSeries: [],
            injectionDates: [],
          },
        ],
      },
      isPending: false,
    };
    const html = render();
    expect(html).toContain("Ozempic");
    // No "mg" suffix because we have no dose value.
    expect(html).not.toContain("Ozempic 0mg");
    // No weight delta caption when both sides are null.
    expect(html).not.toContain('data-slot="glp1-tile-delta"');
    // v1.4.27 B1 — the tab strip + range strip always render; the
    // weight pane shows the muted "no data yet" hint when the series
    // is empty rather than suppressing the whole chart row.
    expect(html).toContain('data-slot="glp1-tile-chart"');
    expect(html).toContain('data-slot="glp1-tile-tab-level"');
    expect(html).toContain('data-slot="glp1-tile-tab-weight"');
  });

  it("v1.4.27 B1 — exposes the tab strip and range strip with drug-level default", () => {
    queryReturn = {
      data: {
        active: true,
        medications: [
          {
            name: "Mounjaro",
            genericName: "tirzepatide",
            medicationId: "med-1",
            currentDose: {
              value: 7.5,
              unit: "mg",
              since: "2026-04-01",
              weeksOnDose: 6,
            },
            doseHistory: [],
            lastInjection: { date: "2026-05-10", site: null, weeksAgo: 0 },
            nextInjection: { date: "2026-05-17", daysAway: 3 },
            startWeight: 92.0,
            currentWeight: 87.8,
            weightDeltaKg: -4.2,
            weightSeries: [{ date: "2026-05-13", weight: 87.8 }],
            injectionDates: ["2026-04-26", "2026-05-03", "2026-05-10"],
          },
        ],
      },
      isPending: false,
    };
    const html = render();
    // Tab strip + range strip are present on a populated tile.
    expect(html).toContain('data-slot="glp1-tile-tabs"');
    expect(html).toContain('data-slot="glp1-tile-tab-level"');
    expect(html).toContain('data-slot="glp1-tile-tab-weight"');
    expect(html).toContain('data-slot="glp1-tile-range-strip"');
    // Drug-Level tab is the default selection.
    expect(html).toMatch(
      /data-slot="glp1-tile-tab-level"[^>]*data-active="true"/,
    );
    expect(html).toMatch(
      /data-slot="glp1-tile-tab-weight"[^>]*data-active="false"/,
    );
    // Range strip exposes 7d / 30d / 90d / All buttons.
    expect(html).toMatch(/data-slot="glp1-tile-range-button"[^>]*data-points="7"/);
    expect(html).toMatch(/data-slot="glp1-tile-range-button"[^>]*data-points="30"/);
    expect(html).toMatch(/data-slot="glp1-tile-range-button"[^>]*data-points="90"/);
    expect(html).toMatch(/data-slot="glp1-tile-range-button"[^>]*data-points="0"/);
    // 30d preset is the default.
    expect(html).toMatch(
      /data-slot="glp1-tile-range-button"[^>]*data-points="30"[^>]*data-active="true"/,
    );
  });

  it("v1.4.27 B1 — promotes the schedule to a pill row and drops the green seam", () => {
    queryReturn = {
      data: {
        active: true,
        medications: [
          {
            name: "Mounjaro",
            genericName: "tirzepatide",
            medicationId: "med-1",
            currentDose: {
              value: 7.5,
              unit: "mg",
              since: "2026-04-01",
              weeksOnDose: 6,
            },
            doseHistory: [],
            lastInjection: { date: "2026-05-10", site: null, weeksAgo: 0 },
            nextInjection: { date: "2026-05-17", daysAway: 3 },
            startWeight: 92.0,
            currentWeight: 87.8,
            weightDeltaKg: -4.2,
            weightSeries: [{ date: "2026-05-13", weight: 87.8 }],
            injectionDates: ["2026-05-10"],
          },
        ],
      },
      isPending: false,
    };
    const html = render();
    // Schedule wrapper is the new pill row, not the old <dl>.
    expect(html).toContain('data-slot="glp1-tile-schedule"');
    expect(html).not.toContain("<dl");
    // Pills still carry the per-pill slot anchors the existing tests use.
    expect(html).toContain('data-slot="glp1-tile-last"');
    expect(html).toContain('data-slot="glp1-tile-next"');
    // The green left-seam classes drop from the outer wrapper.
    expect(html).not.toContain("border-l-dracula-green/60");
    expect(html).not.toContain("border-l-2");
  });

  it("v1.4.27 B1 — surfaces the level-unavailable hint when no medicationId is wired", () => {
    // Some legacy meds don't have a Medication.id surfaced through the
    // dashboard route (the route returns medicationId: null). The
    // drug-level pane needs a stable medication id to mount the
    // chart, so we render a muted hint instead of the chart.
    queryReturn = {
      data: {
        active: true,
        medications: [
          {
            name: "Ozempic",
            genericName: "semaglutide",
            medicationId: null,
            currentDose: {
              value: 0.5,
              unit: "mg",
              since: "2026-04-01",
              weeksOnDose: 6,
            },
            doseHistory: [],
            lastInjection: null,
            nextInjection: null,
            startWeight: 92.0,
            currentWeight: 87.8,
            weightDeltaKg: -4.2,
            weightSeries: [{ date: "2026-05-13", weight: 87.8 }],
            injectionDates: [],
          },
        ],
      },
      isPending: false,
    };
    const html = render();
    // Drug-level tab stays selected by default; pane renders the
    // unavailable hint because medicationId is null.
    expect(html).toContain('data-slot="glp1-tile-level-unavailable"');
  });

  it("renders German copy under the de locale", () => {
    queryReturn = {
      data: {
        active: true,
        medications: [
          {
            name: "Mounjaro",
            genericName: "tirzepatide",
            medicationId: "med-1",
            currentDose: {
              value: 7.5,
              unit: "mg",
              since: "2026-04-01",
              weeksOnDose: 6,
            },
            doseHistory: [],
            lastInjection: { date: "2026-05-10", site: null, weeksAgo: 0 },
            nextInjection: { date: "2026-05-17", daysAway: 3 },
            startWeight: 92.0,
            currentWeight: 87.8,
            weightDeltaKg: -4.2,
            weightSeries: [{ date: "2026-05-13", weight: 87.8 }],
            injectionDates: [],
          },
        ],
      },
      isPending: false,
    };
    const html = render("de");
    expect(html).toContain("GLP-1-Therapie");
    expect(html).toContain("Letzte Injektion");
    expect(html).toContain("Nächste Injektion");
    expect(html).toContain("seit Beginn");
  });
});
