import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.31.0 — the derived-score sheets' outbound edge.
 *
 * The score sheets were the one assessment surface with NO way out: they
 * mounted the same `<InsightStatusCard>` every metric page uses but passed
 * neither an opener nor a scope, so the card painted no action at all and the
 * sheet read one-way.
 *
 * A composite has no snapshot block of its own, so each sheet must hand off
 * narrowed to the INPUTS that drive it — a scope of `undefined` would open the
 * default all-source snapshot and lose the context the sheet is about.
 *
 * The status card is stubbed to a probe recording its props: assert the
 * resolved hand-off, never rendered text (responsive classes have broken
 * text-based queries in this repo).
 */

const cardProps = vi.fn();
vi.mock("@/components/insights/insight-status-card", () => ({
  InsightStatusCard: (props: Record<string, unknown>) => {
    cardProps(props);
    return <div data-slot="insight-assessment-probe" />;
  },
}));

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}:${Object.values(vars).join(",")}` : key,
  }),
}));

const derived = { current: {} as Record<string, unknown> };
vi.mock("../use-derived-metric", () => ({
  useDerivedMetric: () => derived.current,
}));

vi.mock("../score-anatomy-view", () => ({
  ScoreAnatomyView: () => <div data-slot="score-anatomy-view-probe" />,
}));

// The score's course renders a live chart for the stored scores; this deck is
// about the assessment's hand-off, so the course is a probe here.
vi.mock("../score-history", () => ({
  ScoreHistoryChart: () => <div data-slot="score-history-probe" />,
  ScoreHistoryCard: () => <div data-slot="score-history-probe" />,
}));

import { CompositeScoreAnatomy } from "../composite-score-anatomy";
import type { AnatomyMetricId } from "../composite-score-anatomy";

const ALL_METRICS: AnatomyMetricId[] = [
  "SLEEP_SCORE",
  "READINESS",
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
];

function renderSheet(metric: AnatomyMetricId): Record<string, unknown> {
  derived.current = {
    isLoading: false,
    data: {
      status: "ok",
      // Each metric reads a different value shape: SLEEP_SCORE decomposes into
      // `subScores`, READINESS / RECOVERY_SCORE into `components`, and
      // STRESS / STRAIN carry the ring alone.
      value: {
        score: 72,
        band: "good",
        subScores: [{ key: "duration", value: 70, weight: 0.5 }],
        components: [
          { key: "hrv", value: 68, weight: 0.4 },
          { key: "restingHr", value: 74, weight: 0.3 },
        ],
      },
      coverage: 1,
      confidence: "high",
      provenance: {},
      assessment: {
        text: "Your recovery sat mid-range.",
        updatedAt: "2026-07-19T06:00:00.000Z",
      },
    },
  };
  cardProps.mockClear();
  renderToStaticMarkup(<CompositeScoreAnatomy metric={metric} />);
  const calls = cardProps.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("derived-score sheets — every sheet has an outbound coach edge", () => {
  it.each(ALL_METRICS)(
    "%s carries an opener, a scope and auto-send",
    (metric) => {
      const props = renderSheet(metric);
      // The affordance only paints when an opener is supplied — an absent
      // question is precisely the one-way street this closes.
      expect(props.coachQuestion).toBeTruthy();
      // A composite must narrow to its inputs, never open unscoped.
      expect(props.coachScope).toBeTruthy();
      expect((props.coachScope as { metric: string }).metric).toBeTruthy();
      // Auto-send lands the answer directly rather than only seeding.
      expect(props.coachAutoSend).toBe(true);
    },
  );

  it("names the sheet's own title in the opener", () => {
    const props = renderSheet("STRAIN_SCORE");
    expect(String(props.coachQuestion)).toContain(
      "insights.coach.assessmentPrompt",
    );
    expect(String(props.coachQuestion)).toContain(
      "insights.derived.scores.strain",
    );
  });

  it.each([
    ["SLEEP_SCORE", { metric: "sleep" }],
    [
      "READINESS",
      {
        metric: "hrv",
        also: ["resting_hr", "sleep", "respiratory_rate", "mood"],
        window: "last7days",
      },
    ],
    [
      "RECOVERY_SCORE",
      {
        metric: "hrv",
        also: ["resting_hr", "sleep", "respiratory_rate", "mood"],
        window: "last7days",
      },
    ],
    ["STRESS_SCORE", { metric: "hrv", window: "last7days" }],
    [
      "STRAIN_SCORE",
      {
        metric: "workouts",
        also: ["active_energy", "resting_hr"],
        window: "last7days",
      },
    ],
  ] satisfies ReadonlyArray<[AnatomyMetricId, Record<string, unknown>]>)(
    "%s carries exactly its engine contributor domains",
    (metric, expectedScope) => {
      expect(renderSheet(metric).coachScope).toEqual(expectedScope);
    },
  );
});
