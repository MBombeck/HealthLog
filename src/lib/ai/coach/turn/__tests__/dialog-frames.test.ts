/**
 * v1.39.4 — the dialog frames go out in the documented order, after the
 * provenance, and a blocked turn carries none of the tables, chips or
 * clarification.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: vi.fn(),
  createConversation: vi.fn(),
}));

import type {
  CoachClarification,
  CoachFollowUp,
  CoachResultTable,
  CoachStreamEvent,
} from "@/lib/ai/coach/types";
import { DEFAULT_COACH_PREFS } from "@/lib/validations/coach-prefs";

import { emitReply } from "../sse";
import { assembleTurnDialog, buildTurnProvenance } from "../provenance";
import { RESULTS_MAX_BYTES } from "@/lib/ai/coach/results/refs";
import type { ModelOutcome } from "../model";
import type { GuardedReply } from "../reply-guards";

const TABLE: CoachResultTable = {
  ref: "r1",
  source: {
    tool: "get_metric_series",
    domain: "bp",
    window: "last30days",
    period: "current",
  },
  shape: "timeSeries",
  titleKey: "coach.result.title.metricByPeriod",
  title: "Blood pressure by day",
  rowCount: 1,
  chartKind: null,
  displayed: false,
  columns: [],
  rows: [["2026-09-01", 128]],
  truncated: false,
  chart: null,
};
const CHIP: CoachFollowUp = {
  id: "f1",
  kind: "as_table",
  labelKey: "coach.followUp.asTable",
  label: "Show as a table",
  reuse: true,
  origin: "server",
};
const CLARIFY: CoachClarification = {
  kind: "window",
  choices: [],
  freeText: true,
};

function collect() {
  const frames: CoachStreamEvent[] = [];
  return {
    frames,
    emitter: {
      emit: (f: CoachStreamEvent) => frames.push(f),
      aborted: () => false,
    },
  };
}

describe("emitReply — dialog frames", () => {
  it("orders token, provenance, result, cards, clarification, followUps, done", async () => {
    const { frames, emitter } = collect();
    await emitReply(
      emitter,
      {
        ok: true,
        replyText: "Steady.",
        provenance: { windows: [], metrics: [] },
        suggestion: { cadenceId: "c", measurementType: "BP", label: "l" },
        action: null,
        results: [TABLE],
        followUps: [CHIP],
        clarification: CLARIFY,
        messageId: "m1",
        totalTokens: 10,
        model: "x",
      },
      "c1",
    );
    expect(frames.map((f) => f.type)).toEqual([
      "token",
      "provenance",
      "result",
      "suggestion",
      "clarification",
      "followUps",
      "done",
    ]);
  });

  it("emits no dialog frame when the turn has none", async () => {
    const { frames, emitter } = collect();
    await emitReply(
      emitter,
      {
        ok: true,
        replyText: "Steady.",
        provenance: { windows: [], metrics: [] },
        suggestion: null,
        action: null,
        results: [],
        followUps: [],
        clarification: null,
        messageId: "m1",
        totalTokens: 0,
        model: null,
      },
      "c1",
    );
    expect(frames.map((f) => f.type)).toEqual(["token", "provenance", "done"]);
  });
});

describe("assembleTurnDialog", () => {
  const model = {
    ok: true,
    steps: [],
    results: [TABLE],
    forcedFinal: false,
    inventory: null,
    declinedClarifications: [],
    memoryNote: null,
    planProposal: null,
  } as unknown as Extract<ModelOutcome, { ok: true }>;
  const reply = (blocked: boolean): GuardedReply =>
    ({
      outboundBlocked: blocked,
      referencedResults: ["r1"],
      followUpProposals: [],
      clarification: blocked ? null : CLARIFY,
      keyValuesSentinel: {
        keyValues: [],
        malformed: false,
        malformedEntries: [],
      },
      groundedFigures: [],
      unverifiedStripped: 0,
    }) as unknown as GuardedReply;

  it("marks a referenced table displayed and keeps its values out of the provenance", () => {
    const dialog = assembleTurnDialog({
      model,
      reply: reply(false),
      prefs: DEFAULT_COACH_PREFS,
      locale: "en",
    });
    expect(dialog.results).toEqual([{ ...TABLE, displayed: true }]);
    const provenance = buildTurnProvenance({
      snapshotProvenance: { windows: [], metrics: [] },
      reply: reply(false),
      suggestion: null,
      action: null,
      toolTrace: [],
      steps: [],
      dialog,
      forcedFinal: true,
    });
    expect(provenance.results?.[0]).not.toHaveProperty("rows");
    expect(provenance.results?.[0]?.displayed).toBe(true);
    expect(provenance.clarification).toEqual(CLARIFY);
    expect(provenance.forcedFinal).toBe(true);
    expect(JSON.stringify(provenance)).not.toContain("128");
  });

  it("streams only the tables the message can keep, so a reload shows the same ones", () => {
    // A year of days with long period keys: two such tables exceed the
    // at-rest ceiling together, one fits.
    const big = (ref: string): CoachResultTable => ({
      ...TABLE,
      ref,
      rowCount: 400,
      rows: Array.from({ length: 400 }, (_, i) => [
        `2026-01-01-${"x".repeat(160)}-${i}`,
        120 + (i % 30),
      ]),
    });
    const tables = [big("r1"), big("r2")];
    expect(JSON.stringify(tables).length).toBeGreaterThan(RESULTS_MAX_BYTES);
    const dialog = assembleTurnDialog({
      model: { ...model, results: tables },
      reply: reply(false),
      prefs: DEFAULT_COACH_PREFS,
      locale: "en",
    });
    expect(dialog.results.map((t) => t.ref)).toEqual(["r1"]);
    const provenance = buildTurnProvenance({
      snapshotProvenance: { windows: [], metrics: [] },
      reply: reply(false),
      suggestion: null,
      action: null,
      toolTrace: [],
      steps: [],
      dialog,
      forcedFinal: false,
    });
    expect(provenance.results?.map((r) => r.ref)).toEqual(["r1"]);
  });

  it("drops tables, chips and clarification on a blocked turn", () => {
    const dialog = assembleTurnDialog({
      model,
      reply: reply(true),
      prefs: DEFAULT_COACH_PREFS,
      locale: "en",
    });
    expect(dialog).toEqual({
      results: [],
      method: null,
      followUps: [],
      clarification: null,
      assumptions: [],
      memoryNote: null,
      planProposal: null,
    });
  });
});
