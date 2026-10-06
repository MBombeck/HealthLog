/**
 * v1.39.4 — result names: `r<n>` within a turn, `m<k>.r<n>` across the
 * turns of one conversation, and the `result:rN` marks in the prose.
 */
import { describe, expect, it } from "vitest";

import type { CoachResultMeta } from "@/lib/ai/coach/types";

import {
  collectPriorResults,
  createResultRefAllocator,
  formatPriorResultRef,
  parsePriorResultRef,
  resolvePriorResultRef,
  stripResultRefs,
} from "../refs";

function meta(ref: string): CoachResultMeta {
  return {
    ref,
    source: {
      tool: "get_metric_table",
      domain: "bp",
      window: "last90days",
      period: "current",
      granularity: "day",
    },
    shape: "timeSeries",
    titleKey: "coach.result.title.byDay",
    title: "Blood pressure by day",
    rowCount: 90,
    chartKind: null,
    displayed: true,
  };
}

describe("createResultRefAllocator", () => {
  it("hands out r1..r8 and then nothing", () => {
    const refs = createResultRefAllocator();
    const issued = Array.from({ length: 10 }, () => refs.next());
    expect(issued).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
      "r8",
      null,
      null,
    ]);
  });
});

describe("prior result names", () => {
  const messages = [
    { id: "u1", role: "user", metricSource: null },
    { id: "a1", role: "assistant", metricSource: { results: [meta("r1")] } },
    { id: "u2", role: "user", metricSource: null },
    { id: "a2", role: "assistant", metricSource: null },
    { id: "u3", role: "user", metricSource: null },
    {
      id: "a3",
      role: "assistant",
      metricSource: { results: [meta("r1"), meta("r2")] },
    },
  ];

  it("numbers assistant messages and keeps only those with tables", () => {
    const prior = collectPriorResults(messages);
    expect(prior.map((p) => [p.messageId, p.turnIndex])).toEqual([
      ["a1", 1],
      ["a3", 3],
    ]);
  });

  it("keeps a table's name when older messages fall out of the loaded window", () => {
    // The same two replies, once in a short conversation and once after 150
    // earlier assistant messages that the turn no longer loads: the names
    // count the whole conversation, so they do not shift turn to turn.
    const prior = collectPriorResults(messages, 150);
    expect(prior.map((p) => [p.messageId, p.turnIndex])).toEqual([
      ["a1", 151],
      ["a3", 153],
    ]);
    expect(resolvePriorResultRef("m153.r2", prior)?.messageId).toBe("a3");
  });

  it("formats and parses m<k>.r<n>", () => {
    expect(formatPriorResultRef(3, "r2")).toBe("m3.r2");
    expect(parsePriorResultRef("m3.r2")).toEqual({ turnIndex: 3, ref: "r2" });
    expect(parsePriorResultRef("m3.r9")).toBeNull();
    expect(parsePriorResultRef("m0.r1")).toBeNull();
    expect(parsePriorResultRef("x3.r1")).toBeNull();
    expect(parsePriorResultRef("m3.r1; drop")).toBeNull();
  });

  it("resolves a name only against this conversation's tables", () => {
    const prior = collectPriorResults(messages);
    expect(resolvePriorResultRef("m3.r2", prior)).toMatchObject({
      messageId: "a3",
      ref: "r2",
    });
    // A name the conversation does not hold resolves to nothing, whatever
    // another conversation might hold under it.
    expect(resolvePriorResultRef("m2.r1", prior)).toBeNull();
    expect(resolvePriorResultRef("m1.r2", prior)).toBeNull();
    expect(resolvePriorResultRef("m3.r1", [])).toBeNull();
  });
});

describe("stripResultRefs", () => {
  it("strips bare, wrapped and spaced marks and lists them once, in order", () => {
    const out = stripResultRefs(
      "Your readings eased (result:r2). The daily table result:r1 shows it; see [result: r2].",
    );
    expect(out.referenced).toEqual(["r2", "r1"]);
    expect(out.prose).toBe(
      "Your readings eased. The daily table shows it; see.",
    );
    expect(out.prose).not.toMatch(/\d/);
  });

  it("is case-insensitive and ignores refs past r8", () => {
    const out = stripResultRefs("See RESULT:R3 and result:r9.");
    expect(out.referenced).toEqual(["r3"]);
    expect(out.prose).toBe("See and.");
  });

  it("returns the prose untouched when there is no mark", () => {
    const prose = "Steady at 128/82  mmHg.\n\nKeep going.";
    expect(stripResultRefs(prose)).toEqual({ prose, referenced: [] });
  });

  it("does not eat a parenthesis it did not open", () => {
    expect(stripResultRefs("(see result:r1)").prose).toBe("(see)");
  });
});
