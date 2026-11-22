import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import enMessages from "../../../../messages/en.json";

/**
 * The mood chart's 90-day tab draws weekly means like the measurement
 * charts: the chip says so, the plot carries the grain, and the table under
 * a mood page lists the weeks with the entries behind each.
 */
const NOW = new Date("2026-11-18T10:00:00.000Z");

const { entries } = vi.hoisted(() => {
  const out: Array<{ date: string; score: number; samples: number }> = [];
  for (let i = 0; i < 120; i++) {
    const day = new Date(Date.UTC(2026, 10, 18 - i));
    out.push({ date: day.toISOString().slice(0, 10), score: 4, samples: 1 });
  }
  return { entries: out.reverse() };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { entries, summary: null }, isLoading: false }),
  useQueryClient: () => ({
    cancelQueries: () => Promise.resolve(),
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    invalidateQueries: () => Promise.resolve(),
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, isLoading: false }),
}));

async function render(windowOverride: "last90days" | "last30days") {
  const { I18nProvider } = await import("@/lib/i18n/context");
  const { MoodChart } = await import("../mood-chart");
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en" initialMessages={enMessages}>
      <MoodChart windowOverride={windowOverride} dayLinks />
    </I18nProvider>,
  );
}

describe("<MoodChart> on the 90-day tab", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws weeks, with the chip, the grain and a weekly table", async () => {
    const html = await render("last90days");
    expect(html).toContain('data-bucket="week"');
    expect(html).toContain("Weekly avg");
    expect(html).toContain("One row per week of");
    expect(html).toContain("Entries");
    expect((html.match(/data-slot="chart-data-table-row"/g) ?? []).length).toBe(
      14,
    );
    // A week row opens no single day.
    expect(html).not.toContain('data-slot="day-link"');
  });

  it("keeps the 30-day tab daily", async () => {
    const html = await render("last30days");
    expect(html).toContain('data-bucket="day"');
    expect(html).not.toContain("Weekly avg");
    expect(html).toContain("One row per day of");
  });
});
