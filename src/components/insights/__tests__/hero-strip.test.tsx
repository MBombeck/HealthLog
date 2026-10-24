import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { HeroStrip } from "../hero-strip";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";
import type {
  HealthScoreReport,
  ScorePillarId,
  ScorePillarResult,
} from "@/lib/analytics/score/types";
import { SCORE_VERSION } from "@/lib/analytics/score/types";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

// The "generated" freshness line reads the profile timezone via `useAuth`; stub
// it so the SSR render does not reach for a QueryClient the test omits.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "Europe/Berlin" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

/**
 * Insights hero strip — pins the slots so future polish can't
 * silently drop the greeting / subtitle / baseline meta. v1.18.7
 * removed the coach action row + suggested-prompt strip; the negative
 * tests below pin their absence.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const sampleBriefing: DailyBriefingPayload = {
  paragraph:
    "You're trending well this week. BP is in target band on 9 of 10 readings.",
  keyFindings: [],
};

// The greeting bucket is now computed in the user's configured zone
// (the mocked `Europe/Berlin`), not the host's — so pin explicit UTC
// instants and translate them to the intended Berlin wall-clock hour.
// May 10 2026 is CEST (UTC+2), so Berlin = UTC + 2h.
const provenance = {
  inputs: ["BLOOD_PRESSURE"],
  source: "live" as const,
  windowDays: 90,
  computedAt: "2026-07-28T12:00:00.000Z",
};

function scored(id: ScorePillarId, score: number): ScorePillarResult {
  return {
    id,
    domain: "cardiometabolic",
    result: {
      status: "ok",
      value: {
        score,
        observed: {
          value: 126,
          unit: "mmHg",
          label: "126/78 mmHg",
          asOf: "2026-07-27T08:00:00.000Z",
          sources: ["MANUAL"],
        },
        reference: {
          kind: "clinical-threshold",
          low: 120,
          high: 129,
          label: "120 to 129 mmHg",
          source: "ESH 2023",
        },
        noiseFloor: 1,
        deltaEligible: true,
        deltaIdentity: id,
      },
      coverage: {
        requiredInputs: 12,
        presentInputs: 12,
        historyDays: 28,
        missing: [],
      },
      confidence: { score: 100, band: "high" },
      provenance,
    },
  };
}

function gated(id: ScorePillarId, reason: string): ScorePillarResult {
  return {
    id,
    domain: "wellbeing",
    result: {
      status: "insufficient",
      coverage: {
        requiredInputs: 1,
        presentInputs: 0,
        historyDays: 0,
        missing: [],
      },
      provenance: { ...provenance, inputs: [id] },
      reason,
    },
  };
}

function scoreReport(pillars: ScorePillarResult[]): HealthScoreReport {
  return {
    composite: {
      status: "ok",
      value: {
        score: 74,
        band: "green",
        bandSetter: null,
        composition: ["BLOOD_PRESSURE"],
        configured: false,
        noiseFloor: 3,
        scoreVersion: SCORE_VERSION,
      },
      coverage: {
        requiredInputs: 3,
        presentInputs: 3,
        historyDays: 28,
        missing: [],
      },
      confidence: { score: 100, band: "high" },
      provenance,
    },
    pillars,
    delta: 2,
    deltaReason: null,
    scoreVersion: SCORE_VERSION,
    weightGoal: {
      status: "insufficient",
      coverage: {
        requiredInputs: 2,
        presentInputs: 0,
        historyDays: 0,
        missing: [],
      },
      provenance: { ...provenance, inputs: ["WEIGHT"] },
      reason: "no_personal_goal",
    },
    algorithmNotice: null,
  };
}

const SCORE = scoreReport([
  scored("BLOOD_PRESSURE", 82),
  scored("ACTIVITY", 61),
  gated("LIPIDS", "not_tracked"),
]);

const SCORE_WITH_FAILED_READ = scoreReport([
  scored("BLOOD_PRESSURE", 82),
  gated("LIPIDS", "read_failed"),
]);

/** v1.38 — a score resting on one area of health, basis block and all. */
function narrowScore(): HealthScoreReport {
  const report = scoreReport([scored("BLOOD_PRESSURE", 74)]);
  if (report.composite.status !== "ok") {
    throw new Error("fixture is not scored");
  }
  report.composite.value.scoreBasis = {
    domains: 1,
    recommended: 3,
    tier: "minimal",
    physiological: true,
  };
  return report;
}

const morningLocal = new Date("2026-05-10T07:00:00Z"); // 09:00 Berlin
const afternoonLocal = new Date("2026-05-10T12:00:00Z"); // 14:00 Berlin
const eveningLocal = new Date("2026-05-10T18:00:00Z"); // 20:00 Berlin
describe("<HeroStrip>", () => {
  it("renders the slot wrapper + Dracula gradient utility", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip"/);
    expect(html).toContain("hero-gradient");
    expect(html).toContain("glow-purple");
  });

  it("renders the morning greeting in English", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip-greeting"/);
    expect(html).toContain("Good morning");
  });

  it("renders the H1 at the canonical bold weight and on-scale sizes", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    const greeting = html.match(
      /data-slot="insights-hero-strip-greeting"[^>]*class="([^"]*)"/,
    );
    expect(greeting).not.toBeNull();
    // App H1 weight is bold (ui-standards.md §5) — never font-semibold.
    expect(greeting![1]).toContain("font-bold");
    expect(greeting![1]).not.toContain("font-semibold");
    // No off-scale arbitrary type sizes (§5) — round to the neighbouring step.
    expect(greeting![1]).not.toContain("text-[28px]");
    expect(greeting![1]).toContain("sm:text-3xl");
  });

  it("keeps the hero band and its columns on the spacing scale (no step-5)", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    // The band's own padding + the flex column gaps stay on 4/6, never 5.
    expect(html).not.toContain("py-5");
    expect(html).not.toContain("gap-5");
  });

  it("renders the morning greeting in German", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />, "de");
    expect(html).toContain("Guten Morgen");
  });

  it("renders the afternoon greeting in English at 14:00 local", () => {
    const html = render(<HeroStrip briefing={null} now={afternoonLocal} />);
    expect(html).toContain("Good afternoon");
  });

  it("renders the evening greeting in English at 20:00 local", () => {
    const html = render(<HeroStrip briefing={null} now={eveningLocal} />);
    expect(html).toContain("Good evening");
  });

  it("appends the user name to the greeting when supplied", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} userName="Alex" />,
    );
    expect(html).toContain("Good morning, Alex");
  });

  it("does NOT append a comma when userName is missing", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    // Greeting renders without trailing comma + name.
    expect(html).not.toMatch(/Good morning,\s*</);
  });

  it("uses the briefing paragraph as the subtitle when one is supplied", () => {
    const html = render(
      <HeroStrip briefing={sampleBriefing} now={morningLocal} />,
    );
    expect(html).toMatch(/data-slot="insights-hero-strip-subtitle"/);
    expect(html).toContain(
      "You&#x27;re trending well this week. BP is in target band on 9 of 10 readings.",
    );
  });

  it("falls back to the heroFallbackSubtitle when briefing is null", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toContain(
      "A daily read of your trends, drawn straight from the numbers you&#x27;ve logged.",
    );
  });

  it("renders the personal-baseline meta line under a real briefing", () => {
    const html = render(
      <HeroStrip briefing={sampleBriefing} now={morningLocal} />,
    );
    expect(html).toMatch(/data-slot="insights-hero-strip-baseline"/);
    expect(html).toContain("Based on your last 90 days");
  });

  /**
   * Inverted from the previous assertion, which rendered with
   * `briefing={null}` and still expected the baseline line.
   *
   * That pinned the defect. The line claims the subtitle above it was drawn
   * from the reader's own last 90 days, but with no briefing the subtitle is
   * `heroFallbackSubtitle` — fixed copy computed from nothing. Both siblings in
   * the same meta row (the freshness caption, the no-provider hint) already
   * gate on their own data; this one did not, so an account with no briefing at
   * all was told its generic sentence rested on a personal baseline.
   */
  it("withholds the personal-baseline meta line when there is no briefing", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toMatch(/data-slot="insights-hero-strip-baseline"/);
    expect(html).not.toContain("Based on your last 90 days");
    // The fallback subtitle still renders — only the provenance claim goes.
    expect(html).toContain(
      "A daily read of your trends, drawn straight from the numbers you&#x27;ve logged.",
    );
  });

  it("renders the freshness caption when updatedAt is supplied", () => {
    // v1.22 — the hero freshness line now uses `formatUpdatedLabel` for parity
    // with the briefing + per-metric cards: a same-day timestamp reads
    // "Updated today, HH:MM" rather than the old relative "Generated … ago".
    // `formatUpdatedLabel` derives "today" from the real clock, so freeze it to a
    // fixed instant and base `updatedAt` on the same instant — otherwise a run
    // that straddles local midnight reads the five-minutes-ago stamp as
    // "yesterday".
    vi.useFakeTimers();
    vi.setSystemTime(morningLocal);
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const html = render(
        <HeroStrip
          briefing={sampleBriefing}
          updatedAt={fiveMinutesAgo}
          now={morningLocal}
        />,
      );
      expect(html).toMatch(/data-slot="insights-hero-strip-generated"/);
      expect(html).toContain("Updated today");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The caption dates the subtitle. The read withholds a briefing written on
   * an earlier day while the cache stamp still reads today (a warm that kept
   * the old text re-stamps the row), so with no briefing the hero showed
   * "Updated today" under the generic fallback sentence and the card below
   * it said there was no briefing.
   */
  it("withholds the freshness caption when there is no briefing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(morningLocal);
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const html = render(
        <HeroStrip
          briefing={null}
          updatedAt={fiveMinutesAgo}
          now={morningLocal}
        />,
      );
      expect(html).not.toContain('data-slot="insights-hero-strip-generated"');
      expect(html).not.toContain("Updated today");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT render the generated caption when updatedAt is missing", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-generated"');
  });

  // ── Action row ─────────────────────────────────────────────────────
  // v1.4.28 retired the weekly-report button — Coach is now the only
  // hero-row action. The weekly-report path is gone from the codebase.
  it("does NOT render a weekly-report action button", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain(
      'data-slot="insights-hero-strip-action-weekly-report"',
    );
  });

  // v1.18.7 — the overview "Ask the coach" action button was removed from
  // the hero band. The Coach lives in the bottom-right drawer (mounted by
  // the insights layout shell), not as a hero affordance.
  it("does NOT render an ask-the-coach action button", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-action-coach"');
  });

  // v1.4.25 — the regenerate button moved from the hero action row
  // to the dedicated `<InsightsTabStrip>` component. The hero strip no
  // longer renders the rerun slot under any prop combination.
  it("does NOT render a regenerate button in the hero action row", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-action-rerun"');
  });

  // ── Suggested prompts strip ────────────────────────────────────────
  // v1.18.7 — the guided-questions chip strip ("Try asking …") was removed
  // from the hero band along with the coach action row.
  it("does NOT mount the SuggestedPrompts strip in the hero band", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-prompts"');
    expect(html).not.toContain('data-slot="insights-suggested-prompts"');
    expect(html).not.toContain("What should I tell my doctor?");
  });

  // ── Misc ───────────────────────────────────────────────────────────
  it("supports the German locale fallback subtitle", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />, "de");
    expect(html).toContain("Täglicher Blick auf deine Trends");
  });

  it("uses the now override deterministically (smoke for greeting-bucket logic)", () => {
    // Buckets are read in the mocked user's Berlin zone: 09:00 → morning,
    // 14:00 → afternoon, 20:00 → evening, 02:00 → night. 00:00 UTC is
    // 02:00 Berlin (CEST).
    const earlyMorning = new Date("2026-05-10T00:00:00Z"); // 02:00 Berlin
    const html = render(<HeroStrip briefing={null} now={earlyMorning} />);
    // Night maps to "Good evening" in EN per the resolver mapping.
    expect(html).toContain("Good evening");
    // Sanity: midnight-bucket sample is NOT "Good morning".
    expect(html).not.toContain("Good morning");
  });

  it("uses the morning bucket at noon-1 (11:59 Berlin boundary)", () => {
    const justBeforeNoon = new Date("2026-05-10T09:59:00Z"); // 11:59 Berlin
    const html = render(<HeroStrip briefing={null} now={justBeforeNoon} />);
    expect(html).toContain("Good morning");
  });

  it("resolves the greeting hour in the user's stored zone, not the browser", () => {
    // 11:30 UTC is still MORNING in UTC but 13:30 (AFTERNOON) in the mocked
    // Berlin user's zone. The afternoon greeting proves the hour comes from
    // the stored zone — the /insights hero used to read the browser clock.
    const utcMorningBerlinAfternoon = new Date("2026-05-10T11:30:00Z");
    const html = render(
      <HeroStrip briefing={null} now={utcMorningBerlinAfternoon} />,
    );
    expect(html).toContain("Good afternoon");
    expect(html).not.toContain("Good morning");
  });

  // ── B4 — Weekly-report banner card ─────────────────────────────────
  // v1.4.28 retired the weekly-report path. The banner, the report
  // route, the schema slot and the i18n keys are gone; the hero
  // strip never paints the banner under any prop combination now.
  it("does not render the weekly-report banner under any prop combination", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-weekly-banner"');
  });

  // ── The Health Score column ────────────────────────────────────────
  // The score is back in the band's right column, and this band is its only
  // mount on the overview.
  it("keeps the greeting full width when there is no score", () => {
    // An account without a score keeps the single-column band it always had;
    // the split must not appear around an empty slot.
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain("md:flex-row");
    expect(html).not.toContain("md:items-stretch");
    expect(html).not.toContain('data-slot="health-score-card"');
    expect(html).not.toContain('data-slot="health-score-card-skeleton"');
  });

  it("splits into two columns and paints the panel when a score is present", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} healthScore={SCORE} />,
    );
    expect(html).toContain("md:flex-row");
    expect(html).toContain("md:items-stretch");
    expect(html).toContain('data-slot="health-score-card"');
    // The greeting keeps its own column and can shrink inside it.
    expect(html).toContain("min-w-0 flex-1");
    expect(html).toContain('data-slot="insights-hero-strip-greeting"');
  });

  it("reserves the column while the payload is in flight", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} scorePending />,
    );
    // The split is already there, so the greeting does not re-wrap when the
    // score lands — that reflow is why the reserve exists at all.
    expect(html).toContain("md:flex-row");
    expect(html).toContain('data-slot="health-score-card-skeleton"');
    expect(html).toContain("md:basis-[22rem]");
    expect(html).not.toContain('data-slot="health-score-card"');
  });

  it("prefers the resolved panel over the reserve", () => {
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={SCORE}
        scorePending
      />,
    );
    expect(html).toContain('data-slot="health-score-card"');
    expect(html).not.toContain('data-slot="health-score-card-skeleton"');
  });

  it("renders the full panel with no briefing at all", () => {
    // The score used to live inside the daily-briefing branch, so an instance
    // with the briefing switched off lost the entire breakdown. The band
    // renders unconditionally and carries the panel whole.
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} healthScore={SCORE} />,
    );
    expect(html).toContain("A daily read of your trends"); // the no-briefing subtitle
    for (const slot of [
      "health-score-card",
      "health-score-card-label",
      "health-score-card-number",
      "health-score-card-progress",
      "health-score-band",
      "health-score-pillars",
      "health-score-not-scored-count",
      "health-score-anatomy-toggle",
      "health-score-anatomy-region",
      "health-score-not-scored",
      "health-score-weight-goal",
      "health-score-method",
    ]) {
      expect(html, slot).toContain(`data-slot="${slot}"`);
    }
    expect(html).toContain(">74<");
    expect(html).toContain('data-pillar="BLOOD_PRESSURE" data-status="ok"');
  });

  it("carries a narrow score's basis line through to the band", () => {
    // v1.38 — the panel owns the sentence; the band has to actually mount
    // the panel with the report it was handed for the sentence to arrive.
    // Two ends and the pipe: the card tests prove the line exists, this
    // proves it reaches the surface a person looks at.
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={narrowScore()}
      />,
    );
    expect(html).toContain('data-slot="health-score-basis"');
    expect(html).toContain("Based on 1 of 3 areas of health.");
    // Still the panel's face: full number, its own band colour, its bar.
    expect(html).toContain(">74<");
    expect(html).toContain('data-slot="health-score-card-progress"');
    expect(html).not.toContain('data-slot="health-score-insufficient"');
  });

  it("forwards the retry so a failed read can be retried from the band", () => {
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={SCORE_WITH_FAILED_READ}
        onScoreRetry={() => {}}
      />,
    );
    expect(html).toContain('data-slot="health-score-pillar-error"');
    expect(html).toContain('data-slot="health-score-pillar-retry"');
  });

  it("does not render any Ask-the-Coach affordance in the hero band", () => {
    // v1.4.27 — the inline HSC Ask-the-Coach button was retired.
    // v1.18.7 — the hero action-row coach button was removed too; the
    // Coach is the bottom-right drawer, not a hero affordance.
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="health-score-card-ask-coach"');
    expect(html).not.toContain('data-slot="insights-hero-strip-action-coach"');
  });
});
