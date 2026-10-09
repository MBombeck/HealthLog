import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  WorkoutDetailHeader,
  WorkoutDetailStats,
  WorkoutDetailRoute,
  WorkoutDetailHrSection,
  WorkoutDetailZones,
  WorkoutDetailSplits,
  WorkoutDetailDayContext,
} from "../workout-detail";
import { WorkoutInsightCard } from "../workout-detail/insight-slot";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";
import type { RouteCoordinate } from "@/lib/workouts/route-svg";

// The unit preference comes from the account payload; a mutable stub lets a
// test switch the reader to imperial.
const account = vi.hoisted(() => ({
  user: { unitPreference: "metric", glucoseUnit: null } as Record<
    string,
    unknown
  >,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: account.user, isAuthenticated: true }),
  useAccountOnceMounted: () => account.user,
}));

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

/**
 * For the one section that reads: the day context queries sleep and mood,
 * so it needs a client in the tree. Retries off and no network in this
 * environment, so every query stays pending and the section renders its
 * loading state — which is exactly what the structural assertions want.
 */
function renderWithQueryClient(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
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
  dayKey: "2026-05-15",
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
  previousWorkoutId: null,
};

describe("<WorkoutDetailHeader>", () => {
  it("renders the sport label, source, and duration summary", () => {
    const html = render(<WorkoutDetailHeader workout={FIXTURE} />);
    expect(html).toContain("Running");
    expect(html).toContain("Apple Health");
    expect(html).toContain("30:00 min");
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

  it("links to the previous session only when the server resolved one", () => {
    expect(render(<WorkoutDetailStats workout={FIXTURE} />)).not.toContain(
      'data-slot="workout-detail-previous-link"',
    );

    const html = render(
      <WorkoutDetailStats workout={{ ...FIXTURE, previousWorkoutId: "w-0" }} />,
    );
    expect(html).toContain('href="/insights/workouts/w-0"');
    expect(html).toContain("Previous session");
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

  it("states distance, pace, elevation and the average line in imperial units", () => {
    account.user = { unitPreference: "imperial", glucoseUnit: null };
    try {
      const html = render(
        <WorkoutDetailStats
          workout={{
            ...FIXTURE,
            sportContext: {
              count: 8,
              avgDurationSec: 2040,
              avgDistanceM: 5800,
              avgAvgHr: 148,
            },
          }}
        />,
      );
      // 5200 m = 3.23 mi; 1800 s over it = 9:17 per mile; 12.5 m = 41.0 ft.
      expect(html).toContain("3.23 mi");
      expect(html).toContain("9:17 min/mi");
      expect(html).toContain("41.0 ft");
      // The sport-average line: 5800 m = 3.60 mi.
      expect(html).toContain("3.60 mi");
      expect(html).not.toContain(" km");
      expect(html).not.toContain("/km");
      const header = render(<WorkoutDetailHeader workout={FIXTURE} />);
      expect(header).toContain("3.23 mi");
    } finally {
      account.user = { unitPreference: "metric", glucoseUnit: null };
    }
  });

  it("keeps kilometres, minutes per km and metres for a metric reader", () => {
    const html = render(<WorkoutDetailStats workout={FIXTURE} />);
    expect(html).toContain("5.20 km");
    expect(html).toContain("5:46 min/km");
    expect(html).toContain("12.5 m");
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
  it("names the absence when the session has heart-rate figures but no profile", () => {
    // The stats grid is showing an average and a peak for this session,
    // so the reader can see heart rate WAS recorded. Rendering nothing
    // here would read as "this page has no heart-rate section" rather
    // than as "the shape behind those numbers is not on record".
    const html = render(<WorkoutDetailHrSection workout={FIXTURE} />);
    expect(html).toContain('data-slot="workout-detail-hr-empty"');
    expect(html).toContain("No reading-by-reading heart-rate data");
    expect(html).not.toContain('data-slot="workout-hr-chart"');
  });

  it("returns null when the session carries no heart rate at all", () => {
    // Nothing was measured, so there is no absence to report and an
    // empty card would be a shell.
    const noHr: WorkoutDetailPayload = {
      ...FIXTURE,
      avgHr: null,
      maxHr: null,
      minHr: null,
    };
    expect(render(<WorkoutDetailHrSection workout={noHr} />)).toBe("");
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
    expect(html).toContain("4:48 min/km");
  });
});

describe("<WorkoutDetailDayContext>", () => {
  it("renders the day's own signals under the that-day heading", () => {
    const html = renderWithQueryClient(
      <WorkoutDetailDayContext workout={FIXTURE} />,
    );
    expectSingleSectionHeading(html, "That day");
    expect(html).toContain('data-slot="workout-detail-day-context"');
    expect(html).toContain('data-slot="workout-detail-day-sleep"');
    expect(html).toContain('data-slot="workout-detail-day-mood"');
    // The section is dated by the heading's meta, not by the links.
    expect(html).toContain("Fri, 05/15");
  });

  it("never reads a pending query as an absent night", () => {
    // The queries are disabled here (no session), so nothing has answered.
    // "No sleep recorded" would be a claim the section cannot make.
    const html = renderWithQueryClient(
      <WorkoutDetailDayContext workout={FIXTURE} />,
    );
    expect(html).not.toContain("No sleep recorded for that night");
    expect(html).not.toContain("No mood logged that day");
    expect(html).toContain('data-slot="skeleton"');
  });

  it("labels its outbound links as the undated surfaces they lead to", () => {
    const html = renderWithQueryClient(
      <WorkoutDetailDayContext workout={FIXTURE} />,
    );
    expect(html).toContain('href="/insights/sleep"');
    expect(html).toContain("Sleep trends");
    expect(html).toContain('href="/mood"');
    expect(html).toContain("Mood history");
    // The dead "that day" chips are gone: the pulse page cannot take a
    // date, so nothing here pretends it can.
    expect(html).not.toContain('href="/insights/pulse"');
    expect(html).not.toContain('href="/insights/mood"');
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
