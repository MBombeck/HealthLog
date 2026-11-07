import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";
import { buildMethod, METHOD_MAX_ENTRIES } from "@/lib/ai/coach/method";
import type {
  CoachResultMeta,
  CoachStep,
  CoachStepDomain,
} from "@/lib/ai/coach/types";

function step(partial: Partial<CoachStep> & Pick<CoachStep, "id">): CoachStep {
  return {
    tool: "get_metric_series",
    labelKey: "coach.step.readWindow",
    label: "server label",
    status: "done",
    ...partial,
  };
}

function table(
  ref: string,
  domain: CoachStepDomain,
  over: Partial<CoachResultMeta> = {},
): CoachResultMeta {
  return {
    ref,
    source: {
      tool: "get_metric_series",
      domain,
      window: "last90days",
      period: "current",
      granularity: "week",
    },
    shape: "timeSeries",
    titleKey: "coach.result.title.byWeek",
    title: "t",
    rowCount: 13,
    chartKind: "line",
    displayed: true,
    ...over,
  };
}

describe("buildMethod", () => {
  it("returns null when the turn read nothing", () => {
    expect(buildMethod({ steps: [], results: [], locale: "en" })).toBeNull();
  });

  it("names source, window, count and aggregation", () => {
    const method = buildMethod({
      steps: [
        step({
          id: "s1",
          domain: "bp",
          window: "last90days",
          granularity: "week",
          count: 142,
          resultRef: "r1",
        }),
        step({
          id: "s2",
          tool: "get_sleep",
          domain: "sleep",
          window: "last30days",
          status: "empty",
          reason: "outside_window",
          count: 40,
        }),
      ],
      results: [table("r1", "bp")],
      locale: "en",
    });
    expect(method?.text).toBe(
      "Blood pressure, last 90 days: 142 readings, weekly averages · Sleep, last 30 days: no readings in this window",
    );
    // An absent entry carries no count, even when the step counted the
    // readings the window could not reach.
    expect(method?.entries[1]).toEqual({
      domain: "sleep",
      window: "last30days",
      absent: "outside_window",
    });
  });

  it("keeps the window sentence for a read past the lookback limit", () => {
    const method = buildMethod({
      steps: [
        step({
          id: "s1",
          tool: "get_sleep",
          domain: "sleep",
          window: "last30days",
          status: "empty",
          reason: "outside_reach",
        }),
      ],
      results: [],
      locale: "en",
    });
    expect(method?.text).toBe(
      "Sleep, last 30 days: no readings in this window",
    );
    expect(method?.entries[0]).toEqual({
      domain: "sleep",
      window: "last30days",
      absent: "outside_window",
    });
  });

  it("says totals for a summed metric and a rate for compliance", () => {
    const method = buildMethod({
      steps: [
        step({
          id: "s1",
          domain: "steps",
          window: "last30days",
          count: 30,
          resultRef: "r1",
        }),
        step({
          id: "s2",
          tool: "get_medication_compliance",
          domain: "compliance",
          window: "last30days",
          count: 60,
          resultRef: "r2",
        }),
      ],
      results: [
        table("r1", "steps", {
          source: {
            tool: "get_metric_series",
            domain: "steps",
            window: "last30days",
            period: "current",
            granularity: "day",
          },
        }),
        table("r2", "compliance", {
          source: {
            tool: "get_medication_compliance",
            domain: "compliance",
            window: "last30days",
            period: "current",
            granularity: "day",
          },
        }),
      ],
      locale: "en",
    });
    expect(method?.text).toBe(
      "Steps, last 30 days: 30 readings, daily totals · Adherence, last 30 days: 60 readings, rate",
    );
    expect(method?.entries.map((e) => e.aggregation)).toEqual(["sum", "rate"]);
  });

  it("names the period when it is not the current one", () => {
    const method = buildMethod({
      steps: [
        step({
          id: "s1",
          domain: "pulse",
          window: "last90days",
          period: "yearAgo",
          count: 80,
        }),
      ],
      results: [],
      locale: "en",
    });
    expect(method?.text).toBe(
      "Pulse, last 90 days, a year earlier: 80 readings",
    );
  });

  it("uses the no-window form for a domain read as a whole", () => {
    const method = buildMethod({
      steps: [step({ id: "s1", tool: "get_labs", domain: "labs", count: 5 })],
      results: [],
      locale: "en",
    });
    expect(method?.text).toBe("Lab results: 5 readings");
  });

  it("leaves out running, failed and snapshot steps", () => {
    const method = buildMethod({
      steps: [
        step({
          id: "s1",
          domain: "bp",
          window: "last30days",
          status: "running",
        }),
        step({
          id: "s2",
          domain: "weight",
          window: "last30days",
          status: "failed",
          reason: "retrieval_failed",
        }),
        step({ id: "s3", tool: "snapshot", domain: "snapshot", count: 12 }),
        step({
          id: "s4",
          domain: "hrv",
          window: "last30days",
          status: "empty",
          reason: "invalid_arguments",
        }),
      ],
      results: [],
      locale: "en",
    });
    expect(method).toBeNull();
  });

  it("merges the same read twice into one entry", () => {
    const method = buildMethod({
      steps: [
        step({
          id: "s1",
          domain: "bp",
          window: "last30days",
          status: "empty",
          reason: "no_data",
        }),
        step({ id: "s2", domain: "bp", window: "last30days", count: 20 }),
        step({ id: "s3", domain: "bp", window: "last30days", count: 18 }),
      ],
      results: [],
      locale: "en",
    });
    expect(method?.entries).toEqual([
      { domain: "bp", window: "last30days", count: 20 },
    ]);
  });

  describe("a table shown again (show_result)", () => {
    const reusedStep = (id: string, ref: string, count: number) =>
      step({
        id,
        tool: "show_result",
        labelKey: "coach.step.showResult",
        domain: "bp",
        window: "last90days",
        period: "current",
        granularity: "week",
        count,
        resultRef: ref,
      });
    const reusedTable = (ref: string) =>
      table(ref, "bp", {
        source: {
          tool: "get_metric_table",
          domain: "bp",
          window: "last90days",
          period: "current",
          granularity: "week",
        },
        reusedFrom: { messageId: "msg-1", ref: "r1" },
      });

    it("says the figures come from an earlier answer", () => {
      const method = buildMethod({
        steps: [reusedStep("s1", "r1", 142)],
        results: [reusedTable("r1")],
        locale: "en",
      });
      expect(method?.text).toBe(
        "Blood pressure, last 90 days: 142 readings, weekly averages, from an earlier answer",
      );
      expect(method?.entries).toEqual([
        {
          domain: "bp",
          window: "last90days",
          period: "current",
          granularity: "week",
          count: 142,
          aggregation: "mean",
        },
      ]);
    });

    it("a re-read of the same source is one entry with the fresh count, never a sum and never marked as earlier", () => {
      for (const order of ["reuse-first", "read-first"] as const) {
        const read = step({
          id: "s2",
          tool: "get_metric_table",
          domain: "bp",
          window: "last90days",
          period: "current",
          granularity: "week",
          count: 150,
          resultRef: "r2",
        });
        const reuse = reusedStep("s1", "r1", 142);
        const method = buildMethod({
          steps: order === "reuse-first" ? [reuse, read] : [read, reuse],
          results: [
            reusedTable("r1"),
            table("r2", "bp", {
              source: {
                tool: "get_metric_table",
                domain: "bp",
                window: "last90days",
                period: "current",
                granularity: "week",
              },
            }),
          ],
          locale: "en",
        });
        expect(method?.text, order).toBe(
          "Blood pressure, last 90 days: 150 readings, weekly averages",
        );
        expect(method?.entries, order).toHaveLength(1);
      }
    });

    it("a reused table no step accounts for is marked as well", () => {
      const method = buildMethod({
        steps: [],
        results: [reusedTable("r1")],
        locale: "de",
      });
      expect(method?.text).toBe(
        "Blutdruck, letzte 90 Tage: Wochendurchschnitte, aus einer früheren Antwort",
      );
    });
  });

  it("describes a table no step accounts for", () => {
    const method = buildMethod({
      steps: [],
      results: [
        table("r1", "weight", {
          source: {
            tool: "get_metric_series",
            domain: "weight",
            window: "lastYear",
            period: "current",
            granularity: "month",
          },
        }),
      ],
      locale: "en",
    });
    expect(method?.text).toBe("Weight, last 12 months: monthly averages");
  });

  it("caps the line", () => {
    const domains: CoachStepDomain[] = [
      "bp",
      "pulse",
      "weight",
      "hrv",
      "sleep",
      "steps",
      "mood",
      "glucose",
    ];
    const method = buildMethod({
      steps: domains.map((domain, i) =>
        step({ id: `s${i + 1}`, domain, window: "last30days", count: i + 1 }),
      ),
      results: [],
      locale: "en",
    });
    expect(method?.entries).toHaveLength(METHOD_MAX_ENTRIES);
  });

  it("never carries a health value, whatever the step label says", () => {
    // Property: the only digits in the line are the counts it was given.
    const hostile = "142/88 mmHg, 7.4 mmol/L, eGFR 55";
    for (let seed = 1; seed < 60; seed++) {
      const count = (seed * 37) % 500;
      const method = buildMethod({
        steps: [
          step({
            id: "s1",
            domain: "bp",
            window: "last30days",
            count,
            label: hostile,
            labelKey: hostile,
            resultRef: "r1",
          }),
          step({
            id: "s2",
            tool: "get_labs",
            domain: "labs",
            count: seed,
            label: hostile,
          }),
          step({
            id: "s3",
            domain: "glucose",
            window: "last7days",
            status: "empty",
            reason: "no_data",
            count: 999,
            label: hostile,
          }),
        ],
        results: [table("r1", "bp", { title: hostile, titleKey: hostile })],
        locale: "en",
      })!;
      expect(method.text).not.toContain("mmHg");
      expect(method.text).not.toContain("eGFR");
      const digits = (method.text.match(/\d+/g) ?? []).map(Number);
      // "last 30 days" and "last 7 days" are the window labels.
      const allowed = new Set([count, seed, 30, 7]);
      for (const n of digits) expect(allowed.has(n)).toBe(true);
      expect(digits).not.toContain(999);
    }
  });

  it.each(locales)("renders every string in %s", (locale) => {
    const method = buildMethod({
      steps: [
        step({
          id: "s1",
          domain: "bp",
          window: "last90days",
          granularity: "week",
          count: 2,
          resultRef: "r1",
        }),
        step({
          id: "s2",
          domain: "steps",
          window: "last30days",
          period: "previous",
          count: 1,
          resultRef: "r2",
        }),
        step({ id: "s3", tool: "get_labs", domain: "labs", count: 5 }),
        step({
          id: "s4",
          domain: "sleep",
          window: "last7days",
          status: "empty",
          reason: "no_data",
        }),
        step({
          id: "s5",
          domain: "mood",
          window: "last30days",
          status: "empty",
          reason: "module_disabled",
        }),
        step({
          id: "s6",
          tool: "get_workouts",
          domain: "workouts",
          window: "last30days",
          count: 9,
          resultRef: "r3",
        }),
      ],
      results: [
        table("r1", "bp"),
        table("r2", "steps", {
          source: {
            tool: "get_metric_series",
            domain: "steps",
            window: "last30days",
            period: "previous",
            granularity: "month",
          },
        }),
        table("r3", "workouts", {
          shape: "categoryCounts",
          source: {
            tool: "get_workouts",
            domain: "workouts",
            window: "last30days",
            period: "current",
          },
        }),
      ],
      locale,
    })!;
    expect(method.entries).toHaveLength(6);
    expect(method.text.split(" · ")).toHaveLength(6);
    // No raw key and no unfilled placeholder in any locale.
    expect(method.text).not.toMatch(/coach\.|insights\./);
    expect(method.text).not.toMatch(/[{}]/);
  });
});
