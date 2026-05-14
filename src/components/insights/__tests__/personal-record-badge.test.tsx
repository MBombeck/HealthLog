/**
 * v1.4.25 W16c — `<PersonalRecordBadge>` rendering.
 *
 * The badge renders a small "PR" pill when the user achieved an
 * all-time best for the metric in the last 30 days. Tests cover:
 *   1. Renders the pill when a fresh PR exists.
 *   2. Stays silent when no PR exists for the metric.
 *   3. Stays silent when the only PR is older than 30 days.
 *   4. Surfaces metric-type and PR-value via data-attrs / tooltip.
 *   5. EN + DE locale parity.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// React-Query is mocked the same way the other insights tests do it —
// we control the `data` field per-test so the SSR tree is deterministic.
type Row = {
  id: string;
  metricType: string;
  metricSlot: string | null;
  value: number;
  unit: string;
  achievedAt: string;
};
let mockRows: Row[] = [];

vi.mock("@tanstack/react-query", () => ({
  // `dataUpdatedAt` mirrors what TanStack Query produces after a
  // successful refetch — `Date.now()` is fine inside the test
  // (the React-purity rule is component-scoped).
  useQuery: () => ({
    data: mockRows,
    isLoading: false,
    dataUpdatedAt: Date.now(),
  }),
}));

import { PersonalRecordBadge } from "../personal-record-badge";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

function freshPR(over: Partial<Row> = {}): Row {
  return {
    id: "pr-1",
    metricType: "ACTIVITY_STEPS",
    metricSlot: null,
    value: 18432,
    unit: "count",
    achievedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

describe("<PersonalRecordBadge>", () => {
  it("renders the PR pill when an all-time best lands in the last 30 days", () => {
    mockRows = [freshPR()];
    const html = render(
      <PersonalRecordBadge metricType="ACTIVITY_STEPS" withTooltip={false} />,
    );
    expect(html).toMatch(/data-slot="insights-pr-badge"/);
    expect(html).toMatch(/data-metric-type="ACTIVITY_STEPS"/);
    expect(html).toContain("PR");
  });

  it("renders nothing when no PR exists for the metric", () => {
    mockRows = [];
    const html = render(
      <PersonalRecordBadge metricType="ACTIVITY_STEPS" withTooltip={false} />,
    );
    expect(html).not.toMatch(/data-slot="insights-pr-badge"/);
  });

  it("stays silent when the PR is older than 30 days", () => {
    const stale = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    mockRows = [freshPR({ achievedAt: stale })];
    const html = render(
      <PersonalRecordBadge metricType="ACTIVITY_STEPS" withTooltip={false} />,
    );
    expect(html).not.toMatch(/data-slot="insights-pr-badge"/);
  });

  it("ignores workout-slot rows on the plain-metric badge", () => {
    mockRows = [freshPR({ metricSlot: "longest_run_duration" })];
    const html = render(
      <PersonalRecordBadge metricType="ACTIVITY_STEPS" withTooltip={false} />,
    );
    expect(html).not.toMatch(/data-slot="insights-pr-badge"/);
  });

  it("uses the same 'PR' literal across EN and DE locales", () => {
    mockRows = [freshPR()];
    const en = render(
      <PersonalRecordBadge metricType="ACTIVITY_STEPS" withTooltip={false} />,
      "en",
    );
    const de = render(
      <PersonalRecordBadge metricType="ACTIVITY_STEPS" withTooltip={false} />,
      "de",
    );
    expect(en).toContain("PR");
    expect(de).toContain("PR");
  });
});
