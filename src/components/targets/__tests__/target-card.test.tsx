import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { TargetCard, type TargetCardData } from "../target-card";

/**
 * v1.4.25 W3e — `<TargetCard>` composition. Three load-bearing cases:
 *
 *   1. Full-data card — headline + status pill + range bar +
 *      consistency strip + Coach CTA + source link all visible.
 *   2. Insufficient-data card — strip + recency line + streak chip
 *      all suppressed; the explicit "not enough data yet" inline
 *      message renders instead.
 *   3. AI gate — Coach CTA suppressed when `aiEnabled` is false.
 */

function render(props: Parameters<typeof TargetCard>[0]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <TargetCard {...props} />
    </I18nProvider>,
  );
}

const fullDataTarget: TargetCardData = {
  type: "WEIGHT",
  label: "Weight",
  current: 78.2,
  average30: 79.1,
  trend: "down",
  unit: "kg",
  range: { min: 60, max: 80 },
  classification: { category: "Normal", color: "#50fa7b" },
  source: "WHO BMI",
  daysInRange7d: 5,
  daysLogged7d: 7,
  lastMetGoalAt: "2026-05-10",
  streakDays: 4,
  insufficientData: false,
  consistency7d: ["in", "in", "near", "in", "out", "in", "in"],
};

const sparseTarget: TargetCardData = {
  type: "PULSE",
  label: "Resting pulse",
  current: 72,
  average30: 72,
  trend: null,
  unit: "bpm",
  range: { min: 60, max: 100 },
  classification: { category: "On target", color: "#50fa7b" },
  source: "AHA",
  daysInRange7d: 0,
  daysLogged7d: 0,
  lastMetGoalAt: null,
  streakDays: 0,
  insufficientData: true,
  consistency7d: [null, null, null, null, null, null, null],
};

describe("<TargetCard>", () => {
  it("renders the full layout when the target has rich data", () => {
    const html = render({
      target: fullDataTarget,
      aiEnabled: true,
      onAskCoach: vi.fn(),
    });
    expect(html).toContain('data-slot="target-card"');
    expect(html).toContain('data-slot="target-status-pill"');
    expect(html).toContain('data-slot="target-range-bar"');
    expect(html).toContain('data-slot="consistency-strip"');
    expect(html).toContain('data-slot="target-coach-cta"');
    expect(html).toContain('data-slot="target-streak"');
    // Streak chip surfaces the count from i18n
    expect(html).toContain("4-day streak");
    // Headline number (78.2 → 78.2) + the kg unit
    expect(html).toContain("78.2");
  });

  it("hides the consistency strip + recency + streak when insufficient data", () => {
    const html = render({
      target: sparseTarget,
      aiEnabled: true,
      onAskCoach: vi.fn(),
    });
    expect(html).not.toContain('data-slot="consistency-strip"');
    expect(html).not.toContain('data-slot="target-last-met"');
    expect(html).not.toContain('data-slot="target-streak"');
    // The explicit "not enough data yet" message replaces the strip
    expect(html).toContain('data-slot="target-insufficient-data"');
  });

  it("suppresses the Coach CTA when aiEnabled is false", () => {
    const html = render({
      target: fullDataTarget,
      aiEnabled: false,
      onAskCoach: vi.fn(),
    });
    expect(html).not.toContain('data-slot="target-coach-cta"');
  });

  it("renders MOOD_STABILITY headline as a verbal label, not the σ value", () => {
    const moodStability: TargetCardData = {
      ...fullDataTarget,
      type: "MOOD_STABILITY",
      label: "Mood stability",
      current: 0.6,
      unit: "σ",
      range: { min: 0, max: 0.5 },
      classification: { category: "Stable", color: "#f1fa8c" },
    };
    const html = render({
      target: moodStability,
      aiEnabled: false,
      onAskCoach: vi.fn(),
    });
    // The big-number slot should carry the EN verbal label, not "0.6".
    expect(html).toContain('data-mood-stability="stable"');
    expect(html).toContain("stable");
    expect(html).not.toMatch(/>0\.6</);
  });
});
