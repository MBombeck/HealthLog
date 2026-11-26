import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { DailyBriefing } from "../daily-briefing";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

// The updated-at footer reads the profile timezone via `useAuth`; stub it so the
// SSR render does not reach for a QueryClient the static-markup test omits.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "Europe/Berlin" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

/**
 * v1.4.20 — full-width Daily Briefing card.
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

  it("opens on the narrative paragraph, its only home on the overview", () => {
    // From 1.50 the overview leads with its score rings; the greeting band
    // that printed this paragraph above the card is gone, so the card shows
    // it, once.
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html.match(/data-slot="daily-briefing-paragraph"/g)).toHaveLength(1);
    expect(html).toContain(
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

  it("links the key-finding rows for metrics whose Insights sub-page exists", () => {
    // Regression guard for the stale METRIC_HREF map: hrv / resting_hr /
    // active_energy / flights / distance / body_temp / recovery all have
    // dedicated Insights sub-pages now, so their briefing rows must be
    // tappable `<a>` links, not inert rows.
    const html = render(
      <DailyBriefing
        briefing={{
          ...baseBriefing,
          keyFindings: [
            { ...baseBriefing.keyFindings[2], sourceMetric: "hrv" },
            { ...baseBriefing.keyFindings[2], sourceMetric: "resting_hr" },
            { ...baseBriefing.keyFindings[2], sourceMetric: "active_energy" },
            { ...baseBriefing.keyFindings[2], sourceMetric: "flights" },
            { ...baseBriefing.keyFindings[2], sourceMetric: "distance" },
            { ...baseBriefing.keyFindings[2], sourceMetric: "body_temp" },
            { ...baseBriefing.keyFindings[2], sourceMetric: "recovery" },
          ],
        }}
      />,
    );
    expect(html).toContain('href="/insights/hrv"');
    expect(html).toContain('href="/insights/resting-pulse"');
    expect(html).toContain('href="/insights/active-energy"');
    expect(html).toContain('href="/insights/flights-climbed"');
    expect(html).toContain('href="/insights/walking-distance"');
    expect(html).toContain('href="/insights/body-temperature"');
    expect(html).toContain('href="/insights/recovery"');
  });

  it("renders a glucose signal and finding as linked rows with their delta", () => {
    const html = render(
      <DailyBriefing
        briefing={{
          ...baseBriefing,
          signalsOfDay: [
            {
              sourceMetric: "glucose",
              tone: "watch",
              headline: "Glucose is up by this time of day",
              nudge: "Note what you had for breakfast.",
              delta: "+0.8 mmol/L",
            },
          ],
          keyFindings: [
            {
              ...baseBriefing.keyFindings[2],
              sourceMetric: "glucose",
              headline: "Glucose steady over the month",
            },
          ],
        }}
      />,
    );
    expect(html).toMatch(
      /data-slot="daily-briefing-signal"[^>]*data-metric="glucose"/,
    );
    expect(html).toMatch(
      /data-slot="daily-briefing-finding"[^>]*data-metric="glucose"/,
    );
    expect(html).toContain('href="/insights/blood-glucose"');
    expect(html).toContain("Glucose is up by this time of day");
    expect(html).toContain("+0.8 mmol/L");
  });

  it("renders the delta string when supplied", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    expect(html).toMatch(/data-slot="daily-briefing-delta"/);
    expect(html).toContain("↓ 4 mmHg");
    expect(html).toContain("+6 mmHg");
  });

  it("stacks headline over delta below sm and keeps the row at sm+", () => {
    const html = render(<DailyBriefing briefing={baseBriefing} />);
    // Phone-first column (headline above, delta beneath), side-by-side
    // restored at sm+ — a wide delta must never squeeze the headline
    // into a narrow multi-line column.
    expect(html).toMatch(
      /class="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3"/,
    );
    // Delta badge stays content-width + left-aligned in the stacked state.
    expect(html).toMatch(
      /data-slot="daily-briefing-delta"[^>]*class="[^"]*self-start[^"]*sm:shrink-0[^"]*"/,
    );
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
    // Routed through the semantic feedback tokens (AA-safe in light mode);
    // raw `--dracula-*` text primitives have no light-mode override.
    expect(html).toContain("bg-success"); // tone=good bar
    expect(html).toContain("bg-warning"); // tone=watch bar
    expect(html).toContain("bg-info"); // tone=info bar
  });

  it("renders the 'Updated today, <time>' caption when updatedAt is supplied", () => {
    // v1.22 — the footer now uses `formatUpdatedLabel`: a same-day
    // timestamp reads "Updated today, HH:MM". The label derives "today" from the
    // real clock in the profile timezone (Europe/Berlin), so freeze the clock to
    // a fixed mid-day instant and base `updatedAt` on it — otherwise a run that
    // straddles local midnight reads the five-minutes-ago stamp as "yesterday".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T12:00:00+02:00"));
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const html = render(
        <DailyBriefing briefing={baseBriefing} updatedAt={fiveMinutesAgo} />,
      );
      expect(html).toMatch(/data-slot="daily-briefing-updated"/);
      expect(html).toContain("Updated today");
    } finally {
      vi.useRealTimers();
    }
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
    // The findings list renders only when there are findings.
    const html = render(
      <DailyBriefing briefing={{ ...baseBriefing, keyFindings: [] }} />,
    );
    expect(html).not.toContain('data-slot="daily-briefing-findings-title"');
    expect(html).not.toContain('data-slot="daily-briefing-findings"');
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
    expect(html).toContain("skeleton-shimmer");
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

  // v1.39 — the card has no "no provider" state of its own any more.
  // It only mounts while the briefing capability is available, which
  // implies a provider; a missing provider is said once by the setup hint on
  // the overview. The empty state therefore always offers the regenerate CTA.
  it("never renders a connect-provider state; the empty state offers regenerate", () => {
    const html = render(
      <DailyBriefing briefing={null} onRegenerate={() => {}} />,
    );
    expect(html).not.toContain("daily-briefing-no-provider");
    expect(html).not.toContain("daily-briefing-stale-no-provider");
    expect(html).not.toMatch(/href="\/settings\/ai"/);
    expect(html).toContain('data-slot="daily-briefing-empty-cta"');
  });

  // v1.25 — generation-failed affordances. The briefing keeps its last good
  // text; the card adds an honest "couldn't refresh" footer hint on a held
  // briefing and a "couldn't generate — retry" empty state when there is none.
  it("renders the refresh-failed footer hint on a held briefing", () => {
    const html = render(
      <DailyBriefing
        briefing={baseBriefing}
        onRegenerate={() => {}}
        generationFailed
      />,
    );
    expect(html).toContain('data-slot="daily-briefing-refresh-failed"');
    // The rendered apostrophe is HTML-escaped; match the unambiguous tail.
    expect(html).toContain("refresh the briefing");
    expect(html).toContain('data-slot="daily-briefing-refresh-failed-retry"');
  });

  it("does NOT render the refresh-failed hint when generation did not fail", () => {
    const html = render(
      <DailyBriefing briefing={baseBriefing} onRegenerate={() => {}} />,
    );
    expect(html).not.toContain('data-slot="daily-briefing-refresh-failed"');
  });

  it("renders the 'couldn't generate' empty state with a retry CTA when failed and empty", () => {
    const html = render(
      <DailyBriefing
        briefing={null}
        onRegenerate={() => {}}
        generationFailed
      />,
    );
    // The rendered apostrophe is HTML-escaped; match the unambiguous tail.
    expect(html).toContain("generate the briefing");
    expect(html).toMatch(/data-slot="daily-briefing-empty-cta"/);
    expect(html).toContain("Retry");
  });

  // #1499 — a generation whose reply the card could not render is recorded
  // as a `format` failure. The empty card says the model answered in the
  // wrong form, not "no briefing yet" and not a provider timeout, and offers
  // the retry.
  it("explains a format failure and offers the retry instead of 'no briefing yet'", () => {
    const html = render(
      <DailyBriefing
        briefing={null}
        onRegenerate={() => {}}
        generationFailed
        generationFailureClass="format"
      />,
    );
    expect(html).toContain("not in a form the briefing can show");
    expect(html).not.toContain("timed out or returned an error");
    expect(html).not.toContain("No briefing yet");
    expect(html).toMatch(/data-slot="daily-briefing-empty-cta"/);
    expect(html).toContain("Retry");
  });
});
