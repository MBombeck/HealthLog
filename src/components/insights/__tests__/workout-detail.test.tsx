import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  WorkoutDetailHeader,
  WorkoutDetailStats,
  WorkoutDetailRoute,
  WorkoutDetailHrSection,
  WorkoutDetailZones,
  WorkoutDetailSplits,
  WorkoutDetailDayLinks,
} from "../workout-detail";
import { WorkoutInsightCard } from "../workout-detail/insight-slot";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";
import type { RouteCoordinate } from "@/lib/workouts/route-svg";

/**
 * #67 — `<WorkoutDetail*>` unit tests over the split `workout-detail/`
 * directory. Each primitive runs through SSR with a canonical fixture;
 * the tests pin the visible labels and the hide-don't-render contract
 * (every data-less section returns null).
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function expectSingleSectionHeading(html: string, title: string) {
  const headings = Array.from(
    html.matchAll(/<h2(?:\s[^>]*)?>(.*?)<\/h2>/g),
    (match) => match[1],
  );
  expect(headings).toEqual([title]);
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
  samples: null,
  hrSeries: null,
  zones: null,
  splits: null,
  sportContext: null,
  aiInsight: null,
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
    expectSingleSectionHeading(html, "Stats");
    expect(html).toContain("Duration");
    expect(html).toContain("Distance");
    expect(html).toContain("Active energy");
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
    expect(html).not.toContain("Average HR");
  });

  it("renders the own-history average line when ≥ 2 sessions exist", () => {
    const withCtx: WorkoutDetailPayload = {
      ...FIXTURE,
      sportContext: {
        count: 8,
        avgDurationSec: 2040,
        avgDistanceM: 5800,
        avgAvgHr: 148,
      },
    };
    const html = render(<WorkoutDetailStats workout={withCtx} />);
    expect(html).toContain('data-slot="workout-detail-sport-average"');
    expect(html).toContain("148 bpm");
  });

  it("hides the average line for a lone session", () => {
    const lone: WorkoutDetailPayload = {
      ...FIXTURE,
      sportContext: {
        count: 1,
        avgDurationSec: 1800,
        avgDistanceM: 5200,
        avgAvgHr: 145,
      },
    };
    const html = render(<WorkoutDetailStats workout={lone} />);
    expect(html).not.toContain('data-slot="workout-detail-sport-average"');
  });
});

describe("<WorkoutDetailRoute>", () => {
  it("returns null when the workout has no route", () => {
    const html = render(<WorkoutDetailRoute workout={FIXTURE} />);
    expect(html).toBe("");
  });

  it("renders an SVG path for a real route", () => {
    const coords: RouteCoordinate[] = [];
    for (let i = 0; i < 20; i++)
      coords.push([11.0 + i * 0.0004, 50.0 + i * 0.0003]);
    const withRoute: WorkoutDetailPayload = {
      ...FIXTURE,
      route: {
        geometry: { type: "LineString", coordinates: coords },
        sampleTimestamps: null,
      },
    };
    const html = render(<WorkoutDetailRoute workout={withRoute} />);
    expectSingleSectionHeading(html, "Route");
    expect(html).toContain('data-slot="workout-detail-route"');
    expect(html).toContain("<path");
    expect(html).toContain("Export GPX");
  });

  it("returns null for a degenerate point-shaped route", () => {
    const stub: WorkoutDetailPayload = {
      ...FIXTURE,
      route: {
        geometry: {
          type: "LineString",
          coordinates: [
            [11, 49],
            [11.0001, 49.0001],
          ],
        },
        sampleTimestamps: null,
      },
    };
    expect(render(<WorkoutDetailRoute workout={stub} />)).toBe("");
  });
});

describe("<WorkoutDetailHrSection>", () => {
  it("returns null without an HR series", () => {
    expect(render(<WorkoutDetailHrSection workout={FIXTURE} />)).toBe("");
  });

  it("renders the card and a provenance chip for a pulse-window series", () => {
    const withHr: WorkoutDetailPayload = {
      ...FIXTURE,
      hrSeries: {
        source: "pulse_window",
        bucketSec: 8,
        points: [
          { tSec: 0, mean: 130, min: 125, max: 135 },
          { tSec: 8, mean: 140, min: 135, max: 145 },
        ],
        envelope: false,
      },
    };
    const html = render(<WorkoutDetailHrSection workout={withHr} />);
    expectSingleSectionHeading(html, "Heart rate");
    expect(html).toContain('data-slot="workout-detail-hr"');
    expect(html).toContain('data-slot="workout-detail-hr-provenance"');
    expect(html).toContain("From your heart-rate data");
  });

  it("omits the provenance chip for a stored series", () => {
    const withHr: WorkoutDetailPayload = {
      ...FIXTURE,
      hrSeries: {
        source: "workout_series",
        bucketSec: 8,
        points: [
          { tSec: 0, mean: 130, min: 125, max: 135 },
          { tSec: 8, mean: 140, min: 135, max: 145 },
        ],
        envelope: true,
      },
    };
    const html = render(<WorkoutDetailHrSection workout={withHr} />);
    expect(html).toContain('data-slot="workout-detail-hr"');
    expect(html).not.toContain('data-slot="workout-detail-hr-provenance"');
  });
});

describe("<WorkoutDetailZones>", () => {
  it("returns null without zone data", () => {
    expect(render(<WorkoutDetailZones workout={FIXTURE} />)).toBe("");
  });

  it("renders the stacked bar and per-zone minutes", () => {
    const withZones: WorkoutDetailPayload = {
      ...FIXTURE,
      zones: {
        model: "tanaka",
        hrMax: 180,
        zones: [
          { zone: 1, lowBpm: 90, highBpm: 108, seconds: 300 },
          { zone: 2, lowBpm: 108, highBpm: 126, seconds: 600 },
          { zone: 3, lowBpm: 126, highBpm: 144, seconds: 500 },
          { zone: 4, lowBpm: 144, highBpm: 162, seconds: 200 },
          { zone: 5, lowBpm: 162, highBpm: null, seconds: 60 },
        ],
      },
    };
    const html = render(<WorkoutDetailZones workout={withZones} />);
    expectSingleSectionHeading(html, "Effort zones");
    expect(html).toContain('data-slot="workout-detail-zones"');
    expect(html).toContain("Effort zones");
    expect(html).toContain("Z3");
  });
});

describe("<WorkoutDetailSplits>", () => {
  it("returns null without splits", () => {
    expect(render(<WorkoutDetailSplits workout={FIXTURE} />)).toBe("");
  });

  it("renders a row per kilometre", () => {
    const withSplits: WorkoutDetailPayload = {
      ...FIXTURE,
      splits: [
        { km: 1, durationSec: 300, paceSecPerKm: 300 },
        { km: 2, durationSec: 288, paceSecPerKm: 288 },
      ],
    };
    const html = render(<WorkoutDetailSplits workout={withSplits} />);
    expectSingleSectionHeading(html, "Splits");
    expect(html).toContain('data-slot="workout-detail-splits"');
    expect(html).toContain("5:00");
    expect(html).toContain("4:48 /km");
  });
});

describe("<WorkoutDetailDayLinks>", () => {
  it("renders the that-day navigation links", () => {
    const html = render(<WorkoutDetailDayLinks workout={FIXTURE} />);
    expectSingleSectionHeading(html, "That day");
    expect(html).toContain('data-slot="workout-detail-day-links"');
    expect(html).toContain('href="/insights/pulse"');
    expect(html).toContain('href="/insights/sleep"');
    expect(html).toContain('href="/insights/mood"');
  });
});

/**
 * The Activity Insight card.
 *
 * Two contracts worth pinning at the render layer: the paragraph is shown
 * verbatim, and it is shown as TEXT. Model output rendered as markup is an XSS
 * surface, and this project ships no markdown library precisely so that the
 * question never arises — a test is what keeps someone from "improving" that.
 */
describe("<WorkoutInsightCard>", () => {
  it("renders the paragraph under the card's title", () => {
    const html = render(
      <WorkoutInsightCard
        insight={{
          paragraph: "A steady, aerobic-leaning ride.",
          generatedAt: "2026-05-15T07:35:00Z",
        }}
      />,
    );
    expectSingleSectionHeading(html, "Activity insight");
    expect(html).toContain("A steady, aerobic-leaning ride.");
    expect(html).toContain('data-slot="workout-detail-insight"');
  });

  it("escapes markup rather than rendering it", () => {
    const html = render(
      <WorkoutInsightCard
        insight={{
          paragraph: '<img src=x onerror="alert(1)"> **bold**',
          generatedAt: "2026-05-15T07:35:00Z",
        }}
      />,
    );
    // The tag is escaped, not emitted, and the asterisks stay literal — there
    // is no markdown renderer in the path and there must not be one.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("**bold**");
  });
});
