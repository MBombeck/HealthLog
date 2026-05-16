import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { WorkoutList } from "../workout-list";
import type { WorkoutListEntry } from "@/hooks/use-workouts";

/**
 * v1.4.32 — `<WorkoutList>` unit tests.
 *
 * The list primitive renders one row per workout with the sport icon,
 * the date, the duration, and the optional distance + active-energy
 * chips. The test pins the visible labels + the deep-link href shape.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const ROW: WorkoutListEntry = {
  id: "w-1",
  sportType: "running",
  startedAt: "2026-05-15T07:00:00Z",
  endedAt: "2026-05-15T07:30:00Z",
  durationSec: 1800,
  distanceM: 5200,
  activeEnergyKcal: 320,
  avgHr: 145,
  maxHr: 170,
  source: "APPLE_HEALTH",
  externalId: "ext-w-1",
};

describe("<WorkoutList>", () => {
  it("renders each workout as a deep-link row", () => {
    const html = render(<WorkoutList workouts={[ROW]} />);
    expect(html).toContain('href="/insights/workouts/w-1"');
    expect(html).toContain("Running");
    expect(html).toContain("30m");
  });

  it("renders the distance and energy chips when present", () => {
    const html = render(<WorkoutList workouts={[ROW]} />);
    expect(html).toContain("5.20 km");
    expect(html).toContain("320 kcal");
  });

  it("omits the chip when the field is null", () => {
    const noDistance: WorkoutListEntry = {
      ...ROW,
      distanceM: null,
      activeEnergyKcal: null,
    };
    const html = render(<WorkoutList workouts={[noDistance]} />);
    expect(html).not.toContain('data-slot="workout-list-distance"');
    expect(html).not.toContain('data-slot="workout-list-energy"');
  });

  it("falls back to the canonical sport string for unknown sport types", () => {
    const wild: WorkoutListEntry = { ...ROW, sportType: "freediving" };
    const html = render(<WorkoutList workouts={[wild]} />);
    // No `insights.workouts.sport.freediving` key in the locale; the
    // helper falls back to the canonical string so a new HK enum
    // value never paints the raw `insights.workouts.sport.x`
    // placeholder.
    expect(html).toContain("freediving");
    expect(html).not.toContain("insights.workouts.sport.");
  });
});
