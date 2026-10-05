import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { TodayHero } from "../today-hero";
import type { DailyDigest } from "@/lib/daily/digest";
import type { PriorityItem } from "@/lib/daily/priority-item";
import type { TodayFact } from "@/lib/daily/today-overview";
import { SCORE_VERSION } from "@/lib/analytics/score/types";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

// The hero now wires the coach check-in card's keep / let-go taps through
// `useCoachCheckinAction`, so it needs a QueryClient in the tree.
function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const doseItem: PriorityItem = {
  kind: "dose_window",
  title: "Medication due",
  body: "Ramipril is due today.",
  status: "warning",
  actions: [
    {
      labelKey: "daily.action.logDose",
      intent: "dose.log",
      href: "/medications",
    },
  ],
  moduleKey: "medications",
};

const syncItem: PriorityItem = {
  kind: "sync_issue",
  title: "Sync needs attention",
  body: "Withings isn't syncing.",
  status: "warning",
  actions: [
    {
      labelKey: "daily.action.reconnect",
      intent: "sync.reconnect",
      href: "/settings/integrations",
    },
  ],
};

function digest(over: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: "2026-07-16T06:00:00.000Z",
    ai: DIGEST_AI_AVAILABLE,
    phase: "final",
    sleepPending: false,
    score: {
      value: 82,
      band: "green",
      delta: 3,
      deltaReason: null,
      scoreVersion: SCORE_VERSION,
      composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
    },
    topSignal: {
      sourceMetric: "bp",
      tone: "watch",
      headline: "Blood pressure a touch high this morning",
      nudge: "Take it again after a calm five minutes.",
      delta: "+6 mmHg vs your 30-day average",
    },
    // Resolved on the server: the lead says nothing about blood pressure, so
    // the whole signal rides under it.
    signalLine: {
      headline: "Blood pressure a touch high this morning",
      delta: "+6 mmHg vs your 30-day average",
    },
    briefingLead: "Your week is trending steady.",
    lead: { text: "Your week is trending steady.", source: "briefing" },
    today: [],
    restMode: null,
    line: "Your week is trending steady.",
    worthALook: [doseItem, syncItem],
    justIn: null,
    reactionLine: null,
    ...over,
  };
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("<TodayHero>", () => {
  it("renders the score, the lead read, and the worth-a-look rail", () => {
    const html = render(<TodayHero digest={digest()} />);
    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-phase="final"');
    // Score ring paints its populated (final) face with the server band.
    expect(html).toContain('data-slot="today-hero-score"');
    expect(html).toContain('data-band="green"');
    expect(html).not.toContain('data-provisional="true"');
    // The day's read lead.
    expect(html).toContain("Your week is trending steady.");
    // The top signal headline + its delta.
    expect(html).toContain("Blood pressure a touch high this morning");
    expect(html).toContain("+6 mmHg vs your 30-day average");
    // The rail with both priority cards.
    expect(html).toContain('data-slot="today-hero-rail"');
    expect(html).toContain('data-kind="dose_window"');
    expect(html).toContain('data-kind="sync_issue"');
    // The score delta chip.
    expect(html).toContain('data-slot="today-hero-score-delta"');
  });

  it("does not present a suppressed algorithm jump as score movement", () => {
    const html = render(
      <TodayHero
        digest={digest({
          score: {
            value: 82,
            band: "green",
            delta: 20,
            deltaReason: "algorithm_changed",
            scoreVersion: SCORE_VERSION,
            composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
          },
        })}
      />,
    );
    expect(html).not.toContain('data-slot="today-hero-score-delta"');
  });

  it("wires each PriorityItem action to its existing destination via href", () => {
    const html = render(<TodayHero digest={digest()} />);
    // Every S1 rail action carries an href, so PriorityCard renders it as a
    // link to the existing surface — S2 invents no new backend action.
    expect(html).toContain('href="/medications"');
    expect(html).toContain('href="/settings/integrations"');
    // The score ring is the one door to Insights — the separate
    // read-the-full-briefing link was redundant with it and is gone.
    expect(html).toContain('href="/insights"');
    expect(html).not.toContain('data-slot="today-hero-briefing-link"');
  });

  it("shows the honest sleep-pending note and provisional score", () => {
    const html = render(
      <TodayHero
        digest={digest({
          phase: "provisional",
          sleepPending: true,
          score: null,
          briefingLead: null,
          lead: null,
          line: "Your health score today is 82.",
          worthALook: [doseItem],
        })}
      />,
    );
    expect(html).toContain('data-phase="provisional"');
    expect(html).toContain('data-slot="today-hero-sleep-pending"');
    expect(html).toContain("Last night");
    // Null score → the ring's provisional face, never a zero.
    expect(html).toContain('data-provisional="true"');
    // The score ring stays the only route to Insights.
    expect(html).not.toContain('data-slot="today-hero-briefing-link"');
  });

  it("renders the server-resolved lead without repeating the ring's numeric score", () => {
    // The server already dropped the score sentence from the briefing (see
    // `today-overview.test.ts`); the hero prints what it was handed.
    const html = render(
      <TodayHero
        digest={digest({
          briefingLead: "Your week is trending steady.",
          lead: { text: "Your week is trending steady.", source: "briefing" },
          line: "Your week is trending steady.",
        })}
      />,
    );
    const text = visibleText(html);

    expect(text).toContain("Your week is trending steady.");
    expect(text.match(/\b82\b/g)).toHaveLength(1);
    expect(html).toContain('data-slot="today-hero-score"');
    expect(html).toContain('data-slot="today-hero-lead"');
  });

  it("falls back to the stored lines for a digest cached before the lead existed", () => {
    // The service worker's offline cache can hand back a digest written by
    // the previous version, which carries no `lead` field at all.
    const cached = digest({ reactionLine: "The new reading fits your week." });
    delete (cached as Partial<DailyDigest>).lead;
    const html = render(<TodayHero digest={cached} />);
    expect(visibleText(html)).toContain("The new reading fits your week.");

    const briefingOnly = digest();
    delete (briefingOnly as Partial<DailyDigest>).lead;
    expect(visibleText(render(<TodayHero digest={briefingOnly} />))).toContain(
      "Your week is trending steady.",
    );
  });

  it("does not resurrect a line the server left out of the lead", () => {
    // A current digest with `lead: null` decided there is nothing to say;
    // its reaction line (e.g. one that only repeated the score) stays out.
    const html = render(
      <TodayHero
        digest={digest({
          lead: null,
          briefingLead: null,
          topSignal: null,
          signalLine: null,
          reactionLine: "Score 82 today.",
        })}
      />,
    );
    expect(visibleText(html)).not.toContain("Score 82 today.");
  });

  it("does not repeat the top signal under a lead made from it", () => {
    // A briefing whose only sentence repeated the score leads with the top
    // signal's headline (resolved on the server); the muted signal line under
    // it would say the same thing twice.
    const html = render(
      <TodayHero
        digest={digest({
          briefingLead: null,
          lead: { text: "Pulse is settling lately", source: "briefing" },
          line: "Pulse is settling lately",
          topSignal: {
            sourceMetric: "pulse",
            tone: "info",
            headline: "Pulse is settling lately",
            nudge: "",
            delta: null,
          },
          signalLine: null,
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero-lead"');
    expect(html).toContain("Pulse is settling lately");
    expect(html).not.toContain('data-slot="today-hero-signal"');
  });

  it("does not invent a score narrative while the digest is provisional", () => {
    const html = render(
      <TodayHero
        digest={digest({
          phase: "provisional",
          sleepPending: true,
          score: null,
          briefingLead: null,
          lead: null,
          reactionLine: null,
          line: "Your health score today is 82.",
          worthALook: [doseItem],
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero-sleep-pending"');
    expect(html).toContain('data-provisional="true"');
    expect(html).not.toContain("Your health score today is 82.");
    expect(html).not.toContain('data-slot="today-hero-lead"');
  });

  it("degrades to nothing on a genuinely empty account", () => {
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          topSignal: null,
          signalLine: null,
          briefingLead: null,
          lead: null,
          line: "Nothing needs your attention today — everything's tracking normally.",
          worthALook: [],
        })}
      />,
    );
    // No score, no items, no cached briefing lead → the hero renders nothing
    // rather than an alarming empty card (the tile strip carries the
    // add-your-first-reading empty state).
    expect(html).toBe("");
  });

  it("shows all-clear when layout filtering removes every candidate", () => {
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          topSignal: null,
          signalLine: null,
          briefingLead: null,
          lead: null,
          line: "Nothing needs your attention today — everything's tracking normally.",
          worthALook: [],
          reactionLine: null,
          justIn: null,
        })}
        renderFilteredAllClear
      />,
    );

    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-slot="today-hero-all-clear"');
    expect(html).not.toContain('data-slot="today-hero-rail"');
    expect(html).not.toContain('data-slot="today-hero-signal"');
    expect(html).not.toContain('data-slot="today-hero-just-in"');
  });

  // v1.29.1 — the v1.29.0 selected-score-ring cluster was removed from the web
  // hero (Marc, live-use: uneven, wasted tile space). Only the main
  // health-score ring paints now; the cluster's data-slots are gone.
  it("renders no score-ring cluster — only the health-score ring", () => {
    const html = render(<TodayHero digest={digest()} />);
    expect(html).not.toContain('data-slot="today-hero-ring-cluster"');
    expect(html).not.toContain('data-slot="today-hero-ring"');
    // The health-score ring alone still paints, exactly as before.
    expect(html).toContain('data-slot="today-hero-score"');
  });

  it("draws no empty rail and no all-clear sentence once a lead carries the day", () => {
    const html = render(
      <TodayHero
        digest={digest({
          worthALook: [],
        })}
      />,
    );
    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-slot="today-hero-lead"');
    expect(html).not.toContain('data-slot="today-hero-all-clear"');
    expect(html).not.toContain('data-slot="today-hero-rail"');
  });

  it("keeps only the delta when the lead already says the headline", () => {
    const html = render(
      <TodayHero
        digest={digest({
          lead: {
            text: "Blood pressure a touch high this morning.",
            source: "briefing",
          },
          signalLine: {
            headline: null,
            delta: "+6 mmHg vs your 30-day average",
          },
        })}
      />,
    );
    const text = visibleText(html);
    expect(html).toContain('data-slot="today-hero-signal"');
    expect(text).toContain("+6 mmHg vs your 30-day average");
    // Said once, by the lead; the signal line carries only the delta.
    expect(text.split("touch high this morning").length - 1).toBe(1);
  });

  it("uses the compact score-only composition when all-clear has no narrative", () => {
    const html = render(
      <TodayHero
        digest={digest({
          topSignal: null,
          signalLine: null,
          briefingLead: null,
          lead: null,
          reactionLine: null,
          line: "Your health score today is 82.",
          worthALook: [],
        })}
      />,
    );
    const text = visibleText(html);

    expect(html).toContain('data-layout="compact-all-clear"');
    expect(html).toContain('data-slot="today-hero-all-clear"');
    expect(html).not.toContain('data-slot="today-hero-lead"');
    expect(html).toContain('style="width:120px;height:120px"');
    // The compact fallback keeps exactly one score face: the ring.
    expect(text.match(/\b82\b/g)).toHaveLength(1);
  });

  it("keeps the full narrative composition and the responsive score ring when a lead exists", () => {
    const html = render(
      <TodayHero
        digest={digest({
          topSignal: null,
          signalLine: null,
          worthALook: [],
        })}
      />,
    );

    expect(html).toContain('data-layout="narrative"');
    expect(html).toContain('data-slot="today-hero-lead"');
    // A compact dial on a phone, the md dial (168 px) from md up.
    expect(html).toContain("size-20 md:size-42");
    expect(html).not.toContain('data-layout="compact-all-clear"');
  });

  // The hero primary-content preference (`hero` on the dashboard layout
  // blob): "reminders" promotes the worth-a-look rail into the hero slot;
  // the score composition stays the default.
  it("promotes the rail into the hero slot when the preference is reminders", () => {
    const html = render(
      <TodayHero digest={digest()} primaryContent="reminders" />,
    );
    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-layout="reminders"');
    expect(html).toContain('data-slot="today-hero-rail"');
    expect(html).toContain('data-kind="dose_window"');
    expect(html).toContain('data-kind="sync_issue"');
    // The score composition yields the slot entirely.
    expect(html).not.toContain('data-slot="today-hero-score"');
    expect(html).not.toContain('data-slot="today-hero-lead"');
    expect(html).not.toContain('data-slot="today-hero-signal"');
  });

  it("keeps the score composition when the preference is the default score", () => {
    const html = render(<TodayHero digest={digest()} primaryContent="score" />);
    expect(html).toContain('data-slot="today-hero-score"');
    expect(html).toContain('data-slot="today-hero-rail"');
    expect(html).not.toContain('data-layout="reminders"');
  });

  it("shows the calm all-clear line when reminders mode has nothing to surface", () => {
    const html = render(
      <TodayHero
        digest={digest({ worthALook: [] })}
        primaryContent="reminders"
      />,
    );
    expect(html).toContain('data-layout="reminders"');
    expect(html).toContain('data-slot="today-hero-all-clear"');
    expect(html).not.toContain('data-slot="today-hero-rail"');
    expect(html).not.toContain('data-slot="today-hero-score"');
  });

  it("keeps the honest sleep-pending note in reminders mode", () => {
    const html = render(
      <TodayHero
        digest={digest({ phase: "provisional", sleepPending: true })}
        primaryContent="reminders"
      />,
    );
    expect(html).toContain('data-slot="today-hero-sleep-pending"');
  });

  it("still degrades to nothing on a genuinely empty account in reminders mode", () => {
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          topSignal: null,
          signalLine: null,
          briefingLead: null,
          lead: null,
          worthALook: [],
        })}
        primaryContent="reminders"
      />,
    );
    expect(html).toBe("");
  });
});

/**
 * v1.38 — the hero's ring shows the number and nothing else, so a score
 * resting on one area of health would look here exactly like one resting
 * on five. The basis line is the whole difference; it is stated only
 * below the recommended breadth, in the hero's quiet tier, and it never
 * touches the ring itself.
 */
describe("<TodayHero> score basis", () => {
  function withBasis(
    domains: number,
    tier: "full" | "partial" | "minimal",
  ): DailyDigest {
    return digest({
      score: {
        value: 82,
        band: "green",
        delta: 3,
        deltaReason: null,
        scoreVersion: SCORE_VERSION,
        composition: ["BLOOD_PRESSURE"],
        scoreBasis: { domains, recommended: 3, tier, physiological: true },
      },
    });
  }

  it("says what a two-area score rests on", () => {
    const html = render(<TodayHero digest={withBasis(2, "partial")} />);
    expect(html).toContain('data-slot="today-hero-score-basis"');
    expect(visibleText(html)).toContain("Based on 2 of 3 areas of health.");
  });

  it("leaves the ring's own face untouched", () => {
    const html = render(<TodayHero digest={withBasis(1, "minimal")} />);
    // Same band, same populated face, same delta chip as a full-breadth
    // day: the line is scope, not a downgrade.
    expect(html).toContain('data-band="green"');
    expect(html).not.toContain('data-provisional="true"');
    expect(html).toContain('data-slot="today-hero-score-delta"');
    expect(visibleText(html)).toContain("82");
  });

  it("says nothing once the recommended breadth is met", () => {
    const html = render(<TodayHero digest={withBasis(3, "full")} />);
    expect(html).not.toContain('data-slot="today-hero-score-basis"');
  });

  it("says nothing for a digest carrying no basis at all", () => {
    // An older cached digest. The hero never counts areas out of
    // `composition` — three pillars can be one area.
    const html = render(<TodayHero digest={digest()} />);
    expect(html).not.toContain('data-slot="today-hero-score-basis"');
  });

  it("says nothing when there is no score to rest on anything", () => {
    const html = render(<TodayHero digest={digest({ score: null })} />);
    expect(html).not.toContain('data-slot="today-hero-score-basis"');
  });
});

const FACTS: TodayFact[] = [
  {
    kind: "rest_mode",
    label: "Rest mode",
    value: "Day 3",
    href: "/illness",
    moduleKey: "illness",
  },
  {
    kind: "medications",
    label: "Medications",
    value: "1 of 3 taken",
    href: "/medications",
    moduleKey: "medications",
  },
  {
    kind: "appointment",
    label: "Appointment",
    value: "Tomorrow 09:30, Dr. Example",
    href: "/checkups",
  },
  {
    kind: "sleep",
    label: "Last night",
    value: "7h 20m, close to your usual",
    href: "/insights/sleep",
    moduleKey: "sleep",
  },
  {
    kind: "cycle",
    label: "Cycle",
    value: "Follicular, day 12",
    href: "/cycle",
    moduleKey: "cycle",
  },
];

describe("<TodayHero> Today overview", () => {
  it("renders each fact as a link to its page, in the order it was given", () => {
    const html = render(<TodayHero digest={digest({ today: FACTS })} />);
    expect(html).toContain('data-slot="today-hero-today"');
    const kinds = [
      ...html.matchAll(/data-slot="today-hero-fact" data-kind="([a-z_]+)"/g),
    ].map((m) => m[1]);
    expect(kinds).toEqual([
      "rest_mode",
      "medications",
      "appointment",
      "sleep",
      "cycle",
    ]);
    for (const fact of FACTS) {
      expect(html).toContain(`href="${fact.href}"`);
      expect(visibleText(html)).toContain(fact.value);
    }
  });

  it("puts the ring beside the lead and the overview under both on a phone", () => {
    const html = render(
      <TodayHero digest={digest({ today: FACTS, worthALook: [] })} />,
    );
    // The read grid: lead cell, overview cell, ring cell, in that order.
    const read = html.slice(html.indexOf('data-slot="today-hero-read"'));
    // The cell is the grid child wrapping the slot: the nearest preceding
    // div that carries a grid placement.
    const cellClass = (slot: string) => {
      const before = read.slice(0, read.indexOf(`data-slot="${slot}"`));
      const cells = [
        ...before.matchAll(/<div class="([^"]*(?:col-|row-)[^"]*)"/g),
      ];
      return cells.at(-1)?.[1] ?? "";
    };
    expect(cellClass("today-hero-lead")).toContain("row-start-1");
    // Full width under lead and ring below md, the leading column from md.
    expect(cellClass("today-hero-today")).toContain("col-span-2");
    expect(cellClass("today-hero-today")).toContain("md:col-span-1");
    expect(cellClass("today-hero-score")).toContain("col-start-2");
    expect(cellClass("today-hero-score")).toContain("md:row-span-2");
  });

  it("stacks each fact's label above its value, both on the reading edge", () => {
    const html = render(<TodayHero digest={digest({ today: FACTS })} />);
    const links = [
      ...html.matchAll(
        /data-slot="today-hero-fact"[^>]*><a[^>]*class="([^"]*)"[^>]*>(.*?)<\/a>/g,
      ),
    ];
    expect(links).toHaveLength(FACTS.length);
    for (const [, linkClass, inner] of links) {
      expect(linkClass).toContain("flex-col");
      expect(linkClass).not.toContain("justify-between");
      expect(linkClass).toContain("min-h-11");
      expect(inner).not.toContain("text-right");
      // Label muted, value foreground.
      expect(inner).toMatch(
        /text-muted-foreground[^"]*"[^>]*>[^<]+<\/span><span class="text-foreground/,
      );
    }
  });

  it("hides the fifth fact below md and never the first four", () => {
    const html = render(<TodayHero digest={digest({ today: FACTS })} />);
    const items = [
      ...html.matchAll(/<li[^>]*data-slot="today-hero-fact"[^>]*>/g),
    ].map((m) => m[0]);
    expect(items).toHaveLength(5);
    items.slice(0, 4).forEach((li) => expect(li).not.toContain("hidden"));
    expect(items[4]).toContain("hidden md:block");
  });

  it("drops the all-clear sentence when facts carry the day", () => {
    const html = render(
      <TodayHero
        digest={digest({ today: FACTS.slice(0, 2), worthALook: [] })}
      />,
    );
    expect(html).not.toContain('data-slot="today-hero-all-clear"');
    expect(html).toContain('data-layout="narrative"');
  });

  it("keeps the hero for an account whose only content is facts", () => {
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          topSignal: null,
          signalLine: null,
          briefingLead: null,
          lead: null,
          worthALook: [],
          today: FACTS.slice(1, 2),
        })}
      />,
    );
    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-slot="today-hero-today"');
  });

  it("renders a deterministic lead without the AI signal line", () => {
    const html = render(
      <TodayHero
        digest={digest({
          lead: {
            text: "All 4 of your latest vitals sit inside their usual range.",
            source: "signal",
          },
          signalLine: null,
        })}
      />,
    );
    expect(html).toContain('data-source="signal"');
    expect(html).not.toContain('data-slot="today-hero-signal"');
  });

  it("shows the facts in reminders mode, without the ring", () => {
    const html = render(
      <TodayHero
        digest={digest({ today: FACTS.slice(0, 2) })}
        primaryContent="reminders"
      />,
    );
    expect(html).toContain('data-slot="today-hero-today"');
    expect(html).not.toContain('data-slot="today-hero-score"');
  });
});

describe("<TodayHero> steady line", () => {
  const steady = (over: Partial<NonNullable<DailyDigest["score"]>>) =>
    digest({
      score: {
        value: 94,
        band: "green",
        delta: null,
        deltaReason: "below_noise_floor",
        scoreVersion: SCORE_VERSION,
        composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
        steadyWeeks: 4,
        ...over,
      },
    });

  it("says how long the score has held when no delta is shown", () => {
    const html = render(<TodayHero digest={steady({})} />);
    expect(html).toContain('data-slot="today-hero-score-steady"');
    expect(visibleText(html)).toContain("Steady for 4 weeks");
    expect(html).not.toContain('data-slot="today-hero-score-delta"');
  });

  it("never pairs a steady line with a delta", () => {
    const html = render(
      <TodayHero digest={steady({ delta: 3, deltaReason: null })} />,
    );
    expect(html).toContain('data-slot="today-hero-score-delta"');
    expect(html).not.toContain('data-slot="today-hero-score-steady"');
  });

  it("says nothing without a run", () => {
    const html = render(<TodayHero digest={steady({ steadyWeeks: null })} />);
    expect(html).not.toContain('data-slot="today-hero-score-steady"');
  });

  it("says at least when the run reaches past what was read", () => {
    const html = render(
      <TodayHero digest={steady({ steadyWeeks: 17, steadyAtLeast: true })} />,
    );
    expect(visibleText(html)).toContain("Steady for at least 17 weeks");
  });

  it("uses the German plural", () => {
    const html = render(<TodayHero digest={steady({})} />, "de");
    expect(visibleText(html)).toContain("Seit 4 Wochen stabil");
  });
});
