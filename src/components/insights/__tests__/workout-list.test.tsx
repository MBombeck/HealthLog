import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { makeFormatters } from "@/lib/format-locale";
import { WorkoutList } from "../workout-list";
import type { WorkoutListEntry } from "@/hooks/use-workouts";

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

// The reader's date and clock preferences reach the list through
// `useFormatters()`; this reader orders dates year first, on a 24-hour clock.
const READER_FORMATTERS = makeFormatters("en", "UTC", "H24", "YMD");
vi.mock("@/lib/i18n/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n/context")>()),
  useFormatters: () => READER_FORMATTERS,
}));

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

  it("writes the start in the reader's own date order and clock", () => {
    const html = render(<WorkoutList workouts={[ROW]} />);
    expect(html).toContain(
      `${READER_FORMATTERS.dateWithWeekdaySmart(ROW.startedAt)}, ${READER_FORMATTERS.time(ROW.startedAt)}`,
    );
  });

  it("renders the distance and energy chips when present", () => {
    const html = render(<WorkoutList workouts={[ROW]} />);
    expect(html).toContain("5.20 km");
    expect(html).toContain("320 kcal");
  });

  it("states the distance in miles for an imperial reader", () => {
    account.user = { unitPreference: "imperial", glucoseUnit: null };
    try {
      const html = render(<WorkoutList workouts={[ROW]} />);
      // 5200 m = 3.23 mi.
      expect(html).toContain("3.23 mi");
      expect(html).not.toContain(" km");
    } finally {
      account.user = { unitPreference: "metric", glucoseUnit: null };
    }
  });

  it("renders aggregate average HR without claiming an HR series", () => {
    const html = render(
      <WorkoutList workouts={[{ ...ROW, hasHrSeries: false }]} />,
    );

    expect(html).toContain('data-slot="workout-list-avg-hr"');
    expect(html).toContain("145 bpm");
    expect(html).not.toContain('data-slot="workout-list-glyph-hr"');
  });

  it("omits the chip when the field is null", () => {
    const noDistance: WorkoutListEntry = {
      ...ROW,
      distanceM: null,
      activeEnergyKcal: null,
      avgHr: null,
    };
    const html = render(<WorkoutList workouts={[noDistance]} />);
    expect(html).not.toContain('data-slot="workout-list-distance"');
    expect(html).not.toContain('data-slot="workout-list-energy"');
    expect(html).not.toContain('data-slot="workout-list-avg-hr"');
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
  it("ends in one 'show n more' row and its pending/error states", () => {
    const ready = render(
      <WorkoutList
        workouts={[ROW]}
        total={30}
        pageSize={20}
        hasNextPage
        onLoadMore={() => {}}
      />,
    );
    expect(ready).toContain('data-slot="list-more"');
    expect(ready).toContain("Show 20 more");

    const pending = render(
      <WorkoutList
        workouts={[ROW]}
        hasNextPage
        isFetchingNextPage
        onLoadMore={() => {}}
      />,
    );
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain("Loading more workouts");

    const failed = render(
      <WorkoutList
        workouts={[ROW]}
        hasNextPage
        isFetchNextPageError
        onLoadMore={() => {}}
      />,
    );
    expect(failed).toContain("More workouts could not be loaded");
  });

  it("is one list: no glyphs, no chevron beside the duration", () => {
    const html = render(
      <WorkoutList workouts={[{ ...ROW, hasRoute: true }]} />,
    );
    expect(html).not.toContain("workout-list-glyph");
    expect(html).not.toContain("lucide-chevron-right");
    // The desktop columns ride the same row.
    expect(html).toContain('data-slot="list-columns"');
  });
});
