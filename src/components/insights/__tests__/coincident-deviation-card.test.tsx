import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DerivedMetricResponse } from "@/components/insights/derived/use-derived-metric";
import type { CoincidentDeviationValue } from "@/lib/insights/derived/coincident-deviation";

// Drive the card by stubbing the single derived-metric hook it reads.
const useDerivedMetric = vi.fn();
vi.mock("@/components/insights/derived/use-derived-metric", () => ({
  useDerivedMetric: (...a: unknown[]) => useDerivedMetric(...a),
}));
// The provenance explainer pulls a mobile flag + the i18n context; render it
// in its desktop (Popover) form for the static markup so its trigger is in the
// tree. The card test only asserts the trigger is present, not its open state.
vi.mock("@/hooks/use-is-mobile", () => ({ useIsMobile: () => false }));

import { CoincidentDeviationCard } from "../coincident-deviation-card";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

type Resp = DerivedMetricResponse<CoincidentDeviationValue>;

function deviation(
  type: string,
  outside: boolean,
): CoincidentDeviationValue["vitals"][number] {
  return {
    type: type as never,
    value: outside ? 70 : 55,
    center: 55,
    low: 48,
    high: 62,
    outside,
    direction: outside ? "above" : "in",
    daysAgo: 0,
  };
}

function ok(
  value: Omit<CoincidentDeviationValue, "illnessExplained"> &
    Partial<Pick<CoincidentDeviationValue, "illnessExplained">>,
  band: "high" | "medium" | "low" | "draft" = "high",
): Resp {
  return {
    metric: "COINCIDENT_DEVIATION",
    status: "ok",
    // v1.18.1 P4 — default the Rest Mode reframe flag off so the existing
    // fixtures stay valid; the reframe test passes `illnessExplained: true`.
    value: { illnessExplained: false, ...value },
    coverage: {
      requiredInputs: 5,
      presentInputs: 5,
      historyDays: 30,
      missing: [],
    },
    confidence: { score: 90, band },
    provenance: {
      inputs: ["RESTING_HEART_RATE", "RESPIRATORY_RATE"],
      source: "DAY",
      windowDays: 30,
      computedAt: "2026-06-03T00:00:00.000Z",
    },
    reason: null,
  };
}

function insufficient(): Resp {
  return {
    metric: "COINCIDENT_DEVIATION",
    status: "insufficient",
    value: null,
    coverage: {
      requiredInputs: 2,
      presentInputs: 1,
      historyDays: 0,
      missing: [],
    },
    confidence: null,
    provenance: {
      inputs: ["RESTING_HEART_RATE"],
      source: "live",
      windowDays: 30,
      computedAt: "2026-06-03T00:00:00.000Z",
    },
    reason: "too_few_banded_vitals",
  };
}

function mock(data: Resp | undefined) {
  useDerivedMetric.mockReturnValue({ data });
}

beforeEach(() => vi.clearAllMocks());

describe("<CoincidentDeviationCard>", () => {
  it("renders a CLS-safe skeleton while the read is in flight", () => {
    mock(undefined);
    const html = render(<CoincidentDeviationCard />);
    expect(html).toContain('data-slot="coincident-deviation-card-skeleton"');
    expect(html).not.toContain('data-slot="coincident-deviation-card"');
    // The skeleton reserves the resolved card's footprint (no downward shift).
    // The footprint shrank to `min-h-32` in v1.15.10: the in-card title row
    // moved out to the section heading above the card.
    expect(html).toContain("min-h-32");
  });

  it("the skeleton and a resolved card share the same min-height footprint", () => {
    mock(undefined);
    const skeleton = render(<CoincidentDeviationCard />);
    mock(
      ok({
        fired: true,
        day: "2026-06-03",
        vitals: [
          deviation("RESTING_HEART_RATE", true),
          deviation("RESPIRATORY_RATE", true),
        ],
        contributing: [
          deviation("RESTING_HEART_RATE", true),
          deviation("RESPIRATORY_RATE", true),
        ],
      }),
    );
    const fired = render(<CoincidentDeviationCard />);
    expect(skeleton).toContain("min-h-32");
    expect(fired).toContain("min-h-32");
  });

  it("renders nothing in the insufficient (building baselines) state", () => {
    mock(insufficient());
    const html = render(<CoincidentDeviationCard />);
    // No signal yet → the section stays absent rather than an empty husk.
    expect(html).toBe("");
  });

  it("renders nothing in the all-clear state (no signal to show)", () => {
    mock(
      ok({
        fired: false,
        day: "2026-06-03",
        vitals: [
          deviation("RESTING_HEART_RATE", false),
          deviation("WEIGHT", false),
        ],
        contributing: [],
      }),
    );
    const html = render(<CoincidentDeviationCard />);
    // Every vital inside its personal range → hide the whole card.
    expect(html).toBe("");
  });

  it("renders the watch state for a single out-of-band vital, not the fired tone", () => {
    mock(
      ok({
        fired: false,
        day: "2026-06-03",
        vitals: [
          deviation("RESTING_HEART_RATE", true),
          deviation("WEIGHT", false),
        ],
        contributing: [deviation("RESTING_HEART_RATE", true)],
      }),
    );
    const html = render(<CoincidentDeviationCard />);
    expect(html).toContain('data-state="watch"');
    expect(html).toContain("One vital is outside its usual range");
    // Watch never uses the fired/alert border or red.
    expect(html).not.toContain("border-warning");
    expect(html).not.toContain("text-destructive");
  });

  it("renders the fired state with the named vitals + the possible-factors line", () => {
    mock(
      ok({
        fired: true,
        day: "2026-06-03",
        vitals: [
          deviation("RESTING_HEART_RATE", true),
          deviation("RESPIRATORY_RATE", true),
        ],
        contributing: [
          deviation("RESTING_HEART_RATE", true),
          deviation("RESPIRATORY_RATE", true),
        ],
      }),
    );
    const html = render(<CoincidentDeviationCard />);
    expect(html).toContain('data-state="fired"');
    expect(html).toContain('data-slot="coincident-factors"');
    // The load-bearing framing line.
    expect(html).toContain("Possible factors (never a cause)");
    expect(html).toContain("not a diagnosis");
    // At most amber — never destructive/red.
    expect(html).toContain("border-warning");
    expect(html).not.toContain("text-destructive");
    // The provenance method reaches the card.
    expect(html).toContain('data-slot="provenance-explainer-method"');
    // The state change is announced politely to SR users (not assertively).
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it("reframes a fired flag as illness-explained during Rest Mode (no extra alarm)", () => {
    mock(
      ok({
        fired: true,
        day: "2026-06-03",
        illnessExplained: true,
        vitals: [
          deviation("RESTING_HEART_RATE", true),
          deviation("RESPIRATORY_RATE", true),
        ],
        contributing: [
          deviation("RESTING_HEART_RATE", true),
          deviation("RESPIRATORY_RATE", true),
        ],
      }),
    );
    const html = render(<CoincidentDeviationCard />);
    expect(html).toContain('data-state="fired"');
    // The reframe line replaces the open-ended "possible factors" copy.
    expect(html).toContain("the condition you logged");
    expect(html).not.toContain("Possible factors (never a cause)");
    // Annotate, don't escalate: no new destructive colour beyond the amber the
    // fired state already carries.
    expect(html).not.toContain("text-destructive");
  });

  it("softens a fired flag to the watch tone when history is thin", () => {
    mock(
      ok(
        {
          fired: true,
          day: "2026-06-03",
          vitals: [
            deviation("RESTING_HEART_RATE", true),
            deviation("RESPIRATORY_RATE", true),
          ],
          contributing: [
            deviation("RESTING_HEART_RATE", true),
            deviation("RESPIRATORY_RATE", true),
          ],
        },
        "low",
      ),
    );
    const html = render(<CoincidentDeviationCard />);
    // Two contributing + fired, but thin history → watch tone, not fired.
    expect(html).toContain('data-state="watch"');
    expect(html).not.toContain('data-state="fired"');
    expect(html).not.toContain("border-warning");
    // The coverage meter accompanies the softened flag.
    expect(html).toContain('data-slot="coverage-meter"');
  });
});
