import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COACH_MEMORY_CATEGORIES } from "@/lib/ai/coach/types";

import {
  COACH_FACT_SOURCES,
  HEALTH_MEMORY_CATEGORIES,
  MEMORY_BLOCK_MAX_CHARS,
  buildMemoryContextBlock,
  buildPlanProgressLines,
  decideFactProposal,
  decidePlanProposal,
  proposePlanFromTool,
  rememberFactFromTool,
} from "../contract";

const IDS = { userId: "u1", conversationId: "c1" };

describe("memory contract stubs", () => {
  it("build no block, write nothing and decide nothing", async () => {
    await expect(
      buildMemoryContextBlock({ ...IDS, locale: "en" }),
    ).resolves.toBeNull();
    await expect(
      rememberFactFromTool({
        ...IDS,
        userMessage: "I want to reach 75 kg by December",
        call: { category: "goal", fact: "Wants 75 kg by December", why: "w" },
      }),
    ).resolves.toEqual({ kind: "declined", reason: "unavailable" });
    await expect(
      decideFactProposal({
        ...IDS,
        messageId: "m1",
        proposalId: "p1",
        accept: true,
      }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      proposePlanFromTool({
        ...IDS,
        call: {
          metric: "WEIGHT",
          ifCue: "after dinner",
          thenAction: "walk",
          reviewInDays: 14,
        },
      }),
    ).resolves.toEqual({ kind: "declined", reason: "unavailable" });
    await expect(
      decidePlanProposal({
        ...IDS,
        messageId: "m1",
        planId: "p1",
        accept: true,
      }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(buildPlanProgressLines("u1")).resolves.toEqual([]);
  });
});

describe("memory contract constants", () => {
  it("health categories are a subset of the memory categories", () => {
    for (const category of HEALTH_MEMORY_CATEGORIES) {
      expect(COACH_MEMORY_CATEGORIES).toContain(category);
    }
    expect([...HEALTH_MEMORY_CATEGORIES].sort()).toEqual([
      "condition",
      "constraint",
      "medication",
    ]);
  });

  it("the column default is one of the sources", () => {
    const schema = readFileSync(
      join(__dirname, "../../../../../../prisma/schema.prisma"),
      "utf8",
    );
    const model = schema.slice(schema.indexOf("model CoachFact {"));
    const match = /source\s+String\s+@default\("(\w+)"\)/.exec(model);
    expect(match?.[1]).toBeDefined();
    expect(COACH_FACT_SOURCES).toContain(match?.[1]);
  });

  it("keeps the memory block small next to the inventory", () => {
    expect(MEMORY_BLOCK_MAX_CHARS).toBeLessThanOrEqual(1_500);
  });
});
