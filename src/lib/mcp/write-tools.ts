/**
 * Transport-agnostic MCP write-tool registry — the confirmed write surface.
 *
 * Registered ONLY for a `health:write`-scoped session (`ctx.canWrite`); a
 * read-only session never sees these tools advertised, AND every run body
 * re-asserts the scope in its own call path (see `withWriteScope`). Each tool
 * wraps an in-process write core (`src/lib/mcp/writes.ts`) that mirrors the
 * proven Telegram capture helpers, pinned to the `MCP` provenance.
 *
 * TWO-STEP CONFIRM CONVENTION — and what it is NOT. The remote `/mcp` wire is
 * stateless (`enableJsonResponse: true`, no SSE) so server→client elicitation
 * is impossible. Instead every write tool takes an explicit `confirm` flag:
 *
 *   - `confirm:false` (default) → NOTHING is written. The tool returns the
 *     exact normalized record it WOULD write plus `requiresConfirmation:true`
 *     and an instruction telling the assistant to confirm the value with the
 *     user and re-call with `confirm:true` and the SAME `idempotencyKey`.
 *   - `confirm:true` → the write executes. The `(userId, …, externalId)`
 *     idempotency derived from `idempotencyKey` makes a retried call a no-op
 *     (`alreadyLogged:true`) rather than a duplicate.
 *
 * `confirm` is a CLIENT-ASSERTED BOOLEAN. Nothing binds it to a prior preview
 * and nothing proves a human saw the value: a caller may send `confirm:true`
 * on the first call and the write lands. Binding the flag to a server-issued
 * preview token was considered and rejected — it would prove only that a
 * preview call happened, which any client can trivially do, so it buys no
 * human-in-the-loop while adding a round trip and server state the stateless
 * transport does not want. The honest description is a CONVENTION that gives a
 * cooperating host a natural confirmation point (and a place to hang its own
 * human-in-the-loop, keyed off `readOnlyHint:false`), not a gate that
 * constrains an uncooperative one.
 *
 * What actually bounds the blast radius is the surface itself, below: writes
 * are append-only, idempotent, single self-reported readings, scope-gated
 * twice, rate-limited per credential, and audience-bound to `/mcp`. That is
 * the real control. `confirm` is ergonomics on top of it.
 *
 * DELIBERATE SAFETY BOUNDARY — what is NOT here and must NOT be added without
 * a security review:
 *   - No medication create / intake / edit, no schedule or dose changes.
 *   - No lab write, no clinical-threshold or reference-range change.
 *   - No delete or update of any existing row (writes are append-only,
 *     idempotent inserts of single self-reported readings).
 *   - No `export_data` / data-export tool. If one is ever added it must be
 *     write-tier AND never co-registered with any egress on the same surface.
 * The write surface is intentionally the smallest possible: a confirmed,
 * append-only log of a measurement or a mood the user reports themselves.
 */
import { z } from "zod/v4";

import type { MeasurementType } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import { checkMcpWriteRateLimit } from "@/lib/rate-limit";
import type { McpToolDefinition } from "./tools/types";
import {
  logMcpMeasurement,
  logMcpMood,
  logMcpBloodPressure,
  checkMcpMeasurement,
  checkMcpBloodPressure,
  resolveMcpMeasurementUnit,
} from "./writes";
import { isoDateTime } from "@/lib/validations/datetime";

/**
 * Write-tool annotations (MCP 2025-11-25). NOT read-only and NOT destructive
 * (an append-only, idempotent insert of a single self-reported reading), and
 * idempotent so a retried call under the same `idempotencyKey` is safe. A host
 * that adds human-in-the-loop confirmation keys off `readOnlyHint:false`.
 */
const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Shared output schema for the write tools. `written` is the boolean anchor on
 * every return path (preview, commit, refusal); everything else is optional so a
 * preview, a committed write, an already-logged no-op, and a structured refusal
 * all validate as `structuredContent` (ChatGPT Apps-SDK conformance). `preview`
 * / `record` carry the normalized echo of the row (shape per tool).
 */
const writeOutput: z.ZodRawShape = {
  written: z.boolean(),
  requiresConfirmation: z.boolean().optional(),
  alreadyLogged: z.boolean().optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
  instruction: z.string().optional(),
  preview: z.unknown().optional(),
  record: z.unknown().optional(),
  // Set on a preview that would be REFUSED on commit (type / range / instant),
  // with `error` + `reason` carrying the same verdict the commit would return —
  // so a preview and its commit never disagree.
  wouldFail: z.boolean().optional(),
};

/** Shared confirm-gate inputs every write tool carries. */
const confirmField = z
  .boolean()
  .default(false)
  .describe(
    "Set to true ONLY after confirming the value with the user. When false or absent the tool returns a preview and writes nothing.",
  );
const idempotencyKeyField = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "A stable client-chosen key for this logical write. Re-calling with the same key (after a preview) commits exactly one row; a further retry is a safe no-op.",
  );

/** The instruction the preview hands back to the assistant. */
const CONFIRM_INSTRUCTION =
  "This writes to the user's own health record. Confirm the value with the user, then call this tool again with confirm:true and the SAME idempotencyKey to commit it.";

/**
 * Enforce the tighter per-credential write budget before a commit. Returns a
 * structured refusal when the budget is exhausted so a runaway client cannot
 * flood writes (this is ON TOP of the `/mcp` per-binding request limiter).
 */
async function writeBudgetOk(binding: string): Promise<boolean> {
  const rl = await checkMcpWriteRateLimit(binding);
  if (!rl.allowed) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "write", status: "rate_limited" },
    });
  }
  return rl.allowed;
}

/**
 * DEFENCE IN DEPTH — re-assert the write scope inside the call path.
 *
 * The primary enforcement is structural: `createMcpServer` registers these
 * tools only when `ctx.canWrite`, so a read-only session's write handler
 * closure does not exist and the tool is not even advertised. That property is
 * real, but it lives entirely in the registration decision — a refactor that
 * registered the write tools unconditionally and meant to refuse at call time
 * would open the write surface with the registration test still green.
 *
 * So every run body is wrapped here rather than each tool remembering to check.
 * A new write tool added to the array inherits the guard by construction; there
 * is no version of this file where a write handler runs without the scope
 * having been checked in its own call path.
 */
function withWriteScope(tool: McpToolDefinition): McpToolDefinition {
  return {
    ...tool,
    async run(ctx, args) {
      if (!ctx.canWrite) {
        annotate({
          action: { name: "mcp.tool.write" },
          meta: { tool: tool.name, status: "scope_refused" },
        });
        return { written: false, error: "insufficient_scope" };
      }
      return tool.run(ctx, args);
    },
  };
}

const WRITE_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "log_measurement",
    title: "Log a measurement",
    description:
      "Log ONE single-value health measurement to the user's own record (e.g. weight, pulse, blood glucose, body temperature, oxygen saturation, a body-composition value). Requires confirmation: call once to preview the exact record, confirm the value with the user, then call again with confirm:true and the same idempotencyKey. Blood pressure (two values) and computed/clinical-only metrics are not loggable here.",
    inputShape: {
      type: z
        .string()
        .min(1)
        .max(60)
        .describe(
          "The measurement type, e.g. WEIGHT, PULSE, BLOOD_GLUCOSE, BODY_TEMPERATURE, OXYGEN_SATURATION, BODY_FAT. Not all types are loggable; an unsupported type is refused.",
        ),
      value: z
        .number()
        .describe("The numeric reading in the type's canonical unit."),
      unit: z
        .string()
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Optional unit hint. Omit to use the type's canonical unit. A recognised alias (lb/lbs/pound(s), in/inch(es), °F, mmol/L) is converted to canonical; any other unit is refused with unsupported_unit — the value is never stored in a non-canonical unit.",
        ),
      measuredAt: isoDateTime()
        .optional()
        .describe(
          "Optional ISO-8601 instant the reading was taken; defaults to now.",
        ),
      confirm: confirmField,
      idempotencyKey: idempotencyKeyField,
    },
    annotations: WRITE_ANNOTATIONS,
    outputShape: writeOutput,
    async run(ctx, args) {
      const type = String(args.type ?? "") as MeasurementType;
      const value = typeof args.value === "number" ? args.value : Number.NaN;
      const unit = typeof args.unit === "string" ? args.unit : undefined;
      const measuredAt =
        typeof args.measuredAt === "string"
          ? new Date(args.measuredAt)
          : undefined;
      const confirm = args.confirm === true;
      const idempotencyKey =
        typeof args.idempotencyKey === "string" ? args.idempotencyKey : "";

      if (!Number.isFinite(value)) {
        return { written: false, error: "invalid_number" };
      }

      if (!confirm) {
        // Run the SAME normalisation + validation the commit core runs so the
        // preview cannot show a value that would then be refused on commit. The
        // unit hint resolves to canonical (converting the value) or refuses;
        // the preview echoes the canonical value the commit would store.
        const unitResolution = resolveMcpMeasurementUnit(type, value, unit);
        const previewValue = unitResolution.ok ? unitResolution.value : value;
        const previewUnit = unitResolution.ok
          ? unitResolution.unit
          : (unit ?? null);
        const check = unitResolution.ok
          ? checkMcpMeasurement(type, previewValue, measuredAt)
          : null;
        annotate({
          action: { name: "mcp.tool.write" },
          meta: { tool: "log_measurement", status: "preview" },
        });
        const wouldFail = !unitResolution.ok
          ? { wouldFail: true as const, error: "unsupported_unit" as const }
          : check && !check.ok
            ? {
                wouldFail: true as const,
                error: check.error,
                reason: check.reason,
              }
            : {};
        return {
          requiresConfirmation: true,
          written: false,
          preview: {
            type,
            value: previewValue,
            unit: previewUnit,
            measuredAt: measuredAt ? measuredAt.toISOString() : "now",
            source: "MCP",
          },
          instruction: CONFIRM_INSTRUCTION,
          ...wouldFail,
        };
      }

      if (!(await writeBudgetOk(ctx.binding))) {
        return { written: false, error: "rate_limited" };
      }

      const result = await logMcpMeasurement({
        userId: ctx.userId,
        type,
        value,
        unit,
        measuredAt,
        idempotencyKey,
      });

      if (result.status === "unstable_idempotency_key") {
        return {
          written: false,
          error: "unstable_idempotency_key",
          reason: result.reason,
        };
      }
      if (result.status === "unsupported_type") {
        return { written: false, error: "unsupported_type" };
      }
      if (result.status === "unsupported_unit") {
        return { written: false, error: "unsupported_unit" };
      }
      if (result.status === "out_of_range") {
        return { written: false, error: "out_of_range", reason: result.reason };
      }
      if (result.status === "already_logged") {
        return {
          written: false,
          alreadyLogged: true,
          record: result.measurement,
        };
      }
      return { written: true, record: result.measurement };
    },
  },
  {
    name: "log_mood",
    title: "Log a mood entry",
    description:
      "Log the user's mood for today on a 1-5 scale (1 = very low, 5 = very good) to their own record, with an optional short note. Requires confirmation: call once to preview, confirm with the user, then call again with confirm:true and the same idempotencyKey to commit.",
    inputShape: {
      score: z
        .number()
        .int()
        .min(1)
        .max(5)
        .describe("Mood score 1-5 (1 = very low, 5 = very good)."),
      note: z
        .string()
        .max(500)
        .optional()
        .describe("Optional short free-text note (max 500 chars)."),
      confirm: confirmField,
      idempotencyKey: idempotencyKeyField,
    },
    annotations: WRITE_ANNOTATIONS,
    outputShape: writeOutput,
    async run(ctx, args) {
      const score = typeof args.score === "number" ? args.score : Number.NaN;
      const note = typeof args.note === "string" ? args.note : undefined;
      const confirm = args.confirm === true;
      const idempotencyKey =
        typeof args.idempotencyKey === "string" ? args.idempotencyKey : "";

      if (!Number.isInteger(score) || score < 1 || score > 5) {
        return { written: false, error: "invalid_score" };
      }

      if (!confirm) {
        annotate({
          action: { name: "mcp.tool.write" },
          meta: { tool: "log_mood", status: "preview" },
        });
        return {
          requiresConfirmation: true,
          written: false,
          preview: { score, note: note ?? null, source: "MCP" },
          instruction: CONFIRM_INSTRUCTION,
        };
      }

      if (!(await writeBudgetOk(ctx.binding))) {
        return { written: false, error: "rate_limited" };
      }

      const result = await logMcpMood({
        userId: ctx.userId,
        score,
        note,
        idempotencyKey,
      });

      if (result.status === "unstable_idempotency_key") {
        return {
          written: false,
          error: "unstable_idempotency_key",
          reason: result.reason,
        };
      }
      if (result.status === "invalid_score") {
        return { written: false, error: "invalid_score" };
      }
      if (result.status === "already_logged") {
        return {
          written: false,
          alreadyLogged: true,
          record: result.moodEntry,
        };
      }
      return { written: true, record: result.moodEntry };
    },
  },
  {
    name: "log_blood_pressure",
    title: "Log a blood-pressure reading",
    description:
      "Log ONE blood-pressure reading (systolic AND diastolic, in mmHg) to the user's own record. Blood pressure is two values so it cannot use log_measurement. Requires confirmation: call once to preview the exact reading, confirm the values with the user, then call again with confirm:true and the same idempotencyKey to commit. Both values are written atomically with the same timestamp.",
    inputShape: {
      systolic: z.number().describe("Systolic (the higher number), in mmHg."),
      diastolic: z.number().describe("Diastolic (the lower number), in mmHg."),
      measuredAt: isoDateTime()
        .optional()
        .describe(
          "Optional ISO-8601 instant the reading was taken; defaults to now.",
        ),
      confirm: confirmField,
      idempotencyKey: idempotencyKeyField,
    },
    annotations: WRITE_ANNOTATIONS,
    outputShape: writeOutput,
    async run(ctx, args) {
      const systolic =
        typeof args.systolic === "number" ? args.systolic : Number.NaN;
      const diastolic =
        typeof args.diastolic === "number" ? args.diastolic : Number.NaN;
      const measuredAt =
        typeof args.measuredAt === "string"
          ? new Date(args.measuredAt)
          : undefined;
      const confirm = args.confirm === true;
      const idempotencyKey =
        typeof args.idempotencyKey === "string" ? args.idempotencyKey : "";

      if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) {
        return { written: false, error: "invalid_number" };
      }

      if (!confirm) {
        // Same validation the commit core runs — preview == commit verdict.
        const check = checkMcpBloodPressure(systolic, diastolic, measuredAt);
        annotate({
          action: { name: "mcp.tool.write" },
          meta: { tool: "log_blood_pressure", status: "preview" },
        });
        return {
          requiresConfirmation: true,
          written: false,
          preview: {
            systolic,
            diastolic,
            unit: "mmHg",
            measuredAt: measuredAt ? measuredAt.toISOString() : "now",
            source: "MCP",
          },
          instruction: CONFIRM_INSTRUCTION,
          ...(check.ok
            ? {}
            : { wouldFail: true, error: check.error, reason: check.reason }),
        };
      }

      if (!(await writeBudgetOk(ctx.binding))) {
        return { written: false, error: "rate_limited" };
      }

      const result = await logMcpBloodPressure({
        userId: ctx.userId,
        systolic,
        diastolic,
        measuredAt,
        idempotencyKey,
      });

      if (result.status === "unstable_idempotency_key") {
        return {
          written: false,
          error: "unstable_idempotency_key",
          reason: result.reason,
        };
      }
      if (result.status === "out_of_range") {
        return { written: false, error: "out_of_range", reason: result.reason };
      }
      if (result.status === "already_logged") {
        return {
          written: false,
          alreadyLogged: true,
          record: result.bloodPressure,
        };
      }
      return { written: true, record: result.bloodPressure };
    },
  },
];

export const MCP_WRITE_TOOLS: McpToolDefinition[] =
  WRITE_TOOL_DEFINITIONS.map(withWriteScope);

/** Stable list of the registered write-tool names. */
export const MCP_WRITE_TOOL_NAMES: readonly string[] = MCP_WRITE_TOOLS.map(
  (t) => t.name,
);
