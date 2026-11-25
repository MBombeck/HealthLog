import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { z } from "zod";

import { I18nProvider } from "@/lib/i18n/context";
import {
  MORNING_VISIBLE_ROWS,
  MorningBlock,
  morningSlot,
  morningToDoRows,
  withIntakeSheetAction,
} from "../morning-block";
import { MorningSkeleton } from "../morning-skeleton";
import { dailyMorningResponse } from "@/lib/openapi/routes/daily";
import type { DailyDigest } from "@/lib/daily/digest";
import type { DailyMorning, DailyMorningCard } from "@/lib/daily/morning";
import type { PriorityItem } from "@/lib/daily/priority-item";
import type { TodayFact } from "@/lib/daily/today-overview";
import { SCORE_VERSION } from "@/lib/analytics/score/types";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
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
      href: "/medications?highlight=med1",
    },
  ],
  moduleKey: "medications",
};

const checkinItem: PriorityItem = {
  kind: "coach_checkin",
  title: "Check in on your plan",
  body: "Ten minutes of walking after lunch.",
  status: "info",
  actions: [
    {
      labelKey: "daily.action.checkinKeep",
      intent: "coach.checkin.keep:plan1",
    },
    {
      labelKey: "daily.action.checkinLetGo",
      intent: "coach.checkin.letgo:plan1",
    },
  ],
};

const milestoneItem: PriorityItem = {
  kind: "milestone",
  title: "30 days logged",
  body: "A month of mornings.",
  status: "success",
  actions: [],
  itemKey: "milestone:30d",
};

const preventiveItem: PriorityItem = {
  kind: "preventive_care",
  title: "Check-up due",
  body: "Dental check-up is due.",
  status: "info",
  actions: [
    {
      labelKey: "daily.action.viewCheckups",
      intent: "checkup.view",
      href: "/checkups",
    },
  ],
};

const medsFact: TodayFact = {
  kind: "medications",
  label: "Medications",
  value: "2 of 3 taken",
  href: "/medications",
  moduleKey: "medications",
};
const cycleFact: TodayFact = {
  kind: "cycle",
  label: "Cycle",
  value: "Follicular phase, day 9",
  href: "/cycle",
  moduleKey: "cycle",
};
const sleepFact: TodayFact = {
  kind: "sleep",
  label: "Last night",
  value: "7 h 20 min",
  href: "/insights/sleep",
};
const restFact: TodayFact = {
  kind: "rest_mode",
  label: "Rest mode",
  value: "Since 3 days",
  href: "/illness",
};

function digest(over: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: "2026-11-25T06:00:00.000Z",
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
    topSignal: null,
    signalLine: null,
    briefingLead: null,
    lead: { text: "All 4 of today's values are in range.", source: "signal" },
    today: [medsFact, sleepFact, cycleFact],
    restMode: null,
    line: null,
    worthALook: [doseItem, checkinItem],
    justIn: null,
    reactionLine: null,
    ...over,
  } as DailyDigest;
}

const nightCard: DailyMorningCard = {
  kind: "night",
  titleKey: "daily.morningCard.title.night",
  title: "Last night",
  ring: { score: 75, band: "green", fresh: true, asOfDay: "2026-11-25" },
  lines: [{ text: "7 h 20 min, about as usual", href: null }],
  sourceValues: [
    {
      source: "WHOOP",
      label: "WHOOP Sleep Performance",
      value: 88,
      scaleMax: 100,
      measuredAt: "2026-11-25T06:00:00.000Z",
    },
  ],
  href: "/insights/scores/sleep",
};

const staleReadinessCard: DailyMorningCard = {
  kind: "today_different",
  titleKey: "daily.morningCard.title.todayDifferent",
  title: "Different today",
  ring: { score: null, band: null, fresh: false, asOfDay: "2026-11-24" },
  lines: [{ text: "Last 81 on 24 Nov", href: null }],
  sourceValues: [],
  href: "/insights/scores/readiness",
};

function morning(over: Partial<DailyMorning> = {}): DailyMorning {
  return {
    lead: {
      rank: 8,
      key: "in_range",
      text: "All 4 of today's values are in range.",
      language: "en",
    },
    cards: [nightCard, staleReadinessCard],
    toDo: { titleKey: "daily.morningCard.title.toDo", title: "To do today" },
    generatedAt: "2026-11-25T06:05:00.000Z",
    ...over,
  };
}

describe("morningToDoRows", () => {
  it("orders the medication count, the rail as delivered, then the cycle day", () => {
    const rows = morningToDoRows(digest());
    expect(
      rows.map((r) => (r.type === "fact" ? r.fact.kind : r.item.kind)),
    ).toEqual(["medications", "dose_window", "coach_checkin", "cycle"]);
  });

  it("leaves sleep and the vitals to the sentence and the first card", () => {
    const rows = morningToDoRows(digest());
    expect(rows.some((r) => r.type === "fact" && r.fact.kind === "sleep")).toBe(
      false,
    );
  });

  it("pauses preventive care and the coach check-in in Rest mode, nothing else", () => {
    const rows = morningToDoRows(
      digest({
        today: [restFact, medsFact],
        worthALook: [preventiveItem, checkinItem, doseItem],
      }),
    );
    expect(
      rows.map((r) => (r.type === "fact" ? r.fact.kind : r.item.kind)),
    ).toEqual(["medications", "dose_window"]);
    // The same rows without Rest mode keep both.
    expect(
      morningToDoRows(
        digest({
          today: [medsFact],
          worthALook: [preventiveItem, checkinItem],
        }),
      ),
    ).toHaveLength(3);
  });

  it("reads a digest cached before the overview existed as no facts", () => {
    const rows = morningToDoRows(
      digest({ today: undefined as unknown as TodayFact[] }),
    );
    expect(rows.every((r) => r.type === "item")).toBe(true);
  });
});

describe("withIntakeSheetAction", () => {
  it("drops the dose link so the card reports the intent, while the sheet can open", () => {
    expect(withIntakeSheetAction(doseItem, true).actions[0].href).toBe(
      undefined,
    );
    expect(withIntakeSheetAction(doseItem, false).actions[0].href).toBe(
      "/medications?highlight=med1",
    );
    // Other kinds pass untouched.
    expect(withIntakeSheetAction(preventiveItem, true)).toBe(preventiveItem);
  });
});

describe("morningSlot (atomic block, T12/T13)", () => {
  const base = {
    visible: true,
    hasDigest: false,
    hasMorning: false,
    mounted: false,
    digestLoading: false,
    morningLoading: false,
    digestError: false,
  };

  it("paints the block on the server and the first client pass when both reads were seeded", () => {
    const seeded = { ...base, hasDigest: true, hasMorning: true };
    expect(morningSlot(seeded)).toBe("block");
    expect(morningSlot({ ...seeded, mounted: true })).toBe("block");
  });

  it("paints the same skeleton on both passes when nothing was seeded", () => {
    expect(morningSlot(base)).toBe("skeleton");
    expect(morningSlot({ ...base, mounted: true, digestLoading: true })).toBe(
      "skeleton",
    );
  });

  it("never paints a partial block: a digest alone waits for the morning", () => {
    expect(
      morningSlot({
        ...base,
        mounted: true,
        hasDigest: true,
        morningLoading: true,
      }),
    ).toBe("skeleton");
    expect(morningSlot({ ...base, hasDigest: true })).toBe("skeleton");
  });

  it("falls back to the Today hero when the morning is absent after loading", () => {
    expect(morningSlot({ ...base, mounted: true, hasDigest: true })).toBe(
      "hero",
    );
  });

  it("shows the error card for a failed digest", () => {
    expect(morningSlot({ ...base, mounted: true, digestError: true })).toBe(
      "error",
    );
  });

  it("switches the whole block off with the layout switch", () => {
    for (const state of [
      { ...base, hasDigest: true, hasMorning: true },
      base,
      { ...base, mounted: true, digestError: true },
    ]) {
      expect(morningSlot({ ...state, visible: false })).toBe("off");
    }
  });
});

describe("<MorningBlock>", () => {
  it("renders the sentence, the health score and the cards in order", () => {
    const html = render(<MorningBlock digest={digest()} morning={morning()} />);
    expect(html).toContain('data-slot="morning-block"');
    expect(html).toContain('data-lead="in_range"');
    expect(text(html)).toContain("All 4 of today's values are in range.");
    expect(html).toContain('data-slot="morning-score"');
    const kinds = [
      ...html.matchAll(/data-slot="morning-card"[^>]*data-kind="([a-z_]+)"/g),
    ].map((m) => m[1]);
    expect(kinds).toEqual(["night", "today_different", "to_do"]);
    // No second "Worth a look" list.
    expect(html).not.toContain('data-slot="today-hero-rail"');
  });

  it("puts To do today first when the hero setting asks for reminders", () => {
    const html = render(
      <MorningBlock
        digest={digest()}
        morning={morning()}
        primaryContent="reminders"
      />,
    );
    const kinds = [
      ...html.matchAll(/data-slot="morning-card"[^>]*data-kind="([a-z_]+)"/g),
    ].map((m) => m[1]);
    expect(kinds).toEqual(["to_do", "night", "today_different"]);
  });

  it("shows a stale readiness as the empty ring with the last value below", () => {
    const html = render(<MorningBlock digest={digest()} morning={morning()} />);
    const card = html.slice(html.indexOf('data-kind="today_different"'));
    expect(card).toContain('data-fresh="false"');
    expect(card).toContain('data-provisional="true"');
    expect(text(card)).toContain("Last 81 on 24 Nov");
    // The ring's "too little data" caption gives way to that line.
    expect(card).toContain("score-ring-provisional]]:hidden");
  });

  it("never shows a number from a ring that is not fresh", () => {
    const html = render(
      <MorningBlock
        digest={digest()}
        morning={morning({
          cards: [
            {
              ...staleReadinessCard,
              ring: { score: 64, band: "yellow", fresh: false, asOfDay: null },
            },
          ],
        })}
      />,
    );
    const card = html.slice(html.indexOf('data-kind="today_different"'));
    expect(card).toContain('data-provisional="true"');
    expect(card).not.toContain('data-band="yellow"');
  });

  it("shows a Rest-mode ring without a band word", () => {
    const html = render(
      <MorningBlock
        digest={digest()}
        morning={morning({
          cards: [
            {
              ...staleReadinessCard,
              ring: { score: 64, band: null, fresh: true, asOfDay: null },
              lines: [],
            },
          ],
        })}
      />,
    );
    const card = html.slice(html.indexOf('data-kind="today_different"'));
    expect(card).toContain('aria-label="Readiness 64"');
  });

  it("names a device's own score by its vendor and scale, without a band", () => {
    const html = render(<MorningBlock digest={digest()} morning={morning()} />);
    expect(text(html)).toContain("WHOOP Sleep Performance: 88 of 100");
    expect(html).toContain('data-source="WHOOP"');
  });

  it("opens the intake sheet from a due dose and keeps the check-in answers", () => {
    const html = render(
      <MorningBlock
        digest={digest()}
        morning={morning()}
        onLogDose={() => {}}
      />,
    );
    const dose = html.slice(html.indexOf('data-kind="dose_window"'));
    // A button, not the link to the medication page.
    expect(dose.slice(0, 2000)).not.toContain("/medications?highlight=med1");
    expect(text(dose)).toContain("Take");
    expect(dose.slice(0, 2000)).toContain("<button");
    expect(text(html)).toContain("Keep it");
    expect(text(html)).toContain("Let it go");
  });

  it("keeps the link to the medication where no sheet can open", () => {
    const html = render(<MorningBlock digest={digest()} morning={morning()} />);
    expect(html).toContain("/medications?highlight=med1");
  });

  it("shows three rows and opens the rest in place", () => {
    const html = render(
      <MorningBlock
        digest={digest({ worthALook: [doseItem, checkinItem, milestoneItem] })}
        morning={morning()}
      />,
    );
    // medications, dose, check-in visible; milestone and cycle behind "2 more".
    const todo = html.slice(html.indexOf('data-kind="to_do"'));
    const beforeMore = todo.slice(0, todo.indexOf('data-slot="morning-more"'));
    expect([...beforeMore.matchAll(/data-slot="morning-row"/g)].length).toBe(
      MORNING_VISIBLE_ROWS,
    );
    expect(text(todo)).toContain("2 more items");
    // Dismiss stays on the observation behind the fold.
    expect(todo).toContain('data-slot="priority-card-dismiss"');
  });

  it("is an empty state with both first steps on a new account", () => {
    const html = render(
      <MorningBlock
        digest={digest({ score: null, today: [], worthALook: [] })}
        morning={morning({
          lead: {
            rank: 10,
            key: "nothing",
            text: "No values yet today.",
            language: "en",
          },
          cards: [],
        })}
        onAddMeasurement={() => {}}
      />,
    );
    expect(html).toContain('data-slot="morning-empty"');
    expect(text(html)).toContain("No values yet today.");
    expect(text(html)).toContain("Log value");
    expect(text(html)).toContain("Connect a source");
    expect(html).not.toContain('data-slot="morning-score"');
  });

  it("shows the reaction line or briefing sentence under the sentence, never instead", () => {
    const html = render(
      <MorningBlock
        digest={digest({
          lead: { text: "A steady week behind you.", source: "briefing" },
        })}
        morning={morning()}
      />,
    );
    expect(html).toContain('data-slot="morning-narrative"');
    expect(text(html)).toContain("A steady week behind you.");
    expect(text(html)).toContain("All 4 of today's values are in range.");
    // A deterministic digest lead is not repeated.
    expect(
      render(<MorningBlock digest={digest()} morning={morning()} />),
    ).not.toContain('data-slot="morning-narrative"');
  });

  it("falls back to the glossary title when a cached response has none", () => {
    const html = render(
      <MorningBlock
        digest={digest()}
        morning={morning({
          cards: [{ ...nightCard, title: "" }],
          toDo: { titleKey: "daily.morningCard.title.toDo", title: "" },
        })}
      />,
      "de",
    );
    expect(text(html)).toContain("Letzte Nacht");
    expect(text(html)).toContain("Heute zu tun");
  });
});

describe("<MorningSkeleton>", () => {
  it("is hidden from assistive tech and has no text that could differ", () => {
    const html = renderToStaticMarkup(<MorningSkeleton />);
    expect(html).toContain('aria-hidden="true"');
    expect(text(html)).toBe("");
  });
});

/**
 * T10: every field of `DailyMorning` has a reader on the web. The leaves are
 * enumerated from the registered response schema (the producer), so a new
 * field fails here until it is read; each leaf names how the block reads it,
 * and the check renders the block and finds that value.
 */
describe("DailyMorning field readers (T10)", () => {
  function leaves(schema: unknown, path = ""): string[] {
    const ref = (schema as { $ref?: string }).$ref;
    if (ref) return leaves(definitions[ref.split("/").pop() ?? ""], path);
    const json = schema as {
      type?: string | string[];
      properties?: Record<string, unknown>;
      items?: unknown;
      anyOf?: unknown[];
    };
    if (json.anyOf) {
      return [...new Set(json.anyOf.flatMap((option) => leaves(option, path)))];
    }
    if (json.properties) {
      return Object.entries(json.properties).flatMap(([key, value]) =>
        leaves(value, path ? `${path}.${key}` : key),
      );
    }
    if (json.items) return leaves(json.items, `${path}[]`);
    return json.type === "null" ? [] : [path];
  }

  const html = render(<MorningBlock digest={digest()} morning={morning()} />);
  const fallback = render(
    <MorningBlock
      digest={digest()}
      morning={morning({
        cards: [{ ...nightCard, title: "" }],
        toDo: { titleKey: "daily.morningCard.title.toDo", title: "" },
      })}
    />,
  );
  const lineLink = render(
    <MorningBlock
      digest={digest()}
      morning={morning({
        cards: [{ ...nightCard, lines: [{ text: "x", href: "/line-target" }] }],
      })}
    />,
  );

  const READERS: Record<string, () => boolean> = {
    "lead.rank": () => html.includes('data-rank="8"'),
    "lead.key": () => html.includes('data-lead="in_range"'),
    "lead.text": () => text(html).includes("All 4 of today's values"),
    "lead.language": () => html.includes('lang="en"'),
    "cards[].kind": () => html.includes('data-kind="night"'),
    "cards[].titleKey": () => text(fallback).includes("Last night"),
    "cards[].title": () => text(html).includes("Different today"),
    "cards[].ring.score": () =>
      html.includes(">75<") || text(html).includes("75"),
    "cards[].ring.band": () => html.includes('data-band="green"'),
    "cards[].ring.fresh": () => html.includes('data-fresh="false"'),
    "cards[].ring.asOfDay": () => html.includes('data-as-of-day="2026-11-24"'),
    "cards[].lines[].text": () => text(html).includes("about as usual"),
    "cards[].lines[].href": () => lineLink.includes('href="/line-target"'),
    "cards[].sourceValues[].source": () => html.includes('data-source="WHOOP"'),
    "cards[].sourceValues[].label": () =>
      text(html).includes("WHOOP Sleep Performance"),
    "cards[].sourceValues[].value": () => text(html).includes(": 88 of"),
    "cards[].sourceValues[].scaleMax": () => text(html).includes("of 100"),
    "cards[].sourceValues[].measuredAt": () =>
      html.includes('data-measured-at="2026-11-25T06:00:00.000Z"'),
    "cards[].href": () => html.includes('href="/insights/scores/sleep"'),
    "toDo.titleKey": () => text(fallback).includes("To do today"),
    "toDo.title": () => text(html).includes("To do today"),
    generatedAt: () =>
      html.includes('data-generated-at="2026-11-25T06:05:00.000Z"'),
  };

  const jsonSchema = z.toJSONSchema(dailyMorningResponse, {
    io: "output",
  }) as { $defs?: Record<string, unknown> };
  const definitions: Record<string, unknown> = jsonSchema.$defs ?? {};
  const schemaLeaves = leaves(jsonSchema).sort();

  it("enumerates a non-empty set of leaves from the schema", () => {
    expect(schemaLeaves.length).toBeGreaterThan(10);
  });

  it("names a reader for every leaf, and no reader for a leaf that is gone", () => {
    expect(Object.keys(READERS).sort()).toEqual(schemaLeaves);
  });

  it.each(Object.keys(READERS))("reads %s", (leaf) => {
    expect(READERS[leaf]()).toBe(true);
  });
});
