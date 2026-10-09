import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { WorkoutListEntry } from "@/hooks/use-workouts";

/**
 * v1.4.32 — `<RecentWorkoutsTile>` contract.
 *
 *   - Empty state surfaces the Apple-Health-sync onboarding cue.
 *   - Populated state renders the three most-recent rows + a "View
 *     all" link to `/insights/workouts`.
 *   - Loading state renders a brief placeholder.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

let mockResult: {
  data:
    | {
        workouts: WorkoutListEntry[];
        meta: {
          total: number;
          limit: number;
          offset: number;
          droppedDuplicates: number;
        };
      }
    | undefined;
  isLoading: boolean;
  isEmpty: boolean;
  error: Error | null;
  isError: boolean;
  refetch: () => void;
} = {
  data: undefined,
  isLoading: false,
  isEmpty: false,
  error: null,
  isError: false,
  refetch: () => {},
};

vi.mock("@/hooks/use-workouts", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-workouts")>(
    "@/hooks/use-workouts",
  );
  return {
    ...actual,
    useWorkouts: () => mockResult,
  };
});

import { RecentWorkoutsTile } from "../recent-workouts-tile";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <RecentWorkoutsTile />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResult = {
    data: undefined,
    isLoading: false,
    isEmpty: false,
    error: null,
    isError: false,
    refetch: () => {},
  };
});

describe("<RecentWorkoutsTile>", () => {
  it("renders row-shaped skeletons while the query is in flight", () => {
    mockResult.isLoading = true;
    const html = render();
    expect(html).toContain('data-slot="recent-workouts-loading"');
    expect(html).toContain('data-slot="skeleton"');
  });

  it("renders a retry card instead of the empty state on a failed fetch", () => {
    mockResult.isError = true;
    const html = render();
    expect(html).toContain('data-slot="query-error-card"');
    // A failed fetch must never read as the honest "no workouts yet"
    // empty state — that would misreport an outage as an empty account.
    expect(html).not.toContain('data-slot="recent-workouts-empty"');
  });

  it("renders the empty-state with the source-neutral onboarding cue", () => {
    mockResult.data = {
      workouts: [],
      meta: { total: 0, limit: 3, offset: 0, droppedDuplicates: 0 },
    };
    const html = render();
    expect(html).toContain('data-slot="recent-workouts-empty"');
    expect(html).toContain("No workouts yet");
    // v1.37.19 (A1-7) — the CTA no longer assumes an iPhone with Apple
    // Health; WHOOP/Polar/Oura/Withings users get the same honest cue.
    expect(html).toContain("Connect a data source in Settings");
    expect(html).not.toContain("Apple Health");
  });

  it("renders the populated list with deep-links into each detail page", () => {
    mockResult.data = {
      workouts: [
        {
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
        },
        {
          id: "w-2",
          sportType: "cycling",
          startedAt: "2026-05-14T17:00:00Z",
          endedAt: "2026-05-14T18:00:00Z",
          durationSec: 3600,
          distanceM: 24000,
          activeEnergyKcal: 600,
          avgHr: 138,
          maxHr: 162,
          source: "WITHINGS",
          externalId: "wi-1",
        },
      ],
      meta: { total: 2, limit: 3, offset: 0, droppedDuplicates: 0 },
    };
    const html = render();
    expect(html).toContain('data-slot="recent-workouts-tile"');
    expect(html).toContain('href="/insights/workouts/w-1"');
    expect(html).toContain('href="/insights/workouts/w-2"');
    expect(html).toContain('href="/insights/workouts"');
    expect(html).toContain("Running");
    expect(html).toContain("Cycling");
    expect(html).toContain("30m");
    expect(html).toContain("1h 0m");
  });
});
