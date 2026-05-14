import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { SchedulingSection } from "@/components/medications/SchedulingSection";

/**
 * v1.4.25 W19e — SchedulingSection SSR smoke tests.
 *
 * Same testing convention as `SideEffectsSection.test.tsx`:
 * `renderToStaticMarkup` + seeded react-query cache. The
 * fetch-driven interactive branches (loading spinner, error state)
 * are covered by the API-route tests + the pure cadence + compliance
 * helper tests; the surface tests here pin the static-render contract:
 *
 *   1. Section heading + reminder badge render in EN and DE.
 *   2. Compliance chips display the four values (adherence, current,
 *      longest, missed) when data is seeded.
 *   3. Empty timeline yields the empty-state copy.
 *   4. Reminder badge switches text between on / off.
 */

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
}

interface SeedShape {
  windowDays: number;
  next: { windowStart: string; windowEnd: string; scheduleIndex: number } | null;
  chips: {
    adherenceRate: number | null;
    currentStreak: number;
    longestStreak: number;
    missedLast30: number;
    windowDays: number;
  };
  timeline: Array<{
    day: string;
    windowStart: string;
    windowEnd: string;
    scheduleIndex: number;
    status: "taken" | "skipped" | "missed" | "upcoming";
  }>;
}

function seed(client: QueryClient, medId: string, payload: SeedShape) {
  client.setQueryData(["medications", medId, "cadence"], payload);
}

function render(
  node: React.ReactNode,
  client: QueryClient,
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

const SEEDED: SeedShape = {
  windowDays: 30,
  next: {
    windowStart: "2026-05-15T08:00:00.000Z",
    windowEnd: "2026-05-15T09:00:00.000Z",
    scheduleIndex: 0,
  },
  chips: {
    adherenceRate: 92,
    currentStreak: 12,
    longestStreak: 21,
    missedLast30: 2,
    windowDays: 30,
  },
  timeline: [
    {
      day: "2026-05-13T00:00:00.000Z",
      windowStart: "2026-05-13T08:00:00.000Z",
      windowEnd: "2026-05-13T09:00:00.000Z",
      scheduleIndex: 0,
      status: "taken",
    },
    {
      day: "2026-05-14T00:00:00.000Z",
      windowStart: "2026-05-14T08:00:00.000Z",
      windowEnd: "2026-05-14T09:00:00.000Z",
      scheduleIndex: 0,
      status: "missed",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<SchedulingSection> — surface render", () => {
  it("renders the section heading in English", () => {
    const client = makeClient();
    seed(client, "med-1", SEEDED);
    const html = render(
      <SchedulingSection medicationId="med-1" reminderEnabled={true} />,
      client,
    );
    expect(html).toContain("Schedule");
    expect(html).toContain("Reminders on");
  });

  it("renders the section heading in German", () => {
    const client = makeClient();
    seed(client, "med-1", SEEDED);
    const html = render(
      <SchedulingSection medicationId="med-1" reminderEnabled={true} />,
      client,
      "de",
    );
    expect(html).toContain("Zeitplan");
    expect(html).toContain("Erinnerungen an");
  });

  it("switches the reminder badge when reminderEnabled is false", () => {
    const client = makeClient();
    seed(client, "med-1", SEEDED);
    const html = render(
      <SchedulingSection medicationId="med-1" reminderEnabled={false} />,
      client,
    );
    expect(html).toContain("Reminders off");
  });
});

describe("<SchedulingSection> — chips", () => {
  it("renders the four compliance chip values", () => {
    const client = makeClient();
    seed(client, "med-1", SEEDED);
    const html = render(
      <SchedulingSection medicationId="med-1" reminderEnabled={true} />,
      client,
    );
    expect(html).toContain("92%");
    expect(html).toContain("12");
    expect(html).toContain("21");
    expect(html).toContain("Current streak");
    expect(html).toContain("Longest streak");
    expect(html).toContain("Adherence");
  });

  it("renders `No data` when adherence is null", () => {
    const client = makeClient();
    seed(client, "med-1", {
      ...SEEDED,
      chips: { ...SEEDED.chips, adherenceRate: null },
    });
    const html = render(
      <SchedulingSection medicationId="med-1" reminderEnabled={true} />,
      client,
    );
    expect(html).toContain("No data");
  });
});

describe("<SchedulingSection> — timeline", () => {
  it("renders the timeline empty-state when no slots are seeded", () => {
    const client = makeClient();
    seed(client, "med-1", { ...SEEDED, timeline: [] });
    const html = render(
      <SchedulingSection medicationId="med-1" reminderEnabled={true} />,
      client,
    );
    expect(html).toContain("No doses scheduled in this window");
  });

  it("renders the legend with all four statuses", () => {
    const client = makeClient();
    seed(client, "med-1", SEEDED);
    const html = render(
      <SchedulingSection medicationId="med-1" reminderEnabled={true} />,
      client,
    );
    expect(html).toContain("Taken");
    expect(html).toContain("Skipped");
    expect(html).toContain("Missed");
    expect(html).toContain("Upcoming");
  });
});
