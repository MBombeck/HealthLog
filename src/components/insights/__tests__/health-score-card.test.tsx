import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import {
  HealthScoreCard,
  type HealthScoreCardProps,
} from "../health-score-card";

/**
 * v1.4.20 phase B5 — Personal Health Score card.
 *
 * SSR markup pins the slot wrappers so future polish can't silently
 * drop the score number, sub-bars or disclaimer. The inline
 * Ask-the-Coach button retired in v1.4.27 B1 — the hero strip
 * carries the CTA. The negative-assertion test below pins that
 * decision so a future revival has to update the test in lock-step.
 */

const baseComponents: HealthScoreCardProps["components"] = {
  bp: { value: 80, weight: 0.3 },
  weight: { value: 70, weight: 0.2 },
  mood: { value: 90, weight: 0.2 },
  compliance: { value: 100, weight: 0.3 },
};

function ssr(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<HealthScoreCard>", () => {
  it("renders the slot wrapper + band data attribute (green)", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={null}
      />,
    );
    expect(html).toMatch(/data-slot="health-score-card"/);
    expect(html).toMatch(/data-band="green"/);
  });

  it("renders the score number, /100 suffix, and band number colour", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={null}
      />,
    );
    expect(html).toMatch(/data-slot="health-score-card-number"/);
    expect(html).toContain(">86<");
    expect(html).toContain("/ 100");
    // Green band uses the dracula-green token.
    expect(html).toContain("text-dracula-green");
  });

  it("paints the yellow band correctly", () => {
    const html = ssr(
      <HealthScoreCard
        score={62}
        band="yellow"
        components={baseComponents}
        delta={null}
      />,
    );
    expect(html).toMatch(/data-band="yellow"/);
    expect(html).toContain("text-dracula-orange");
  });

  it("paints the red band correctly", () => {
    const html = ssr(
      <HealthScoreCard
        score={32}
        band="red"
        components={baseComponents}
        delta={null}
      />,
    );
    expect(html).toMatch(/data-band="red"/);
    expect(html).toContain("text-dracula-red");
  });

  it("renders the unavailable-delta caption when delta is null", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={null}
      />,
    );
    expect(html).toContain("No history yet");
    // No delta chip in the corner.
    expect(html).not.toContain('data-slot="health-score-card-delta-chip"');
  });

  it("renders the up-arrow + delta chip when delta > 0", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={5}
      />,
    );
    expect(html).toMatch(/data-slot="health-score-card-delta-chip"/);
    expect(html).toContain("+5");
    expect(html).toContain("vs last week");
  });

  it("renders the down-arrow line when delta < 0", () => {
    const html = ssr(
      <HealthScoreCard
        score={64}
        band="yellow"
        components={baseComponents}
        delta={-7}
      />,
    );
    // Negative delta does NOT render the green chip.
    expect(html).not.toContain('data-slot="health-score-card-delta-chip"');
    expect(html).toContain("-7 vs last week");
  });

  it("renders four component rows with their values", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={null}
      />,
    );
    for (const key of ["bp", "weight", "mood", "compliance"]) {
      const re = new RegExp(`data-component="${key}"`);
      expect(html).toMatch(re);
    }
    // Hand-picked values from baseComponents.
    expect(html).toContain(">80<");
    expect(html).toContain(">70<");
    expect(html).toContain(">90<");
    expect(html).toContain(">100<");
  });

  it("renders an em-dash for null component values", () => {
    const html = ssr(
      <HealthScoreCard
        score={50}
        band="yellow"
        components={{
          ...baseComponents,
          mood: { value: null, weight: 0 },
        }}
        delta={null}
      />,
    );
    // The mood row exists but its value cell is "—".
    const moodSliceMatch = html.match(
      /data-component="mood"[\s\S]*?data-slot="health-score-card-component-value"[^>]*>([^<]+)</,
    );
    expect(moodSliceMatch).not.toBeNull();
    expect(moodSliceMatch?.[1]).toBe("—");
  });

  it("renders the disclaimer", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={null}
      />,
    );
    expect(html).toMatch(/data-slot="health-score-card-disclaimer"/);
    expect(html).toContain("Indicative");
  });

  it("v1.4.27 B1 — no longer mounts an inline Ask-the-Coach button (hero strip carries the CTA)", () => {
    // The hero strip's existing "Ask the coach" action covers this
    // surface; the card-internal duplicate button retired. The
    // onAskCoach prop stays on the type signature so callers don't
    // break, but the card no longer renders it.
    const omitted = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={null}
      />,
    );
    const supplied = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={null}
        onAskCoach={() => {}}
      />,
    );
    expect(omitted).not.toContain('data-slot="health-score-card-ask-coach"');
    expect(supplied).not.toContain('data-slot="health-score-card-ask-coach"');
  });


  it("renders German strings", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={5}
        onAskCoach={() => {}}
      />,
      "de",
    );
    expect(html).toContain("Gesundheitsscore");
    expect(html).toContain("im Vergleich zur Vorwoche");
    expect(html).toContain("Orientierungshilfe");
    // v1.4.27 B1 — the inline Coach button retired; hero strip carries
    // the action now.
    expect(html).not.toContain("Coach fragen");
  });

  it("uses tabular-nums on the headline number for stable layout", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={null}
      />,
    );
    // The headline number wrapper uses the tabular-nums utility.
    const numberMatch = html.match(
      /<span[^>]*data-slot="health-score-card-number"[^>]*>/,
    );
    expect(numberMatch).not.toBeNull();
    expect(numberMatch?.[0]).toContain("tabular-nums");
  });

  it("clamps the progress bar width between 0 and 100", () => {
    const html = ssr(
      <HealthScoreCard
        score={120}
        band="green"
        components={baseComponents}
        delta={null}
      />,
    );
    // Even a > 100 score must render at exactly 100 % width.
    const progressMatch = html.match(
      /data-slot="health-score-card-progress"[\s\S]*?width:\s*([0-9.]+%)/,
    );
    expect(progressMatch).not.toBeNull();
    expect(progressMatch?.[1]).toBe("100%");
  });

  it("exposes the progressbar role + ARIA values for screen readers", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={baseComponents}
        delta={null}
      />,
    );
    const progressMatch = html.match(
      /<div[^>]*data-slot="health-score-card-progress"[^>]*>/,
    );
    expect(progressMatch).not.toBeNull();
    expect(progressMatch?.[0]).toContain('role="progressbar"');
    expect(progressMatch?.[0]).toContain('aria-valuenow="86"');
    expect(progressMatch?.[0]).toContain('aria-valuemin="0"');
    expect(progressMatch?.[0]).toContain('aria-valuemax="100"');
  });
});
