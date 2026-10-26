/**
 * The pieces several MCP read tools share: the Coach-executor bridge, the
 * module gate and its explicit-absence answer, and the visit-text decrypt.
 */
import { annotate } from "@/lib/logging/context";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { isModuleEnabled } from "@/lib/modules/gate";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import type { McpAuthContext } from "../auth";

/**
 * Run one Coach F1 retrieval tool through its executor. The executor re-parses
 * and re-validates the arguments against its own Zod schema, runs the
 * server-authoritative snapshot builder scoped to the requested domain, and
 * returns the grounded `{ present, reason?, data?, grounding? }` result. It
 * never throws and never widens scope.
 *
 * No `reach` is passed, here or at the other MCP call sites: the person's
 * Coach lookback limit (`coachPrefs.defaultWindow`) governs what the Coach
 * reads, while an MCP client reads with its own window arguments under its
 * own token grant, as it did before the limit existed.
 */
export async function runCoachTool(
  ctx: McpAuthContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await executeCoachTool({
    userId: ctx.userId,
    // The single-metric read keeps one section, so it is built from that
    // source's rows (see `source-snapshot.ts`).
    ...(name === "get_metric_series" ? { sourceSnapshot: true } : {}),
    name,
    rawArguments: JSON.stringify(args ?? {}),
  });
  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: name, present: result.present },
  });
  return result;
}

/**
 * The explicit-absence answer for a read whose module is switched off.
 * Distinct from `{ present: false }` alone, which means "not
 * recorded": here the data may well exist and is simply not shared.
 */
export const MODULE_DISABLED = {
  present: false,
  reason: "module_disabled",
} as const;

/**
 * Run `read` only when `key` is on for this account; otherwise answer the
 * explicit absence without touching the table behind it.
 */
export async function whenModuleOn(
  ctx: McpAuthContext,
  key: "labs" | "medications" | "environment",
  tool: string,
  read: () => Promise<unknown>,
): Promise<unknown> {
  if (!(await isModuleEnabled(ctx.userId, key))) {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool, present: false, refused: "module_disabled" },
    });
    return MODULE_DISABLED;
  }
  return read();
}

/**
 * Decrypt a visit's `Bytes` free-text column, fail-soft to null.
 *
 * A key-rotation gap on one row reads as a missing reason/outcome, never as a
 * thrown tool call that takes the whole list down. Same codec + fail-soft
 * contract as `src/lib/encounters/dto.ts`.
 */
export function decryptVisitText(value: Uint8Array | null): string | null {
  if (!value || value.byteLength === 0) return null;
  try {
    return decryptFromBytes(value);
  } catch {
    return null;
  }
}
