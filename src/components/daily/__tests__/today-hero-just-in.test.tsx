/**
 * The Today hero's arrival handling and the reaction line's lead
 * replacement.
 *
 * The hero used to carry a "just in" chip under the score, with the
 * arrival's local time on it. It is gone: under a number, "just in" did
 * not say what had arrived — the score? a reading? — and the clock face
 * changed nothing a person would then do. What is left is the invariant
 * that an arrival alone is not a reason to paint anything, and the one
 * the reaction line has always had.
 *
 * NO LAYOUT SHIFT. The reaction line REPLACES the lead; it is never a
 * second paragraph. The hero stays one lead line tall, so nothing below
 * it moves when the line arrives on a poll.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { TodayHero } from "../today-hero";
import type { DailyDigest } from "@/lib/daily/digest";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const ARRIVED_AT = "2026-07-16T05:41:00.000Z";

function digest(over: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: "2026-07-16T06:00:00.000Z",
    ai: DIGEST_AI_AVAILABLE,
    phase: "final",
    sleepPending: false,
    score: { value: 82, band: "green", delta: 3 },
    topSignal: null,
    signalLine: null,
    briefingLead: "Your week is trending steady.",
    lead: { text: "Your week is trending steady.", source: "briefing" },
    today: [],
    restMode: null,
    line: "Your week is trending steady.",
    worthALook: [],
    justIn: null,
    reactionLine: null,
    ...over,
  };
}

/** Any hh:mm clock face — the thing the hero must never print here. */
const CLOCK_FACE = /\d{1,2}:\d{2}/;

describe("TodayHero — an arrival is not a chip", () => {
  it("paints no arrival marker when something has landed", () => {
    const html = render(
      <TodayHero
        digest={digest({ justIn: { kind: "sleep_night", at: ARRIVED_AT } })}
      />,
    );

    expect(html).not.toContain('data-slot="today-hero-just-in"');
    expect(html).not.toContain("Just in");
    expect(html).not.toContain(ARRIVED_AT);
  });

  it("prints no clock face beside the score", () => {
    // The removed chip was the only wall clock on this surface, and a
    // wall clock rendered on the server pass is a hydration mismatch as
    // well as noise. Neither is possible once nothing prints one.
    const html = render(
      <TodayHero
        digest={digest({ justIn: { kind: "weight", at: ARRIVED_AT } })}
      />,
    );

    expect(html).not.toMatch(CLOCK_FACE);
  });

  it("still shows a pending night, which is a different sentence", () => {
    // The freshness note says the day is not complete yet, which changes
    // how the number should be read. That one stays.
    const html = render(
      <TodayHero
        digest={digest({
          phase: "provisional",
          sleepPending: true,
          justIn: { kind: "weight", at: ARRIVED_AT },
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero-sleep-pending"');
    expect(html).not.toContain('data-slot="today-hero-just-in"');
  });

  it("renders nothing at all for an account whose only news was the arrival", () => {
    // With no chip there is nothing left for such a digest to say, and a
    // bordered empty hero above the tile strip would be worse than
    // absence.
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          briefingLead: null,
          lead: null,
          worthALook: [],
          reactionLine: null,
          justIn: { kind: "sleep_night", at: ARRIVED_AT },
        })}
      />,
    );

    expect(html).not.toContain('data-slot="today-hero"');
  });
});

/**
 * What the `today-just-in` e2e spec stands on.
 *
 * That spec watches an open dashboard flip from provisional to final when
 * last night's sleep lands. It can only watch it on a hero that exists,
 * and until the chip was removed the ARRIVAL was what kept the hero alive
 * on the bare fixture account — so the spec was quietly testing the day
 * flip on a hero that only its own subject was propping up. It now seeds
 * a rail item instead, which is the same shape as a real account with a
 * connection needing attention.
 *
 * These cases are the local half of that: the browser proves the flip on
 * a real page, and this proves the composition the fixture relies on is
 * the one the component actually renders. Without them the e2e change
 * would be a guess about a file it never touches.
 */
describe("TodayHero — what earns the hero without a score", () => {
  const SYNC_ISSUE: DailyDigest["worthALook"][number] = {
    kind: "sync_issue",
    title: "A connection needs your attention",
    body: "One of your integrations stopped syncing.",
    status: "warning",
    actions: [
      {
        labelKey: "daily.action.reconnect",
        intent: "sync.reconnect",
        href: "/settings/integrations",
      },
    ],
  };

  /** No score, no briefing, no reaction line: one rail item and a night. */
  function itemOnly(over: Partial<DailyDigest> = {}): DailyDigest {
    return digest({
      score: null,
      briefingLead: null,
      lead: null,
      reactionLine: null,
      phase: "provisional",
      sleepPending: true,
      worthALook: [SYNC_ISSUE],
      justIn: { kind: "sleep_night", at: ARRIVED_AT },
      ...over,
    });
  }

  it("renders on a rail item alone, and names the day it is reading", () => {
    const html = render(<TodayHero digest={itemOnly()} />);

    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-phase="provisional"');
    expect(html).toContain('data-slot="today-hero-rail"');
    // The note the flip is going to clear. Asserting it is HERE first is
    // what stops the "it is gone afterwards" assertion from passing on a
    // note that was never rendered at all.
    expect(html).toContain('data-slot="today-hero-sleep-pending"');
    expect(html).not.toContain('data-slot="today-hero-just-in"');
  });

  it("clears the pending note and reads final once the night is in", () => {
    const html = render(
      <TodayHero digest={itemOnly({ phase: "final", sleepPending: false })} />,
    );

    expect(html).toContain('data-phase="final"');
    expect(html).not.toContain('data-slot="today-hero-sleep-pending"');
    expect(html).not.toContain('data-slot="today-hero-just-in"');
  });

  it("has nothing to render once the item goes too", () => {
    // The mirror, and the reason the e2e fixture has to seed something:
    // strip the item and the same digest paints nothing, arrival and
    // pending night included.
    const html = render(<TodayHero digest={itemOnly({ worthALook: [] })} />);

    expect(html).not.toContain('data-slot="today-hero"');
  });
});

describe("TodayHero — the reaction line replaces the lead", () => {
  const REACTION = "A solid night, deeper than your recent stretch.";

  it("renders the reaction line instead of the briefing lead", () => {
    const html = render(
      <TodayHero
        digest={digest({
          reactionLine: REACTION,
          briefingLead: "Your week is trending steady.",
          // The server resolved the reaction line as the lead.
          lead: { text: REACTION, source: "reaction" },
        })}
      />,
    );

    expect(html).toContain(REACTION);
    // The lead it replaced must be GONE, not pushed down into a second block.
    expect(html).not.toContain("Your week is trending steady.");
  });

  it("stays exactly one lead line tall — no second paragraph, no shift", () => {
    const html = render(
      <TodayHero
        digest={digest({
          reactionLine: REACTION,
          briefingLead: "Your week is trending steady.",
          // The server resolved the reaction line as the lead.
          lead: { text: REACTION, source: "reaction" },
        })}
      />,
    );

    const leadSlots = html.split('data-slot="today-hero-lead"').length - 1;
    expect(leadSlots).toBe(1);
  });

  it("falls back to the briefing lead when no line was generated", () => {
    const html = render(
      <TodayHero
        digest={digest({
          reactionLine: null,
          briefingLead: "Your week is trending steady.",
        })}
      />,
    );
    expect(html).toContain("Your week is trending steady.");
  });

  it("still renders for an otherwise-bare account when a line exists", () => {
    // The one moment this surface exists for must not be swallowed by the
    // empty-account degrade.
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          briefingLead: null,
          lead: { text: REACTION, source: "reaction" },
          worthALook: [],
          reactionLine: REACTION,
          justIn: { kind: "weight", at: ARRIVED_AT },
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain(REACTION);
  });
});
