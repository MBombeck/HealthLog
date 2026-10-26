import { z } from "zod/v4";

import { fenceUserText } from "@/lib/ai/coach/data-fence";
import { resolveMarkerForRead } from "@/lib/labs/biomarker-resolve";
import { getLabHistory, LAB_HISTORY_MAX_LIMIT } from "@/lib/mcp/rich-reads";
import { decodeOffsetCursor } from "@/lib/mcp/pagination";
import type { McpAuthContext } from "../auth";
import { coachReadOutput } from "./output-shapes";
import { runCoachTool, whenModuleOn } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/** Output schema for `get_labs` — latest-per-biomarker OR a paginated history. */
const getLabsOutput: z.ZodRawShape = {
  // Latest-mode payload, including typed empty-read availability metadata.
  ...coachReadOutput,
  // History-mode payload (per-analyte trajectory + pagination).
  analyte: z.string().optional(),
  readings: z
    .array(
      z.object({
        value: z.number().nullable(),
        valueText: z.string().nullable(),
        unit: z.string(),
        referenceLow: z.number().nullable(),
        referenceHigh: z.number().nullable(),
        rangeStatus: z.enum(["in-range", "below", "above", "unknown"]),
        takenAt: z.string(),
      }),
    )
    .optional(),
  nextCursor: z.string().optional(),
};

/** The free-text fields of a lab reading: a document's words, never instructions. */
const LAB_TEXT_KEYS = new Set([
  "analyte",
  "name",
  "panel",
  "unit",
  "valueText",
]);

/**
 * Fence every free-text field of a labs answer, at any depth. An analyte,
 * panel or unit committed from an uploaded document is whatever a model read
 * out of that file, so it reaches the client's model fenced, as the server
 * instructions promise.
 */
function fenceLabText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fenceLabText);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      typeof inner === "string" && LAB_TEXT_KEYS.has(key)
        ? fenceUserText(inner)
        : fenceLabText(inner),
    ]),
  );
}

/** `get_labs` behind its module gate: latest-per-biomarker or a history page. */
function readLabs(
  ctx: McpAuthContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  // History mode: one analyte's paginated trajectory over the labs read
  // path. Requires an analyte — there is no whole-record history dump.
  if (args.history === true) {
    const analyte = typeof args.analyte === "string" ? args.analyte : "";
    if (!analyte.trim()) {
      return Promise.resolve({
        present: false,
        reason: "analyte_required_for_history",
      });
    }
    return getLabHistory(ctx.userId, {
      analyte,
      offset: decodeOffsetCursor(args.cursor),
      limit: LAB_HISTORY_MAX_LIMIT,
    });
  }
  // Default: latest reading per biomarker via the Coach labs read. A name that
  // resolves to one of the user's markers (an alias or a catalog abbreviation
  // such as "GPT" for "ALT") is read as that marker's own name (v1.43).
  return (async () => {
    const asked = typeof args.analyte === "string" ? args.analyte : null;
    const marker = asked?.trim()
      ? await resolveMarkerForRead(ctx.userId, asked)
      : null;
    return runCoachTool(ctx, "get_labs", {
      ...(asked !== null ? { analyte: marker?.name ?? asked } : {}),
    });
  })();
}

export const getLabsTool: McpToolDefinition = {
  name: "get_labs",
  title: "Get lab results",
  description:
    "Fetch the user's lab results. By default returns the latest reading per biomarker over the whole record. Filtered to one named analyte, each matching marker also carries a summarised history (the newest earlier values in full, older ones as one mean / min / max / count per year). Pass history:true with an analyte to return that analyte's reading TRAJECTORY (newest first, paginated). Each reading carries its value, unit, reference range, and in-range/below/above status. Returns { present: false } when no labs match, and { present: false, reason: \"module_disabled\" } when the labs module is switched off.",
  inputShape: {
    analyte: z.string().min(1).max(80).optional(),
    history: z
      .boolean()
      .optional()
      .describe(
        "When true (requires `analyte`), return that analyte's full reading trajectory (newest first, paginated) instead of the latest-per-biomarker snapshot.",
      ),
    cursor: z
      .string()
      .max(256)
      .optional()
      .describe(
        "Opaque pagination cursor from a previous history response's nextCursor. Treat as a black box.",
      ),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getLabsOutput,
  run(ctx, args) {
    return whenModuleOn(ctx, "labs", "get_labs", async () =>
      fenceLabText(await readLabs(ctx, args)),
    );
  },
};
