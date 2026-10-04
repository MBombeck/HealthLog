/**
 * v1.39.4 — follow-up chips are derived from what the turn read, never from
 * what it did not: every chip's domain is a done read or a table the turn
 * holds, absence never becomes a chip, the model can only reorder, the pref
 * switches them off, and there are never more than three.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import type {
  CoachResultMeta,
  CoachScopeSource,
  CoachScopeWindow,
  CoachStep,
  CoachStepDomain,
} from "@/lib/ai/coach/types";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";
import type { SettledToolCall } from "@/lib/ai/coach/results/project";
import { DEFAULT_COACH_PREFS } from "@/lib/validations/coach-prefs";

import {
  correlationPartners,
  deriveFollowUps,
  type CorrelationPair,
  type FollowUpHistory,
} from "../derive";

function table(
  domain: CoachStepDomain,
  over: Partial<CoachResultMeta> = {},
  window: CoachScopeWindow = "last30days",
): CoachResultMeta {
  return {
    ref: "r1",
    source: {
      tool: "get_metric_table",
      domain,
      window,
      period: "current",
      granularity: "day",
    },
    shape: "timeSeries",
    titleKey: "coach.result.title.byDay",
    title: `${domain} by day`,
    rowCount: 30,
    chartKind: null,
    displayed: true,
    ...over,
  };
}

function step(
  domain: CoachStepDomain,
  over: Partial<CoachStep> = {},
): CoachStep {
  return {
    id: "s1",
    tool: "get_metric_table",
    labelKey: "coach.step.readWindow",
    label: "Checking",
    domain,
    status: "done",
    count: 40,
    resultRef: "r1",
    ...over,
  };
}

function present(...metrics: string[]): InventoryEntry[] {
  return metrics.map((metric) => ({
    tool: "get_metric_series",
    metric,
    domain: metric,
    present: true,
  }));
}

const LONG_HISTORY: FollowUpHistory = {
  today: "2026-09-27",
  firstDate: { bp: "2024-01-01", weight: "2024-01-01", sleep: "2024-01-01" },
};

function derive(over: Partial<Parameters<typeof deriveFollowUps>[0]> = {}) {
  return deriveFollowUps({
    results: [table("bp")],
    steps: [step("bp")],
    inventory: present("bp", "weight", "sleep"),
    proposals: [],
    forcedFinal: false,
    prefs: DEFAULT_COACH_PREFS,
    locale: "en",
    ...over,
  });
}

describe("deriveFollowUps — the rules", () => {
  it("offers the period before for a current time series the record holds", () => {
    const chips = derive({ history: LONG_HISTORY });
    expect(chips[0].kind).toBe("previous_period");
    expect(chips[0]).toMatchObject({
      id: "f1",
      reuse: false,
      origin: "server",
      label: "Compare with the period before",
      anchor: { ref: "r1", domain: "bp", window: "last30days" },
    });
  });

  it("offers no chip that would read past the Coach's lookback limit", () => {
    const limited = (defaultWindow: "last30days" | "last90days") =>
      derive({
        history: LONG_HISTORY,
        prefs: { ...DEFAULT_COACH_PREFS, defaultWindow },
      }).map((c) => c.kind);
    // 30 days: the period before needs 60, a year ago 395, the wider window
    // is 90 days. None fits.
    expect(limited("last30days")).toEqual([]);
    // 90 days: the period before (60 days) and the 90-day window fit.
    expect(limited("last90days")).toEqual(["previous_period", "widen_window"]);
  });

  it("offers a year ago and a wider window only when the history reaches back", () => {
    expect(derive({ history: LONG_HISTORY }).map((c) => c.kind)).toEqual([
      "previous_period",
      "year_ago",
      "widen_window",
    ]);
    const recent: FollowUpHistory = {
      today: "2026-09-27",
      firstDate: { bp: "2026-08-10" },
    };
    expect(derive({ history: recent }).map((c) => c.kind)).toEqual([
      "previous_period",
      "widen_window",
    ]);
  });

  it("offers no period before when the record starts inside the window, or without its history", () => {
    // The first reading is 17 days old: the 30 days before this window hold
    // nothing to compare with.
    const recent: FollowUpHistory = {
      today: "2026-09-27",
      firstDate: { bp: "2026-09-10" },
    };
    expect(derive({ history: recent })).toEqual([]);
    expect(derive()).toEqual([]);
  });

  it("offers no year ago over a year-long window, and nothing history-based from all time", () => {
    const year = derive({
      results: [table("bp", {}, "lastYear")],
      history: LONG_HISTORY,
    });
    expect(year.map((c) => c.kind)).toEqual([
      "previous_period",
      "widen_window",
    ]);
    // All time has no period before it: the table tool would read the same
    // table again.
    const all = derive({
      results: [table("bp", {}, "allTime")],
      history: LONG_HISTORY,
    });
    expect(all).toEqual([]);
  });

  it("offers the chart back for a table shown as a table", () => {
    const chips = derive({
      results: [
        table("bp", { chartKind: "line", displayed: true, view: "table" }),
      ],
    });
    expect(chips[0]).toMatchObject({ kind: "as_chart", reuse: true });
  });

  it("offers the other view of a table that has a chart, as a reuse chip", () => {
    const shown = derive({
      results: [table("bp", { chartKind: "line", displayed: true })],
    });
    expect(shown[0]).toMatchObject({ kind: "as_table", reuse: true });
    const tucked = derive({
      results: [table("bp", { chartKind: "line", displayed: false })],
    });
    expect(tucked[0]).toMatchObject({ kind: "as_chart", reuse: true });
    expect(derive().some((c) => c.reuse)).toBe(false);
  });

  it("offers a related metric only for a pair whose partner the record holds", () => {
    const pairs: CorrelationPair[] = [{ a: "sleep", b: "bp" }];
    const steps = [
      step("bp"),
      step("correlations", { id: "s2", resultRef: undefined }),
    ];
    const chips = derive({ steps, correlations: pairs });
    const related = chips.find((c) => c.kind === "related_metric");
    expect(related).toMatchObject({
      label: "See also: Sleep",
      anchor: { domain: "sleep" },
    });
    const without = derive({
      steps,
      correlations: pairs,
      inventory: present("bp"),
    });
    expect(without.some((c) => c.kind === "related_metric")).toBe(false);
  });

  it("offers nothing for a table the table tool cannot fetch again, or a shape without periods", () => {
    expect(
      derive({ results: [table("glucose")], steps: [step("glucose")] }),
    ).toEqual([]);
    expect(
      derive({ results: [table("bp", { shape: "categoryCounts" })] }),
    ).toEqual([]);
    expect(
      derive({
        results: [
          table("bp", {
            source: { ...table("bp").source, period: "previous" },
          }),
        ],
      }),
    ).toEqual([]);
  });
});

describe("deriveFollowUps — absence never becomes a chip", () => {
  it("offers nothing when the turn read nothing", () => {
    expect(derive({ results: [], steps: [] })).toEqual([]);
  });

  it("offers nothing for a metric the record does not hold", () => {
    expect(derive({ inventory: present("weight") })).toEqual([]);
  });

  it("offers nothing on the no-tools path but the other view of a table", () => {
    expect(derive({ inventory: null })).toEqual([]);
  });

  it("offers nothing for an empty or failed read", () => {
    for (const status of ["empty", "failed", "running"] as const) {
      expect(derive({ results: [], steps: [step("bp", { status })] })).toEqual(
        [],
      );
    }
  });
});

describe("deriveFollowUps — proposals, cap and pref", () => {
  it("lets a proposal lead only when the rules allow the same chip", () => {
    const chips = derive({
      history: LONG_HISTORY,
      proposals: [
        { kind: "widen_window", domain: "bp" },
        // Not read this turn: ignored.
        { kind: "previous_period", domain: "weight" },
        // Read, but nothing to chart: ignored.
        { kind: "as_chart", domain: "bp" },
      ],
    });
    expect(chips.map((c) => [c.kind, c.origin])).toEqual([
      ["widen_window", "model"],
      ["previous_period", "server"],
      ["year_ago", "server"],
    ]);
    expect(chips.map((c) => c.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("never offers more than three", () => {
    const chips = derive({
      results: [
        table("bp", { chartKind: "line" }),
        table("weight", { ref: "r2" }),
      ],
      steps: [step("bp"), step("weight", { id: "s2", resultRef: "r2" })],
      history: LONG_HISTORY,
    });
    expect(chips).toHaveLength(3);
  });

  it("offers nothing when the pref is off", () => {
    expect(
      derive({
        prefs: { ...DEFAULT_COACH_PREFS, followUpChips: false },
        history: LONG_HISTORY,
      }),
    ).toEqual([]);
  });
});

// ── Property: every chip is grounded in this turn ─────────────────────────

const DOMAINS: CoachScopeSource[] = [
  "bp",
  "weight",
  "sleep",
  "glucose",
  "steps",
  "mood",
];
const WINDOWS: CoachScopeWindow[] = [
  "last7days",
  "last30days",
  "last90days",
  "lastYear",
  "allTime",
];
const STATUSES = ["done", "empty", "failed", "running"] as const;

/** Deterministic PRNG so a failure reproduces from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("deriveFollowUps — property: every chip's domain was read this turn", () => {
  it("holds over generated turns", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
      const steps: CoachStep[] = [];
      const results: CoachResultMeta[] = [];
      const n = Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const domain = pick(DOMAINS);
        const status = pick(STATUSES);
        const ref = `r${i + 1}`;
        steps.push(step(domain, { id: `s${i + 1}`, status, resultRef: ref }));
        if (status === "done" && r() < 0.8) {
          results.push(
            table(
              domain,
              {
                ref,
                chartKind: r() < 0.5 ? "line" : null,
                displayed: r() < 0.5,
                shape: r() < 0.8 ? "timeSeries" : "categoryCounts",
              },
              pick(WINDOWS),
            ),
          );
        }
      }
      if (r() < 0.4) {
        steps.push(step("correlations", { id: "s9", resultRef: undefined }));
      }
      const correlations: CorrelationPair[] =
        r() < 0.5 ? [{ a: pick(DOMAINS), b: pick(DOMAINS) }] : [];
      const inventory = present(...DOMAINS.filter(() => r() < 0.6));
      const history: FollowUpHistory = {
        today: "2026-09-27",
        firstDate: Object.fromEntries(
          DOMAINS.map((d) => [d, r() < 0.5 ? "2020-01-01" : "2026-09-20"]),
        ),
      };
      const proposals = [
        { kind: "previous_period" as const, domain: pick(DOMAINS) },
        { kind: "related_metric" as const, domain: pick(DOMAINS) },
      ];

      const chips = derive({
        results,
        steps,
        inventory,
        history,
        correlations,
        proposals,
      });

      const done = new Set(
        steps.filter((s) => s.status === "done").map((s) => s.domain),
      );
      const stored = new Set(results.map((m) => m.source.domain));
      const held = new Set(inventory.map((e) => e.metric as CoachStepDomain));
      expect(chips.length, `seed ${seed}`).toBeLessThanOrEqual(3);
      expect(new Set(chips.map((c) => c.id)).size).toBe(chips.length);
      for (const chip of chips) {
        const domain = chip.anchor?.domain;
        expect(domain, `seed ${seed}`).toBeDefined();
        if (chip.kind === "related_metric") {
          // The partner came from a pair this turn's correlations read
          // returned, linked to a metric the turn read, and the record
          // holds it.
          expect(done.has("correlations") || correlations.length > 0).toBe(
            true,
          );
          expect(
            correlations.some(
              (p) =>
                (p.a === domain && done.has(p.b)) ||
                (p.b === domain && done.has(p.a)),
            ),
            `seed ${seed}`,
          ).toBe(true);
          expect(held.has(domain!), `seed ${seed}`).toBe(true);
        } else {
          expect(done.has(domain!) || stored.has(domain!), `seed ${seed}`).toBe(
            true,
          );
        }
        if (!chip.reuse) {
          expect(held.has(domain!), `seed ${seed}`).toBe(true);
        }
      }
    }
  });
});

describe("correlationPartners", () => {
  function correlations(drivers: unknown): SettledToolCall {
    return {
      name: "get_correlations",
      result: { present: true, data: { drivers } },
    };
  }

  it("maps measurement channel labels back to their metrics", () => {
    expect(
      correlationPartners([
        correlations([
          { behaviour: "sleep duration", outcome: "blood pressure sys" },
          { behaviour: "activity steps", outcome: "mood" },
        ]),
      ]),
    ).toEqual([
      { a: "sleep", b: "bp" },
      { a: "steps", b: "mood" },
    ]);
  });

  it("ignores channels that name no metric, and absent results", () => {
    expect(
      correlationPartners([
        correlations([
          { behaviour: "medication adherence", outcome: "weight" },
          { behaviour: "my custom thing", outcome: "weight" },
        ]),
        { name: "get_correlations", result: { present: false } },
        { name: "get_sleep", result: { present: true, data: {} } },
      ]),
    ).toEqual([]);
  });
});
