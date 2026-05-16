import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  WorkoutDetailHeader,
  WorkoutDetailHRChart,
  WorkoutDetailRoute,
  WorkoutDetailStats,
} from "../workout-detail";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";

/**
 * v1.4.32 — `<WorkoutDetail*>` unit tests.
 *
 * Each primitive runs through SSR with a single canonical fixture.
 * The tests pin the visible labels + the graceful-fallback shapes so
 * the page renders something useful even when the optional fields
 * (route, HR samples, energy) are absent.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const FIXTURE: WorkoutDetailPayload = {
  id: "w-1",
  sportType: "running",
  startedAt: "2026-05-15T07:00:00Z",
  endedAt: "2026-05-15T07:30:00Z",
  durationSec: 1800,
  distanceM: 5200,
  activeEnergyKcal: 320,
  avgHr: 145,
  maxHr: 170,
  minHr: 110,
  stepCount: 5800,
  elevationM: 12.5,
  pauseDurationSec: null,
  source: "APPLE_HEALTH",
  externalId: "ext-w-1",
  metadata: null,
  route: null,
  canonicalId: "w-1",
};

describe("<WorkoutDetailHeader>", () => {
  it("renders the sport label, source, and duration summary", () => {
    const html = render(<WorkoutDetailHeader workout={FIXTURE} />);
    expect(html).toContain("Running");
    expect(html).toContain("APPLE_HEALTH");
    expect(html).toContain("30m 00s");
    expect(html).toContain("5.20 km");
  });
});

describe("<WorkoutDetailStats>", () => {
  it("renders one tile per available field", () => {
    const html = render(<WorkoutDetailStats workout={FIXTURE} />);
    expect(html).toContain("Duration");
    expect(html).toContain("Distance");
    expect(html).toContain("Active energy");
    expect(html).toContain("Average HR");
    expect(html).toContain("145 bpm");
    expect(html).toContain("Steps");
    expect(html).toContain("Pace");
  });

  it("omits tiles for null fields", () => {
    const minimal: WorkoutDetailPayload = {
      ...FIXTURE,
      distanceM: null,
      activeEnergyKcal: null,
      avgHr: null,
      maxHr: null,
      minHr: null,
      stepCount: null,
      elevationM: null,
    };
    const html = render(<WorkoutDetailStats workout={minimal} />);
    expect(html).toContain("Duration");
    expect(html).not.toContain("Distance");
    expect(html).not.toContain("Active energy");
    expect(html).not.toContain("Steps");
    expect(html).not.toContain("Average HR");
  });
});

describe("<WorkoutDetailRoute>", () => {
  it("renders the empty-state when the workout has no route", () => {
    const html = render(<WorkoutDetailRoute workout={FIXTURE} />);
    expect(html).toContain('data-slot="workout-detail-route-empty"');
    expect(html).toContain("No GPS route");
  });

  it("renders an SVG polyline when GeoJSON LineString geometry is present", () => {
    const withRoute: WorkoutDetailPayload = {
      ...FIXTURE,
      route: {
        geometry: {
          type: "LineString",
          coordinates: [
            [11.0, 49.0],
            [11.01, 49.005],
            [11.02, 49.01],
          ],
        },
        sampleTimestamps: null,
      },
    };
    const html = render(<WorkoutDetailRoute workout={withRoute} />);
    expect(html).toContain('data-slot="workout-detail-route"');
    expect(html).toContain("<polyline");
  });

  it("falls back to the empty state for a LineString with fewer than 2 points", () => {
    const stub: WorkoutDetailPayload = {
      ...FIXTURE,
      route: {
        geometry: { type: "LineString", coordinates: [[11, 49]] },
        sampleTimestamps: null,
      },
    };
    const html = render(<WorkoutDetailRoute workout={stub} />);
    expect(html).toContain('data-slot="workout-detail-route-empty"');
  });
});

describe("<WorkoutDetailHRChart>", () => {
  it("renders the unavailable notice with aggregate HR values when present", () => {
    const html = render(<WorkoutDetailHRChart workout={FIXTURE} />);
    expect(html).toContain('data-slot="workout-detail-hr-chart"');
    expect(html).toContain("145 bpm");
    expect(html).toContain("170 bpm");
  });

  it("renders just the unavailable notice when no HR aggregates are present", () => {
    const noHr: WorkoutDetailPayload = {
      ...FIXTURE,
      avgHr: null,
      maxHr: null,
    };
    const html = render(<WorkoutDetailHRChart workout={noHr} />);
    expect(html).toContain("Per-second heart-rate");
    expect(html).not.toContain("145 bpm");
  });
});
