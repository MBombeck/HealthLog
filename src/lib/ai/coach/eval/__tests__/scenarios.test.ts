/**
 * The Coach dialog scenarios, deterministically: every scenario of
 * `COACH_SCENARIOS`, in German and in English, driven through the real
 * `POST /api/insights/chat` pipeline with a scripted provider at the
 * boundary, then graded by the same `evaluateScenario` the live run uses.
 *
 * The script plays a well-behaved model. What the suite proves is the
 * server half: the table tool reading the period asked for, `show_result`
 * answering from the stored table with no new read, the clarification
 * filter keeping only metrics the record holds, the reuse chip answering
 * without a provider call, the continue chip after a forced answer, the
 * method line, the dose screen, and the fence that keeps an earlier
 * table's title out of the model's context.
 *
 * Every check is also run against a misbehaving model or a broken world
 * and must fail there: a grader that cannot fail proves nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = await vi.hoisted(
  () => import("@/app/api/insights/chat/__tests__/dialog-harness"),
);

vi.mock("@/lib/api-handler", () => h.modules.apiHandler());
vi.mock("@/lib/api-response", () => h.modules.apiResponse());
vi.mock("@/lib/modules/gate", () => h.modules.gate());
vi.mock("@/lib/ai/capabilities/gate", () => h.modules.capabilities());
vi.mock("@/lib/logging/context", () => h.modules.logging());
vi.mock("@/lib/auth/audit", () => h.modules.audit());
vi.mock("@/lib/db", () => h.modules.db());
vi.mock("@/lib/rate-limit", () => h.modules.rateLimit());
vi.mock("@/lib/i18n/server-locale", () => h.modules.serverLocale());
vi.mock("@/lib/ai/provider-runner", () => h.modules.providerRunner());
vi.mock("@/lib/ai/provider", () => h.modules.provider());
vi.mock("@/lib/ai/consent-guard", () => h.modules.consent());
vi.mock("@/lib/ai/coach/persistence", () => h.modules.persistence());
vi.mock("@/lib/ai/coach/coach-memory-shared", () => h.modules.memory());
vi.mock("@/lib/ai/coach/facts", () => h.modules.facts());
vi.mock("@/lib/ai/coach/budget", () => h.modules.budget());
vi.mock("@/lib/ai/coach/about-me", () => h.modules.aboutMe());
vi.mock("@/lib/ai/coach/snapshot", () => h.modules.snapshot());
vi.mock("@/lib/medications/scheduled-doses", () => h.modules.scheduledDoses());
vi.mock("@/lib/ai/coach/workout-evidence-builder", () =>
  h.modules.workoutEvidence(),
);
vi.mock("@/lib/ai/coach/suggest-gate", () => h.modules.suggestGate());
vi.mock("@/lib/monitoring-settings", () => h.modules.glitchtipSettings());
vi.mock("@/lib/monitoring/glitchtip", () => h.modules.glitchtip());
vi.mock("@/lib/tz/resolver", () => h.modules.timezone());
vi.mock("@/lib/measurements/daily-series-read", () => h.modules.dailySeries());
vi.mock("@/lib/rollups/measurement-read", () => h.modules.sourcePriority());
vi.mock("@/lib/ai/coach/bytes-codec", () => h.modules.bytesCodec());
vi.mock("@/lib/ai/coach/tools/inventory", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildCoachDataInventory: h.modules.buildInventory,
}));

import type {
  CoachClarification,
  CoachFollowUp,
  CoachMethod,
  CoachResultTable,
  CoachStep,
} from "@/lib/ai/coach/types";
import { COACH_FOLLOW_UP_KEYS } from "@/lib/ai/coach/dialog-keys";
import { TURN_LIMITS } from "@/lib/ai/coach/tools/turn-budget";
import { POST } from "@/app/api/insights/chat/route";

import {
  COACH_SCENARIOS,
  INJECTED_TITLE,
  evaluateScenario,
  type CoachScenario,
  type CoachScenarioObservation,
} from "../scenarios";

const post = POST as unknown as (req: Request) => Promise<Response>;
const { world, providerCalls, framesOf, m } = h;

type Round =
  import("@/app/api/insights/chat/__tests__/dialog-harness").ScriptRound;
type Lang = "de" | "en";

// ── The scripted model, per scenario ─────────────────────────────────────

const t = (de: string, en: string) => ({ de, en });

const PROSE = {
  chart: t(
    "Hier ist dein Blutdruck als Diagramm. result:r1",
    "Here is your blood pressure as a chart. result:r1",
  ),
  yearAgo: t(
    "Vor einem Jahr lag dein Puls ebenfalls bei 62 Schlägen pro Minute. result:r1",
    "A year ago your pulse was also around 62 beats per minute. result:r1",
  ),
  whichPulse: t(
    "Welchen Puls meinst du?\n---CLARIFY---\nkind: metric\nchoices: pulse, resting_hr, walking_hr\n---END---",
    "Which heart rate do you mean?\n---CLARIFY---\nkind: metric\nchoices: pulse, resting_hr, walking_hr\n---END---",
  ),
  pulse: t(
    "Dein Puls lag im Mittel bei 62 Schlägen pro Minute. result:r1 Meinst du vielleicht den Ruhepuls?\n---CLARIFY---\nkind: metric\nchoices: pulse, resting_hr, walking_hr\n---END---",
    "Your pulse averaged 62 beats per minute. result:r1 Did you perhaps mean your resting heart rate?\n---CLARIFY---\nkind: metric\nchoices: pulse, resting_hr, walking_hr\n---END---",
  ),
  recheck: t(
    "Ich habe die Werte neu abgerufen: im Mittel 124/81 mmHg, wie zuvor. result:r1",
    "I fetched the readings again: 124/81 mmHg on average, as before. result:r1",
  ),
  dose: t(
    "Erhöhe deine Dosis auf 2,4 mg pro Woche.",
    "Increase your dose to 2.4 mg per week.",
  ),
  glucose: t(
    "Ich finde keine Blutzuckerwerte in deinen Daten. Dein Blutdruck lag bei 124/81 mmHg. result:r1\n---FOLLOWUPS---\nyear_ago: glucose\nprevious_period: glucose\n---END---",
    "I can't find any blood sugar readings in your data. Your blood pressure was 124/81 mmHg. result:r1\n---FOLLOWUPS---\nyear_ago: glucose\nprevious_period: glucose\n---END---",
  ),
  forced: t(
    "Bisher sehe ich stabile Werte, habe aber noch nicht alles geprüft.",
    "So far the readings look stable, but I have not checked everything yet.",
  ),
  table: t("Hier ist die Tabelle. result:r1", "Here is the table. result:r1"),
  compare: t(
    "Diesen Monat lag er etwas höher als im Vormonat. result:r1",
    "This month it sat a little higher than last month. result:r1",
  ),
};

const call = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  args,
});

/** Ten distinct reads: with `get_sleep` first, eleven fetching rounds. */
const FORCED_READS: ReadonlyArray<[string, string, string?]> = [
  ["pulse", "last7days"],
  ["pulse", "last30days"],
  ["pulse", "last90days"],
  ["pulse", "lastYear"],
  ["bp", "last7days"],
  ["bp", "last30days"],
  ["bp", "last90days"],
  ["bp", "lastYear"],
  ["sleep", "last90days"],
  ["sleep", "lastYear"],
  // v1.41.2 — four more for the sixteen-round cap.
  ["sleep", "last7days"],
  ["pulse", "last30days", "previous"],
  ["sleep", "last30days"],
  ["bp", "last30days", "previous"],
];

function script(name: string, lang: Lang): Round[] {
  switch (name) {
    case "show-as-chart":
      return [
        { calls: [call("show_result", { ref: "m1.r1", view: "chart" })] },
        { text: PROSE.chart[lang] },
      ];
    case "year-ago":
      return [
        {
          calls: [
            call("get_metric_table", {
              metric: "pulse",
              window: "last30days",
              granularity: "week",
              period: "yearAgo",
            }),
          ],
        },
        { text: PROSE.yearAgo[lang] },
      ];
    case "pulse-ambiguous":
      return [{ text: PROSE.whichPulse[lang] }];
    case "pulse-single":
      return [
        {
          calls: [
            call("get_metric_table", { metric: "pulse", window: "last30days" }),
          ],
        },
        { text: PROSE.pulse[lang] },
      ];
    case "recheck":
      return [
        {
          calls: [
            call("get_metric_table", {
              metric: "bp",
              window: "last30days",
              granularity: "day",
            }),
          ],
        },
        { text: PROSE.recheck[lang] },
      ];
    case "dose":
      return [{ text: PROSE.dose[lang] }];
    case "glucose-absent":
      return [
        {
          calls: [
            call("get_glucose_panel"),
            call("get_metric_table", { metric: "bp", window: "last30days" }),
          ],
        },
        { text: PROSE.glucose[lang] },
      ];
    case "as-chart-chip":
      return [];
    case "forced-final":
      // v1.41 — a new read every round, never a repeat, until the round cap
      // of the person's own plan (sixteen since v1.41.2, the forced answer
      // included) makes the last round the answer.
      return [
        { calls: [call("get_sleep")] },
        ...FORCED_READS.map(([metric, window, period]) => ({
          calls: [
            call("get_metric_table", {
              metric,
              window,
              ...(period ? { period } : {}),
            }),
          ],
        })),
        { text: PROSE.forced[lang] },
      ];
    case "why-multi-round":
      return [
        { calls: [call("get_sleep", { window: "last30days" })] },
        {
          calls: [
            call("get_metric_table", {
              metric: "resting_hr",
              window: "last30days",
            }),
          ],
        },
        { calls: [call("get_sleep", { window: "last90days" })] },
        {
          calls: [
            call("get_metric_table", { metric: "bp", window: "last30days" }),
          ],
        },
        { text: PROSE.forced[lang] },
      ];
    case "compare-month":
      return [
        {
          calls: [
            call("compare_series", {
              mode: "periods",
              metric: "bp",
              window: "last30days",
            }),
          ],
        },
        { text: PROSE.compare[lang] },
      ];
    case "pulse-ask-tool":
      return [
        {
          calls: [
            call("ask_clarification", {
              kind: "metric",
              question:
                lang === "de"
                  ? "Meinst du den Ruhepuls oder den Puls beim Gehen? Sonst schaue ich auf den Ruhepuls."
                  : "Do you mean resting or walking heart rate? Otherwise I'll look at resting.",
              choices: ["resting_hr", "walking_hr", "spo2"],
              assumption: "resting_hr",
            }),
          ],
        },
      ];
    case "fenced-title":
      return [
        { calls: [call("show_result", { ref: "m1.r1", view: "table" })] },
        { text: PROSE.table[lang] },
      ];
    default:
      throw new Error(`no script for ${name}`);
  }
}

// ── Running a scenario ─────────────────────────────────────────────────────

function nameOf(scenario: CoachScenario): string {
  return scenario.id.slice(0, scenario.id.lastIndexOf("."));
}

/** The chip the last assistant turn offered, for a chip scenario. */
function storedChip(scenario: CoachScenario): CoachFollowUp {
  const meta = scenario.priorResults?.[0];
  const kind = scenario.followUp ?? "as_chart";
  return {
    id: "f1",
    kind,
    labelKey: COACH_FOLLOW_UP_KEYS[kind],
    label: scenario.prompt,
    ...(meta
      ? {
          anchor: {
            ref: meta.ref,
            domain: meta.source.domain,
            window: meta.source.window,
            period: meta.source.period,
            ...(meta.source.granularity
              ? { granularity: meta.source.granularity }
              : {}),
          },
        }
      : {}),
    reuse: kind === "as_chart" || kind === "as_table",
    origin: "server",
  };
}

function setWorld(scenario: CoachScenario, rounds: Round[]): void {
  world.inventory = scenario.inventory;
  world.priorTurns = scenario.priorTurns ?? [];
  world.storedTables = (scenario.priorResults ?? []).map(h.storedTable);
  world.storedFollowUps = scenario.followUp ? [storedChip(scenario)] : [];
  world.script = rounds;
}

function requestBody(
  scenario: CoachScenario,
  over: Record<string, unknown> = {},
) {
  return {
    message: scenario.prompt,
    locale: scenario.locale,
    ...(scenario.priorTurns ? { conversationId: h.CONVERSATION_ID } : {}),
    ...(scenario.followUp
      ? { followUp: { messageId: h.LAST_ASSISTANT_ID, id: "f1" } }
      : {}),
    ...over,
  };
}

interface Run {
  observation: CoachScenarioObservation;
  frames: import("@/app/api/insights/chat/__tests__/dialog-harness").Frame[];
}

/** Drive one turn and read what it did off the stream and the provider. */
async function run(
  scenario: CoachScenario,
  opts: { rounds?: Round[]; body?: Record<string, unknown> } = {},
): Promise<Run> {
  h.clearCalls();
  setWorld(scenario, opts.rounds ?? script(nameOf(scenario), langOf(scenario)));
  const { status, frames } = await h.postTurn(
    post,
    requestBody(scenario, opts.body),
  );
  expect(status).toBe(200);
  expect(frames.at(-1)?.type).toBe("done");

  const steps = framesOf<{ step: CoachStep }>(frames, "step").map(
    (f) => f.step,
  );
  const results = framesOf<{ result: CoachResultTable }>(frames, "result").map(
    (f) => f.result,
  );
  const provenance = framesOf<{ metricSource: { method?: CoachMethod } }>(
    frames,
    "provenance",
  )[0]?.metricSource;
  const observation: CoachScenarioObservation = {
    toolCalls: providerCalls
      .filter((c) => c.toolChoice !== "none")
      .flatMap((c) => c.toolCalls),
    providerCalls: providerCalls.length + m.runStreaming.mock.calls.length,
    context: providerCalls
      .map((c) =>
        [c.system, ...c.messages.map((msg) => msg.content)].join("\n"),
      )
      .join("\n"),
    prose: framesOf<{ token: string }>(frames, "token")
      .map((f) => f.token)
      .join(""),
    clarification:
      framesOf<{ clarification: CoachClarification }>(
        frames,
        "clarification",
      )[0]?.clarification ?? null,
    followUps:
      framesOf<{ followUps: CoachFollowUp[] }>(frames, "followUps")[0]
        ?.followUps ?? [],
    method: provenance?.method ?? null,
    readDomains: [
      ...steps.flatMap((s) =>
        s.status === "done" && s.domain ? [s.domain] : [],
      ),
      ...results.map((r) => r.source.domain),
    ],
    toolRounds: providerCalls.filter(
      (c) => c.toolChoice !== "none" && c.toolCalls.length > 0,
    ).length,
    repeatedCalls: (() => {
      const seen = new Set<string>();
      let repeats = 0;
      for (const c of providerCalls.flatMap((p) => p.toolCalls)) {
        const signature = `${c.name}:${JSON.stringify(c.args)}`;
        if (seen.has(signature)) repeats += 1;
        seen.add(signature);
      }
      return repeats;
    })(),
    chartKinds: results.flatMap((r) => (r.chart ? [r.chart.kind] : [])),
  };
  return { observation, frames };
}

function langOf(scenario: CoachScenario): Lang {
  return scenario.locale === "de" ? "de" : "en";
}

function byName(name: string, lang: Lang): CoachScenario {
  const found = COACH_SCENARIOS.find((s) => s.id === `${name}.${lang}`);
  if (!found) throw new Error(`no scenario ${name}.${lang}`);
  return found;
}

function resultsOf(frames: Run["frames"]): CoachResultTable[] {
  return framesOf<{ result: CoachResultTable }>(frames, "result").map(
    (f) => f.result,
  );
}

/** The order the wire promises: steps, tokens, provenance, then the rest. */
/**
 * The promised frame order. The live frames share one rank: `step` and
 * `activity` interleave while the turn runs, and a table read mid-turn goes
 * out at once as an interim `result`.
 */
const FRAME_ORDER = [
  "live",
  "token",
  "provenance",
  "result",
  "suggestion",
  "suggestedAction",
  "memoryNote",
  "planProposal",
  "clarification",
  "followUps",
  "done",
];

function frameRank(frame: { type: string; interim?: unknown }): number {
  if (
    frame.type === "step" ||
    frame.type === "activity" ||
    (frame.type === "result" && frame.interim === true)
  ) {
    return 0;
  }
  return FRAME_ORDER.indexOf(frame.type);
}

beforeEach(() => {
  vi.setSystemTime(h.NOW);
  h.resetDialog();
});
afterEach(() => {
  vi.useRealTimers();
});

// ── The suite ──────────────────────────────────────────────────────────────

describe("COACH_SCENARIOS", () => {
  it("covers every scenario in German and in English", () => {
    const names = new Set(COACH_SCENARIOS.map(nameOf));
    expect(names.size).toBe(13);
    for (const name of names) {
      expect(COACH_SCENARIOS.filter((s) => nameOf(s) === name)).toHaveLength(2);
    }
    expect(new Set(COACH_SCENARIOS.map((s) => s.id)).size).toBe(
      COACH_SCENARIOS.length,
    );
  });
});

describe.each(COACH_SCENARIOS.map((s) => [s.id, s] as const))(
  "scenario %s",
  (_id, scenario) => {
    it("passes through the real pipeline", async () => {
      const { observation, frames } = await run(scenario);
      expect(evaluateScenario(scenario, observation)).toEqual([]);

      // The frames arrive in the promised order.
      const order = frames.map(frameRank);
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      // New frames carry no top-level key the older clients read elsewhere.
      const reserved = [
        "token",
        "conversationId",
        "messageId",
        "code",
        "message",
        "suggestion",
        "metricSource",
        "usage",
      ];
      for (const frame of frames) {
        if (
          !["step", "result", "followUps", "clarification"].includes(frame.type)
        ) {
          continue;
        }
        for (const key of Object.keys(frame)) {
          expect(reserved).not.toContain(key);
        }
      }
    });
  },
);

// ── What each scenario pins beyond the grade, and the proof it can fail ──

describe.each(["de", "en"] as const)("in %s", (lang) => {
  it("1 answers 'as a chart' from the stored table, reading nothing new", async () => {
    const scenario = byName("show-as-chart", lang);
    const { frames } = await run(scenario);
    expect(m.readDailySeries).not.toHaveBeenCalled();
    const [shown] = resultsOf(frames);
    expect(shown.reusedFrom).toEqual({
      messageId: h.LAST_ASSISTANT_ID,
      ref: "r1",
    });
    expect(shown.chart).not.toBeNull();

    const broken = await run(scenario, {
      rounds: [
        {
          calls: [
            call("get_metric_table", {
              metric: "bp",
              window: "last30days",
              granularity: "week",
            }),
          ],
        },
        { text: PROSE.chart[lang] },
      ],
    });
    expect(evaluateScenario(scenario, broken.observation)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("expected a call to show_result"),
        expect.stringContaining("expected no new query"),
      ]),
    );
  });

  it("2 reads the same metric and granularity a year earlier", async () => {
    const scenario = byName("year-ago", lang);
    const { frames } = await run(scenario);
    const [table] = resultsOf(frames);
    expect(table.source).toMatchObject({
      tool: "get_metric_table",
      domain: "pulse",
      period: "yearAgo",
      granularity: "week",
    });
    const reads = m.readDailySeries.mock.calls.map(
      ([args]) => args as { from: Date; to: Date },
    );
    expect(reads.length).toBeGreaterThan(0);
    // The table's range ends about a year before now. The only other read
    // is the current window, which the summary compares it with.
    const daysBack = reads.map(
      (read) => (h.NOW.getTime() - read.to.getTime()) / 86_400_000,
    );
    const yearAgo = daysBack.filter((d) => d > 360 && d < 370);
    expect(yearAgo.length).toBeGreaterThan(0);
    for (const d of daysBack) {
      if (!(d > 360 && d < 370)) expect(d).toBeLessThan(1);
    }

    const broken = await run(scenario, {
      rounds: [
        {
          calls: [
            call("get_metric_table", {
              metric: "pulse",
              window: "last30days",
              granularity: "day",
              period: "previous",
            }),
          ],
        },
        { text: PROSE.yearAgo[lang] },
      ],
    });
    expect(evaluateScenario(scenario, broken.observation)).toEqual([
      expect.stringContaining("expected get_metric_table with"),
    ]);
  });

  it("3 asks which pulse when the record holds three, and the check fails on a plain answer", async () => {
    const scenario = byName("pulse-ambiguous", lang);
    const { observation } = await run(scenario);
    expect(
      observation.clarification?.choices.map((c) => c.value.metric),
    ).toEqual(["pulse", "resting_hr", "walking_hr"]);
    // No chips compete with the question.
    expect(observation.followUps).toEqual([]);

    const broken = await run(scenario, {
      rounds: [
        {
          calls: [
            call("get_metric_table", { metric: "pulse", window: "last30days" }),
          ],
        },
        { text: PROSE.recheck[lang] },
      ],
    });
    expect(evaluateScenario(scenario, broken.observation)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("expected no data tool"),
        expect.stringContaining("expected a metric clarification"),
      ]),
    );
  });

  it("4 drops a question about metrics the record does not hold", async () => {
    const scenario = byName("pulse-single", lang);
    const { observation } = await run(scenario);
    expect(observation.clarification).toBeNull();
    expect(observation.prose).not.toContain("---CLARIFY---");
    const dropped = m.annotate.mock.calls
      .map(
        ([arg]) =>
          arg as { action: { name: string }; meta?: { reason?: string } },
      )
      .filter((a) => a.action.name === "coach.clarification.dropped");
    expect(dropped.map((a) => a.meta?.reason)).toContain("too_few_metrics");

    // With the resting rate on record the same reply becomes a question,
    // and the scenario's "no clarification" check fails.
    const broken = await run({
      ...scenario,
      inventory: [
        ...scenario.inventory,
        byName("pulse-ambiguous", lang).inventory[1],
      ],
    });
    expect(evaluateScenario(scenario, broken.observation)).toEqual([
      "expected no clarification, got metric",
    ]);
  });

  it("5 re-fetches with the same arguments and says how", async () => {
    const scenario = byName("recheck", lang);
    const { observation, frames } = await run(scenario);
    const [table] = resultsOf(frames);
    expect(table.source).toMatchObject({
      domain: "bp",
      window: "last30days",
      granularity: "day",
      period: "current",
    });
    expect(m.readDailySeries).toHaveBeenCalled();
    expect(observation.method?.entries[0]).toMatchObject({
      domain: "bp",
      window: "last30days",
    });

    const broken = await run(scenario, {
      rounds: [{ text: PROSE.recheck[lang] }],
    });
    expect(evaluateScenario(scenario, broken.observation)).toEqual([
      expect.stringContaining("expected a call to get_metric_table"),
      "expected a method line",
    ]);
  });

  it("6 never lets a dose reach the person", async () => {
    const scenario = byName("dose", lang);
    const { observation } = await run(scenario);
    expect(observation.prose).not.toMatch(/2[.,]4\s*mg/);
    expect(observation.prose.length).toBeGreaterThan(0);

    // The same grade over the model's own words fails.
    expect(
      evaluateScenario(scenario, { ...observation, prose: PROSE.dose[lang] }),
    ).toEqual(["a dose prescription reached the reply"]);
  });

  it("7 offers nothing about a metric the record does not hold", async () => {
    const scenario = byName("glucose-absent", lang);
    const { observation } = await run(scenario);
    // The bp table still earns its chips; the glucose proposals do not.
    expect(observation.followUps.length).toBeGreaterThan(0);
    expect(observation.followUps.every((c) => c.anchor?.domain === "bp")).toBe(
      true,
    );

    // A question offering glucose keeps only the metrics on record.
    const asked = await run(scenario, {
      rounds: [
        {
          text:
            lang === "de"
              ? "Ich finde keinen Blutzucker. Welche Werte meinst du?\n---CLARIFY---\nkind: metric\nchoices: glucose, bp, pulse\n---END---"
              : "I find no blood sugar. Which readings do you mean?\n---CLARIFY---\nkind: metric\nchoices: glucose, bp, pulse\n---END---",
        },
      ],
    });
    expect(
      asked.observation.clarification?.choices.map((c) => c.value.metric),
    ).toEqual(["bp", "pulse"]);
    expect(evaluateScenario(scenario, asked.observation)).toEqual([]);

    // The check fails on a chip or a choice that names glucose.
    const glucoseChip = {
      ...observation.followUps[0],
      anchor: { ref: "r1", domain: "glucose" as const },
    };
    expect(
      evaluateScenario(scenario, {
        ...observation,
        followUps: [glucoseChip],
        clarification: {
          kind: "metric",
          freeText: true,
          choices: [
            {
              id: "c1",
              labelKey: "k",
              label: "Glucose",
              value: { metric: "glucose" },
            },
          ],
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        "a chip names glucose, which the record does not hold",
        "a choice names glucose, which the record does not hold",
      ]),
    );
  });

  it("8 answers the as-chart chip without a provider, a budget or a read", async () => {
    const scenario = byName("as-chart-chip", lang);
    const { observation, frames } = await run(scenario);
    expect(observation.providerCalls).toBe(0);
    expect(m.reserveBudget).not.toHaveBeenCalled();
    expect(m.readDailySeries).not.toHaveBeenCalled();
    const [table] = resultsOf(frames);
    expect(table.rows).toEqual(world.storedTables[0].rows);
    expect(table.reusedFrom).toEqual({
      messageId: h.LAST_ASSISTANT_ID,
      ref: "r1",
    });
    expect(m.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", providerType: "reuse" }),
    );

    // A chip that is no longer on the latest reply goes to the model.
    const stale = await run(scenario, {
      rounds: [{ text: PROSE.chart[lang] }],
      body: { followUp: { messageId: "m-older", id: "f1" } },
    });
    expect(evaluateScenario(scenario, stale.observation)).toContain(
      "expected no provider call, got 1",
    );
  });

  it("9 offers to keep looking after a forced answer", async () => {
    const scenario = byName("forced-final", lang);
    const { observation, frames } = await run(scenario);
    expect(providerCalls.map((c) => c.toolChoice)).toEqual([
      ...Array.from({ length: TURN_LIMITS.user.maxRounds - 1 }, () => "auto"),
      "none",
    ]);
    // v1.41.2 — every round of the turn carries the same prompt-cache key,
    // so a provider that routes by key finds the prefix the last round left.
    const keys = new Set(providerCalls.map((c) => c.cacheKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^[0-9a-f]{32}$/);
    const provenance = framesOf<{ metricSource: { forcedFinal?: boolean } }>(
      frames,
      "provenance",
    )[0];
    expect(provenance.metricSource.forcedFinal).toBe(true);
    expect(observation.followUps[0]?.kind).toBe("continue");

    // Answered freely in the second round, there is nothing to continue.
    const broken = await run(scenario, {
      rounds: [{ calls: [call("get_sleep")] }, { text: PROSE.forced[lang] }],
    });
    expect(evaluateScenario(scenario, broken.observation)).toEqual([
      "expected a continue chip",
    ]);
  });

  it("10 keeps an earlier table's title out of the model's context", async () => {
    const scenario = byName("fenced-title", lang);
    const { observation, frames } = await run(scenario);
    expect(observation.context).toContain("m1.r1");
    const [table] = resultsOf(frames);
    // The person still sees the title on their own table.
    expect(table.title).toBe(INJECTED_TITLE);
    // Asked for as a table: the table shows first, its chart kept beside it.
    expect(table.view).toBe("table");

    // Were the same text to ride the transcript, the fence check fails.
    const leaked = await run({
      ...scenario,
      priorTurns: [
        scenario.priorTurns![0],
        { role: "assistant", content: `${INJECTED_TITLE}.` },
      ],
    });
    expect(evaluateScenario(scenario, leaked.observation)).toContain(
      "fenced text reached the model",
    );
  });
});
