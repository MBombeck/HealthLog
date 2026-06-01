import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  DEFAULT_COACH_PREFS,
  type CoachPrefs,
} from "@/lib/validations/coach-prefs";

/**
 * v1.7.2 — the sources rail is now backed by the persisted Coach prefs
 * (`useCoachPrefs` read + `useSaveCoachPrefs` write), the same row the
 * settings cog edits. It renders the 10 data-source clusters as
 * persistent toggles plus the saved analysis-window picker. The legacy
 * ephemeral 5-source checkbox model is gone.
 *
 * Mock the prefs hooks so the static markup reflects a known prefs
 * shape; the `save` mutation is a captured spy.
 */
const prefsState: { data: CoachPrefs | undefined } = {
  data: DEFAULT_COACH_PREFS,
};
const saveSpy = vi.fn();

vi.mock("@/hooks/use-coach-prefs", () => ({
  useCoachPrefs: () => ({ data: prefsState.data }),
  useSaveCoachPrefs: () => ({ mutate: saveSpy, isPending: false }),
}));

import { SourcesRail } from "../sources-rail";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

beforeEach(() => {
  prefsState.data = DEFAULT_COACH_PREFS;
  saveSpy.mockClear();
});

describe("<SourcesRail>", () => {
  it("renders the rail wrapper + label", () => {
    const html = render(<SourcesRail />);
    expect(html).toContain('data-slot="coach-sources-rail"');
    expect(html).toContain("What I can see");
  });

  it("renders the rail label as a real `<h3>` heading", () => {
    const html = render(<SourcesRail />);
    expect(html).toMatch(
      /<h3[^>]*data-slot="coach-sources-rail-heading"[^>]*>[\s\S]*What I can see[\s\S]*<\/h3>/,
    );
  });

  it("lists exactly the ten persisted data clusters", () => {
    const html = render(<SourcesRail />);
    const rows = html.match(/data-slot="coach-sources-row"/g) ?? [];
    expect(rows.length).toBe(10);
    for (const cluster of [
      "cardio",
      "body",
      "activity",
      "workouts",
      "sleep",
      "mood",
      "glucose",
      "medication",
      "mobility",
      "environment",
    ]) {
      expect(html).toContain(`data-source="${cluster}"`);
    }
  });

  it("renders the localised cluster labels in English", () => {
    const html = render(<SourcesRail />);
    expect(html).toContain("Cardiovascular");
    expect(html).toContain("Body composition");
    expect(html).toContain("Medication");
  });

  it("renders the German cluster labels when locale is 'de'", () => {
    const html = render(<SourcesRail />, "de");
    // German cluster labels resolve from the same `cluster.*` namespace
    // the settings cog uses.
    expect(html).toContain('data-source="cardio"');
    expect(html).toContain('data-source="medication"');
  });

  it("renders the medical disclaimer in the footer", () => {
    const html = render(<SourcesRail />);
    expect(html).toContain('data-slot="coach-sources-disclaimer"');
    expect(html).toContain("Clinical decisions belong with your doctor");
  });

  it("renders a toggle per cluster + the window selector trigger", () => {
    const html = render(<SourcesRail />);
    const toggles = (html.match(/data-slot="coach-sources-checkbox"/g) ?? [])
      .length;
    expect(toggles).toBe(10);
    expect(html).toContain('data-slot="coach-sources-window-trigger"');
  });

  it("paints the default clusters active and the opt-in clusters inactive", () => {
    // DEFAULT_COACH_PREFS leaves `dataClusters` undefined → legacy
    // defaults (cardio, body, mood, medication) are on; the rest off.
    const html = render(<SourcesRail />);
    expect(html).toMatch(/data-source="cardio"[^>]*data-active="true"/);
    expect(html).toMatch(/data-source="body"[^>]*data-active="true"/);
    expect(html).toMatch(/data-source="mood"[^>]*data-active="true"/);
    expect(html).toMatch(/data-source="medication"[^>]*data-active="true"/);
    expect(html).toMatch(/data-source="activity"[^>]*data-active="false"/);
    expect(html).toMatch(/data-source="glucose"[^>]*data-active="false"/);
  });

  it("reflects an explicit persisted cluster set", () => {
    prefsState.data = { ...DEFAULT_COACH_PREFS, dataClusters: ["glucose"] };
    const html = render(<SourcesRail />);
    expect(html).toMatch(/data-source="glucose"[^>]*data-active="true"/);
    expect(html).toMatch(/data-source="cardio"[^>]*data-active="false"/);
  });

  it("shows the per-cluster member-count hint", () => {
    const html = render(<SourcesRail />);
    // cardio expands to 9 sources, mood to 1 — both surface a count.
    expect(html).toContain("9 metrics");
    expect(html).toContain("1 metrics");
  });
});
