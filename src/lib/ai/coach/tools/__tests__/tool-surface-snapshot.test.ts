/**
 * What the Coach offers the model, and where each call lands.
 *
 * Two halves, both pinned to committed files:
 *
 *   1. The tool definitions a tool-mode turn hands the model
 *      (`COACH_TURN_TOOL_DEFS`): names, descriptions, parameter schemas and
 *      their order. They are the stable prompt-cache prefix, so a byte that
 *      moves is a cache miss for every person.
 *   2. The dispatch table: for every tool name the executor knows, the call
 *      reaches the executor that validates with that tool's own schema. Each
 *      name is called with arguments no schema accepts (`[]`), and the
 *      annotation the executor writes names the tool that refused them. A name
 *      routed to the wrong executor, or dropped from the table, changes the
 *      record. The snapshot builder throws, so the one executor that accepts
 *      any arguments (`get_illness_recovery`) answers through the catch.
 */
import { describe, expect, it, vi } from "vitest";

const annotations: Array<{ action: string; tool: unknown; reason: unknown }> =
  [];

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logging/context", () => ({
  annotate: (event: {
    action?: { name?: string };
    meta?: Record<string, unknown>;
  }) => {
    annotations.push({
      action: event.action?.name ?? "",
      tool: event.meta?.tool,
      reason: event.meta?.reason,
    });
  },
}));
vi.mock("@/lib/ai/coach/snapshot", () => ({
  buildCoachSnapshot: async () => {
    throw new Error("snapshot read refused in this test");
  },
}));

import { COACH_TURN_TOOL_DEFS } from "@/lib/ai/coach/turn/model";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import {
  COACH_TOOL_NAMES,
  SHOW_RESULT_TOOL_NAME,
} from "@/lib/ai/coach/tools/definitions";

describe("the Coach tool surface", () => {
  it("offers the model the same definitions", async () => {
    expect(COACH_TURN_TOOL_DEFS.length).toBeGreaterThan(10);
    await expect(
      `${JSON.stringify(COACH_TURN_TOOL_DEFS, null, 2)}\n`,
    ).toMatchFileSnapshot("./__snapshots__/coach-turn-tool-defs.snap");
  });

  it("routes every tool name to its own executor", async () => {
    const names = [
      ...COACH_TOOL_NAMES,
      SHOW_RESULT_TOOL_NAME,
      // Not an executor tool: the loop runs it.
      "compare_series",
      "not_a_tool",
    ];
    const table: Record<string, unknown> = {};
    for (const name of names) {
      annotations.length = 0;
      const result = await executeCoachTool({
        userId: "u1",
        name,
        rawArguments: "[]",
      });
      table[name] = { result, annotations: [...annotations] };
    }
    expect(Object.keys(table).length).toBeGreaterThan(10);
    await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot(
      "./__snapshots__/coach-executor-dispatch.snap",
    );
  });
});
