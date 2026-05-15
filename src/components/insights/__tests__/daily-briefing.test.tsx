import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { DailyBriefing } from "../daily-briefing";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";

/**
 * v1.4.20 phase B1 — full-width Daily Briefing card.
 *
 * The card sits below the hero strip on `/insights` and renders the
 * narrative paragraph + 0-5 key-finding rows produced by the AI
 * pipeline. Tests cover: paragraph rendering, finding rows + tones +
 * deltas, locale-aware title, empty state with CTA, loading skeleton,
 * meta slot.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const baseBriefing: DailyBriefingPayload = {
  paragraph:
    "You're trending well this week. Blood pressure is in target band on 9 of 10 readings, weight is down 2.5 kg over the last 30 days, and your medication compliance streak is now 21 days.",
  keyFindings: [
    {
      tone: "good",
      headline: "Blood pressure entered target",
      detail: "9 of last 10 readings under 130/85.",
      delta: "↓ 4 mmHg",
      sourceWindow: "30d",
      sourceMetric: "bp",
    },
    {
      tone: "watch",
      headline: "Monday-morning systolic spike",
      detail: "+6 mmHg vs other weekdays.",
      delta: "+6 mmHg",
      sourceWindow: "30d",
      sourceMetric: "bp",
    },
    {
      tone: "info",
      headline: "Weight down 30 d",
      detail: "Linear, sustainable rate. BMI now 26.0.",
      delta: null,
      sourceWindow: "30d",
      sourceMetric: "weight",
    },
  ],
};

describe("<DailyBriefing>", () => {
  it("renders the title in English", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).toMatch(/data-slot="daily-briefing"/);
    expect(html).toContain("Daily Briefing");
  });

  it("renders the title in German", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />, "de");
    expect(html).toContain("Tagesbriefing");
  });

  it("v1.4.27 B1 — does NOT render the leading narrative paragraph", () => {
    // The hero strip subtitle on /insights renders the same
    // `briefing.paragraph` directly above this card, so the card now
    // opens straight on the key-findings list. The paragraph slot is
    // gone from the populated branch; the empty-state branch still
    // owns its CTA copy.
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).not.toContain('data-slot="daily-briefing-paragraph"');
    expect(html).not.toContain(
      "Blood pressure is in target band on 9 of 10 readings",
    );
  });

  it("renders one row per key finding", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    const matches = html.match(/data-slot="daily-briefing-finding"/g) ?? [];
    expect(matches.length).toBe(3);
    expect(html).toContain("Blood pressure entered target");
    expect(html).toContain("Monday-morning systolic spike");
    expect(html).toContain("Weight down 30 d");
  });

  it("renders the delta string when supplied", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).toMatch(/data-slot="daily-briefing-delta"/);
    expect(html).toContain("↓ 4 mmHg");
    expect(html).toContain("+6 mmHg");
  });

  it("does NOT render a delta badge when delta is null", () => {
    const html = render(
      <DailyBriefing
        briefing={{
          ...baseBriefing,
          keyFindings: [
            {
              ...baseBriefing.keyFindings[2],
            },
          ],
        }}
      />,
    );
    // Only one finding rendered, and it has delta=null.
    const deltas = html.match(/data-slot="daily-briefing-delta"/g) ?? [];
    expect(deltas.length).toBe(0);
  });

  it("uses tone-specific colour classes per finding", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).toContain("bg-dracula-green"); // tone=good bar
    expect(html).toContain("bg-dracula-orange"); // tone=watch bar
    expect(html).toContain("bg-dracula-cyan"); // tone=info bar
  });

  it("renders the 'Generated <time>' caption when updatedAt is supplied", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const html = render(
      <DailyBriefing briefing={baseBriefing} updatedAt={fiveMinutesAgo} />,
    );
    expect(html).toMatch(/data-slot="daily-briefing-updated"/);
    expect(html).toContain("Generated");
  });

  it("does NOT render the updated caption when updatedAt is missing", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).not.toContain('data-slot="daily-briefing-updated"');
  });

  it("renders the keyFindings title separator", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).toMatch(/data-slot="daily-briefing-findings-title"/);
    expect(html).toContain("Key findings");
  });

  it("hides the keyFindings section when the array is empty", () => {
    // v1.4.27 B1 — the leading paragraph dropped; the card now renders
    // only the header + (when present) the findings list. With both
    // gone the populated branch produces no body content, which the
    // hero strip already covers.
    const html = render(
      <DailyBriefing briefing={{ ...baseBriefing, keyFindings: [] }} />,
    );
    expect(html).not.toContain('data-slot="daily-briefing-findings-title"');
    expect(html).not.toContain('data-slot="daily-briefing-findings"');
    expect(html).not.toContain('data-slot="daily-briefing-paragraph"');
  });

  it("renders the empty state when briefing is null and not loading", () => {
    const html = render(<DailyBriefing briefing={null} />);
    expect(html).toMatch(/data-slot="daily-briefing-empty"/);
    expect(html).toContain("No briefing yet");
  });

  it("renders the empty-state CTA when onRegenerate is supplied", () => {
    const html = render(
      <DailyBriefing briefing={null} onRegenerate={() => {}} />,
    );
    expect(html).toMatch(/data-slot="daily-briefing-empty-cta"/);
    expect(html).toContain("Generate briefing");
  });

  it("hides the empty-state CTA when onRegenerate is not supplied", () => {
    const html = render(<DailyBriefing briefing={null} />);
    expect(html).not.toContain('data-slot="daily-briefing-empty-cta"');
  });

  it("disables the empty-state CTA while regenerating", () => {
    const html = render(
      <DailyBriefing briefing={null} onRegenerate={() => {}} regenerating />,
    );
    expect(html).toMatch(/data-slot="daily-briefing-empty-cta"[^>]*disabled/);
    expect(html).toContain("Regenerating");
  });

  it("renders the shimmer skeleton when loading", () => {
    const html = render(<DailyBriefing briefing={null} loading />);
    expect(html).toMatch(/data-slot="daily-briefing-skeleton"/);
    expect(html).toContain("animate-pulse");
    // Empty state must NOT render while loading.
    expect(html).not.toContain('data-slot="daily-briefing-empty"');
  });

  it("renders the meta slot when supplied", () => {
    const html = render(
      <DailyBriefing
        briefing={baseBriefing}
        metaSlot={<span data-testid="meta-token">meta-content</span>}
      />,
    );
    expect(html).toMatch(/data-slot="daily-briefing-meta-slot"/);
    expect(html).toContain("meta-content");
  });

  it("does NOT render the meta-slot wrapper when metaSlot is missing", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).not.toContain('data-slot="daily-briefing-meta-slot"');
  });
});
