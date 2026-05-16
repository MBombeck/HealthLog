import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { HeroStrip } from "../hero-strip";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";

/**
 * Insights hero strip — pins the slots so future polish can't
 * silently drop the greeting / subtitle / action row / suggested-
 * prompt strip.
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

// `getHours()` reads from the local representation. Force a known
// local hour by constructing from a local-time fields tuple.
const morningLocal = new Date(2026, 4, 10, 9, 0, 0); // May 10, 09:00 local
const afternoonLocal = new Date(2026, 4, 10, 14, 0, 0); // May 10, 14:00 local
const eveningLocal = new Date(2026, 4, 10, 20, 0, 0); // May 10, 20:00 local

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

  it("renders the personal-baseline meta line", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip-baseline"/);
    expect(html).toContain("Based on your last 90 days");
  });

  it("renders the generated-time caption when updatedAt is supplied", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const html = render(
      <HeroStrip
        briefing={null}
        updatedAt={fiveMinutesAgo}
        now={morningLocal}
      />,
    );
    expect(html).toMatch(/data-slot="insights-hero-strip-generated"/);
    expect(html).toContain("Generated");
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

  it("renders the ask-the-coach action button as disabled with a 'Coming soon' title when no handler is supplied", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    const coachTag = html.match(
      /<button[^>]*data-slot="insights-hero-strip-action-coach"[^>]*>/,
    );
    expect(coachTag).not.toBeNull();
    expect(coachTag?.[0]).toMatch(/\sdisabled(=""|\s|>)/);
    expect(coachTag?.[0]).toContain('title="Coming soon"');
  });

  it("enables the ask-the-coach button when onAskCoach is supplied (B2b)", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} onAskCoach={() => {}} />,
    );
    const coachTag = html.match(
      /<button[^>]*data-slot="insights-hero-strip-action-coach"[^>]*>/,
    );
    expect(coachTag).not.toBeNull();
    expect(coachTag?.[0]).not.toMatch(/\sdisabled(=""|\s|>)/);
    expect(coachTag?.[0]).not.toContain('title="Coming soon"');
  });

  // v1.4.25 W3 — the regenerate button moved from the hero action row
  // to the dedicated `<InsightsTabStrip>` component. The hero strip no
  // longer renders the rerun slot under any prop combination.
  it("does NOT render a regenerate button in the hero action row", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-action-rerun"');
  });

  // ── Suggested prompts strip ────────────────────────────────────────
  it("mounts the SuggestedPrompts strip below the action band", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip-prompts"/);
    expect(html).toMatch(/data-slot="insights-suggested-prompts"/);
    expect(html).toContain("Try asking");
    expect(html).toContain("Why was BP higher on Monday?");
  });

  it("forwards onPickPrompt down to the prompt strip without throwing", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} onPickPrompt={() => {}} />,
    );
    // The chips render verbatim; SSR doesn't run click handlers.
    expect(html).toMatch(/data-slot="insights-suggested-prompts-chip"/);
  });

  // ── Misc ───────────────────────────────────────────────────────────
  it("supports the German locale fallback subtitle", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />, "de");
    expect(html).toContain("Täglicher Blick auf deine Trends");
  });

  it("uses the now override deterministically (smoke for greeting-bucket logic)", () => {
    // Five different hours map to four different greeting buckets:
    // 09:00 → morning, 14:00 → afternoon, 20:00 → evening, 02:00 → night.
    const earlyMorning = new Date(2026, 4, 10, 2, 0, 0);
    const html = render(<HeroStrip briefing={null} now={earlyMorning} />);
    // Night maps to "Good evening" in EN per the resolver mapping.
    expect(html).toContain("Good evening");
    // Sanity: midnight-bucket sample is NOT "Good morning".
    expect(html).not.toContain("Good morning");
  });

  it("uses the morning bucket at noon-1 (11:59 boundary)", () => {
    const justBeforeNoon = new Date(2026, 4, 10, 11, 59, 0);
    const html = render(<HeroStrip briefing={null} now={justBeforeNoon} />);
    expect(html).toContain("Good morning");
  });

  // ── B4 — Weekly-report banner card ─────────────────────────────────
  // v1.4.28 retired the weekly-report path. The banner, the report
  // route, the schema slot and the i18n keys are gone; the hero
  // strip never paints the banner under any prop combination now.
  it("does not render the weekly-report banner under any prop combination", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-weekly-banner"');
  });

  // ── B5 — Health Score panel ────────────────────────────────────────
  it("does NOT render the Health Score panel when healthScore is omitted", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="health-score-card"');
  });

  it("renders the Health Score panel when the score is supplied", () => {
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={{
          score: 86,
          band: "green",
          components: {
            bp: { value: 80, weight: 0.3 },
            weight: { value: 70, weight: 0.2 },
            mood: { value: 90, weight: 0.2 },
            compliance: { value: 100, weight: 0.3 },
          },
          delta: 5,
        }}
      />,
    );
    expect(html).toMatch(/data-slot="health-score-card"/);
    expect(html).toMatch(/data-band="green"/);
    expect(html).toContain(">86<");
  });

  it("does not render an inline Ask-the-Coach button inside the Health Score card", () => {
    // v1.4.27 F8 — the inline HSC Ask-the-Coach button retired in
    // favour of the hero strip's existing action-row button. Even
    // when `onAskCoach` is supplied, the HSC panel must not surface
    // its own button. The action-row button at
    // `insights-hero-strip-action-coach` carries the affordance.
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={{
          score: 86,
          band: "green",
          components: {
            bp: { value: 80, weight: 0.3 },
            weight: { value: 70, weight: 0.2 },
            mood: { value: 90, weight: 0.2 },
            compliance: { value: 100, weight: 0.3 },
          },
          delta: 5,
        }}
        onAskCoach={() => {}}
      />,
    );
    expect(html).not.toContain('data-slot="health-score-card-ask-coach"');
    expect(html).toContain('data-slot="insights-hero-strip-action-coach"');
  });

  it("uses the lg row layout when healthScore is supplied (smoke test on container class)", () => {
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={{
          score: 86,
          band: "green",
          components: {
            bp: { value: 80, weight: 0.3 },
            weight: { value: 70, weight: 0.2 },
            mood: { value: 90, weight: 0.2 },
            compliance: { value: 100, weight: 0.3 },
          },
          delta: null,
        }}
      />,
    );
    // The wrapper picks up the `lg:flex-row` modifier when the score
    // is present so the panel sits beside the title block on desktop.
    expect(html).toContain("lg:flex-row");
  });

  // ── v1.4.28 R3c-Insights — equal-height contract (FB-H1/H2) ───────
  it("stretches the row's cross-axis when the HealthScore card mounts (md+/lg+)", () => {
    // Per Inv-4 the right column painted 75-110 px shorter than the
    // left column on desktop. Switching the parent flex row from
    // `items-start` to `items-stretch` gives the card a stretched
    // shell to grow into. The class is load-bearing for FB-H1/H2 —
    // if a future refactor reverts to `items-start` the height gap
    // returns.
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={{
          score: 86,
          band: "green",
          components: {
            bp: { value: 80, weight: 0.3 },
            weight: { value: 70, weight: 0.2 },
            mood: { value: 90, weight: 0.2 },
            compliance: { value: 100, weight: 0.3 },
          },
          delta: null,
        }}
      />,
    );
    expect(html).toContain("md:items-stretch");
    expect(html).toContain("lg:items-stretch");
    expect(html).not.toContain("md:items-start");
  });

  it("does NOT stretch the row when healthScore is omitted", () => {
    // Pin the negative case so a future refactor can't blanket-apply
    // the stretch contract on the no-score layout (no right column
    // means nothing to stretch toward).
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain("md:items-stretch");
  });
});
