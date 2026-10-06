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

describe("memory contract", () => {
  it("answers through the implementations, not the old stubs", async () => {
    const [block, remember, plan, progress] = await Promise.all([
      import("../context-block"),
      import("../remember"),
      import("../propose-plan"),
      import("../plan-progress"),
    ]);
    expect(buildMemoryContextBlock).toBe(block.buildMemoryContextBlock);
    expect(rememberFactFromTool).toBe(remember.rememberFactFromTool);
    expect(decideFactProposal).toBe(remember.decideFactProposal);
    expect(proposePlanFromTool).toBe(plan.proposePlanFromTool);
    expect(decidePlanProposal).toBe(plan.decidePlanProposal);
    expect(buildPlanProgressLines).toBe(progress.buildPlanProgressLines);
  });

  it("keeps the client-safe half free of server imports", () => {
    const source = readFileSync(join(__dirname, "../shared.ts"), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]+;/gm)];
    for (const statement of imports) {
      expect(statement[1], statement[0]).toBe("type ");
    }
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

  it("a proposal has its own source and never reads as a known fact", () => {
    expect(COACH_FACT_SOURCES).toContain("proposed");
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
