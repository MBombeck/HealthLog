/**
 * Transport-agnostic MCP read-tool registry.
 *
 * Each tool is a THIN wrapper over an existing server-authoritative read path —
 * the Coach F1 retrieval layer (`@/lib/ai/coach/tools`). No new analytics is
 * computed here (REQ-WONT-2); the MCP wire only re-exports what HealthLog
 * already computes. The same registry feeds both transports: the stdio adapter
 * (this phase) and the remote `/mcp` adapter (a later phase) register from it,
 * so the tool contract can never fork between wires (ADR-002).
 *
 * Grounding contract (REQ-SEC-2/3/4, ADR-004): every tool returns structured
 * values + units + reference bands + provenance and uses `{ present: false }`
 * for absence — never a silent zero, never a prose verdict or diagnosis. The
 * assistant narrates; the server only ships facts it computed.
 *
 * Read-only contract (REQ-SEC-1, ADR-003): the registry contains read tools
 * only. `userId` is always taken from the resolved session context, never from a
 * tool argument (REQ-SEC-5).
 */
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
} from "@/lib/ai/coach/types";
import { isModuleEnabled } from "@/lib/modules/gate";
import { resolveBaseOrigin } from "@/lib/mcp/oauth/config";
import {
  getCorrelation,
  compareMetric,
  getMetricBaseline,
  detectChangepoints,
  getLabHistory,
  LAB_HISTORY_MAX_LIMIT,
  MCP_CLINICAL_SIGNALS,
  MCP_METRIC_STATUS_DISCOVERY,
  metricStatusDiscoveryRows,
  type DateRange,
} from "@/lib/mcp/rich-reads";
import {
  getNutrients,
  resolveNutrientCode,
  NUTRIENT_LABELS,
  type NutrientsDailyResult,
} from "@/lib/mcp/nutrients-read";
import { NUTRIENT_CODES } from "@/lib/nutrients/catalog";
import { loadIntradayPulse } from "@/lib/analytics/intraday-pulse-io";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import { encodeOffsetCursor, decodeOffsetCursor } from "@/lib/mcp/pagination";
import {
  computeDisplayDue,
  OVERDUE_LOOKBACK_MS,
  toResolvedSlotMark,
  type ResolvedSlotMark,
} from "@/lib/medications/scheduling/next-due";
import {
  getIntegrationStatus,
  type IntegrationKey,
} from "@/lib/integrations/status";
import {
  INTEGRATION_CADENCE,
  resolveSyncVerdict,
} from "@/lib/integrations/sync-verdict";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";
import { calendarDaysUntil } from "@/lib/measurement-reminders/due-day";
import { fenceUserText, scrubFenceMarkers } from "@/lib/ai/coach/data-fence";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { listTargetsBySource } from "@/lib/links";
import { encounterKindEnum } from "@/lib/validations/encounters";
import type { McpAuthContext } from "./auth";
import { dueSchedules } from "@/lib/medications/intake-tracking";
import { liveEraStartsByMedication } from "@/lib/medications/scheduling/live-era";

/**
 * Tool annotations (MCP 2025-11-25). The cloud connectors REQUIRE these on every
 * tool — the ChatGPT Apps SDK treats an omitted hint as a validation error, and
 * the Claude directory requires a safety hint per tool. Every tool the MCP
 * surface exposes is read-only over a closed personal record, so they all share
 * the same shape (ADR-003): the read-only guarantee is structural, the
 * annotation merely advertises it.
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * A registry entry. `inputShape` is a zod/v4 raw shape handed straight to the
 * SDK's `registerTool` for argument validation; `run` receives the validated
 * arguments and the session context and returns a plain structured object.
 */
export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputShape: z.ZodRawShape;
  /** Tool annotations — mandatory for the cloud connectors (see above). */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /**
   * When set, the tool declares a structured `outputSchema` and its result is
   * returned as `structuredContent`. Used by `search` / `fetch` so ChatGPT can
   * consume the exact `{id,title,url}[]` / `{id,title,text,url,metadata}` shapes.
   */
  outputShape?: z.ZodRawShape;
  run: (ctx: McpAuthContext, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Run one Coach F1 retrieval tool through its executor. The executor re-parses
 * and re-validates the arguments against its own Zod schema, runs the
 * server-authoritative snapshot builder scoped to the requested domain, and
 * returns the grounded `{ present, reason?, data?, grounding? }` result. It
 * never throws and never widens scope.
 */
async function runCoachTool(
  ctx: McpAuthContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await executeCoachTool({
    userId: ctx.userId,
    name,
    rawArguments: JSON.stringify(args ?? {}),
  });
  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: name, present: result.present },
  });
  return result;
}

/** Finite-number guard for the citation summarisers. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Render a `fetch` result for a metric id as a short, human-readable citation
 * sentence (NOT a JSON blob). Pulls the recent aggregate + the grounding band
 * out of the server-authoritative result; falls back to a plain factual line
 * when a field is absent. Never fabricates a number the result did not carry.
 */
function plainMetricText(rid: string, result: unknown): string {
  const r = result as {
    present?: boolean;
    data?: { section?: Record<string, unknown> } & Record<string, unknown>;
    grounding?: string;
  };
  if (!r?.present) return `No recent ${rid} data is on file.`;
  const section = (r.data?.section ?? r.data) as
    Record<string, unknown> | undefined;
  const agg = section?.aggregate as Record<string, unknown> | undefined;
  const parts: string[] = [];
  const mean = num(agg?.mean);
  const count = num(agg?.count);
  if (mean !== null) parts.push(`recent mean ${round1(mean)}`);
  if (count !== null) parts.push(`${count} readings`);
  const head =
    parts.length > 0
      ? `${rid}: ${parts.join(", ")}.`
      : `${rid}: data is available for the recent window.`;
  return [head, typeof r.grounding === "string" ? r.grounding : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * Render a `fetch` result for a lab analyte id as a short citation sentence,
 * quoting the latest reading's value/unit/status/date verbatim from the
 * server-authoritative result.
 */
function plainLabText(rid: string, result: unknown): string {
  const r = result as {
    present?: boolean;
    data?: { recent?: Array<Record<string, unknown>> };
  };
  if (!r?.present) return `No lab result for ${rid} is on file.`;
  const reading = Array.isArray(r.data?.recent) ? r.data!.recent[0] : undefined;
  if (!reading) return `${rid}: a reading is on file.`;
  const analyte = typeof reading.analyte === "string" ? reading.analyte : rid;
  const value =
    reading.value != null
      ? String(reading.value)
      : typeof reading.valueText === "string"
        ? reading.valueText
        : "—";
  const unit = typeof reading.unit === "string" ? reading.unit : "";
  const status =
    typeof reading.rangeStatus === "string" ? reading.rangeStatus : "";
  const taken =
    typeof reading.takenAt === "string" ? reading.takenAt.slice(0, 10) : "";
  // `analyte`, `unit` and a qualitative `valueText` are free text the server
  // did not author — a lab analyte name is transcribed by a model out of an
  // UPLOADED PDF, so a hostile document chooses it. Fence the sentence so the
  // model reads it as data, and so nothing inside can forge a fence boundary.
  return fenceUserText(
    `${analyte}: ${value}${unit ? ` ${unit}` : ""}` +
      `${status && status !== "unknown" ? ` (${status})` : ""}` +
      `${taken ? `, measured ${taken}` : ""}.`,
  );
}

/**
 * Render a `fetch` result for a v1.25 clinical signal (grip strength, pain NRS,
 * waist circumference, waist-to-height) as a plain-text citation sentence. These
 * sit off the Coach snapshot, so they hydrate through the rollup-backed baseline
 * read (`get_metric_baseline`) rather than the Coach `get_metric_series` path:
 * the latest reading, where it sits against the user's own usual range, and the
 * population reference band. Quotes only values the result carried; never
 * fabricates a figure or asserts a clinical verdict.
 */
function plainClinicalText(
  label: string,
  result: {
    present?: boolean;
    reason?: string;
    unit?: string;
    latest?: number;
    placement?: "within" | "above" | "below";
    baseline?: { low: number; high: number };
    referenceBand?: { low: number; high: number } | null;
  },
): string {
  const unit = result.unit ? ` ${result.unit}` : "";
  const band = result.referenceBand
    ? ` Reference band ${result.referenceBand.low}–${result.referenceBand.high}${unit}.`
    : "";
  if (!result.present) {
    if (result.reason === "insufficient_history") {
      return `${label}: still learning your usual range — too little history yet.${band}`;
    }
    return `No recent ${label.toLowerCase()} data is on file.`;
  }
  const parts: string[] = [];
  if (typeof result.latest === "number") {
    parts.push(`latest ${round1(result.latest)}${unit}`);
  }
  if (result.placement && result.baseline) {
    parts.push(
      `${result.placement} your usual ${round1(result.baseline.low)}–${round1(
        result.baseline.high,
      )}${unit}`,
    );
  }
  const head =
    parts.length > 0
      ? `${label}: ${parts.join(", ")}.`
      : `${label}: a reading is on file.`;
  return `${head}${band}`.trim();
}

/**
 * Render a `fetch` result for a nutrient code as a plain-text citation
 * sentence: the most recent non-zero day's total plus the resolved EFSA
 * reference (target vs upper-guidance ceiling), quoting only values the
 * result carried. Never fabricates a figure.
 */
function plainNutrientText(
  label: string,
  result: NutrientsDailyResult,
): string {
  if (!result.present) {
    return result.reason === "module_disabled"
      ? `${label}: nutrient tracking is turned off for this account.`
      : `No recent ${label.toLowerCase()} data is on file.`;
  }
  const unit = result.unit ? ` ${result.unit}` : "";
  const latestDay = [...(result.days ?? [])]
    .reverse()
    .find((d) => d.amount > 0);
  const parts: string[] = [];
  if (latestDay) {
    parts.push(
      `most recent logged day ${latestDay.day}: ${round1(latestDay.amount)}${unit}`,
    );
  }
  const ref = result.reference;
  if (ref) {
    const verb =
      ref.direction === "upperGuidance" ? "guidance ceiling" : "target";
    parts.push(`EFSA ${verb} ${round1(ref.value)}${unit}`);
  }
  return parts.length > 0
    ? `${label}: ${parts.join(", ")}.`
    : `${label}: data is on file for the recent window.`;
}

/**
 * The `search` + `fetch` pair — the de-facto two-tool retrieval convention and,
 * critically, the ONLY tools ChatGPT can call in its default (non-Developer)
 * mode. Without them HealthLog is invisible in default ChatGPT. The exact wire
 * shapes are mandated by OpenAI:
 *
 *   - `search({ query })` → `{ results: [{ id, title, url }] }`
 *   - `fetch({ id })`     → `{ id, title, text, url, metadata? }`
 *
 * Every result carries a REAL, user-openable HTTPS deep link (`url`) into the
 * HealthLog web app — ChatGPT only creates citation metadata when `url` is a
 * non-empty string. The internal `id` stays separate from `url`. Both tools are
 * thin façades over the SAME server-authoritative read paths the other tools
 * use; free-text fields (medication names, lab analytes) are returned as DATA,
 * never interpreted as instructions (R-SEC-2).
 */
function searchAndFetchTools(): McpToolDefinition[] {
  return [
    {
      name: "search",
      title: "Search your health records",
      description:
        "Search the user's own health record — metric domains, medications, and lab biomarkers — for items matching a free-text query. Returns { results: [{ id, title, url }], nextCursor? }; pass an id to the `fetch` tool to hydrate it. Each `url` deep-links into the HealthLog web app for citation. When more results exist, pass the opaque `nextCursor` back as `cursor` for the next page. Returns an empty list when nothing matches.",
      inputShape: {
        query: z.string().max(200),
        cursor: z
          .string()
          .max(256)
          .optional()
          .describe(
            "Opaque pagination cursor from a previous response's nextCursor. Treat as a black box; do not construct one.",
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputShape: {
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            url: z.string(),
          }),
        ),
        nextCursor: z.string().optional(),
      },
      async run(ctx, args) {
        const query =
          typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
        const origin = resolveBaseOrigin();
        const results: Array<{ id: string; title: string; url: string }> = [];

        const inventory = await buildCoachDataInventory(ctx.userId, undefined);
        for (const entry of inventory.entries) {
          if (!entry.present) continue;
          const hay = `${entry.domain} ${entry.metric ?? ""}`.toLowerCase();
          if (query && !hay.includes(query)) continue;
          // Per-item deep-link where a metric id exists (mirrors `fetch`),
          // else the generic insights landing for a whole-domain row.
          results.push({
            id: entry.metric
              ? `metric:${entry.metric}`
              : `domain:${entry.domain}`,
            title: entry.domain,
            url: entry.metric
              ? `${origin}/insights?metric=${encodeURIComponent(entry.metric)}`
              : `${origin}/insights`,
          });
        }

        const meds = await prisma.medication.findMany({
          where: { userId: ctx.userId },
          select: { id: true, name: true, dose: true },
          orderBy: { createdAt: "desc" },
          take: SEARCH_RESULT_SCAN_CAP,
        });
        for (const med of meds) {
          if (query && !med.name.toLowerCase().includes(query)) continue;
          results.push({
            id: `med:${med.id}`,
            // A search title is a short label a host renders in a result list,
            // so it is scrubbed rather than fenced — wrapping it would leak
            // markers into the host's UI. Scrubbing still denies a hostile
            // name the ability to forge a boundary around neighbouring text.
            title: scrubFenceMarkers(
              med.dose ? `${med.name} ${med.dose}` : med.name,
            ),
            // Per-item deep-link to the medication detail page (mirrors `fetch`).
            url: `${origin}/medications/${encodeURIComponent(med.id)}`,
          });
        }

        const labs = await prisma.labResult.findMany({
          where: { userId: ctx.userId, deletedAt: null },
          select: { analyte: true },
          distinct: ["analyte"],
          orderBy: { analyte: "asc" },
          take: SEARCH_RESULT_SCAN_CAP,
        });
        for (const lab of labs) {
          if (query && !lab.analyte.toLowerCase().includes(query)) continue;
          results.push({
            id: `lab:${lab.analyte}`,
            // Document-sourced free text — scrubbed, same reasoning as the
            // medication titles above.
            title: scrubFenceMarkers(lab.analyte),
            // Per-item deep-link to the labs surface filtered to this analyte.
            url: `${origin}/labs?analyte=${encodeURIComponent(lab.analyte)}`,
          });
        }

        // v1.25 clinical signals (grip strength, pain NRS, waist / WHtR) PLUS
        // the v1.30 coverage-review metric-status-only set (wrist
        // temperature, cardio recovery, sleep score, breathing disturbances,
        // strain/load, …) — both sit off the Coach data inventory by design,
        // so they are surfaced here directly. One grouped presence probe over
        // the combined backing measurement types; present-only, in a stable
        // (allowlist) order. `fetch metric:<KEY>` hydrates each via the
        // rollup-backed baseline read.
        const discoverableSignals = [
          ...MCP_CLINICAL_SIGNALS,
          ...MCP_METRIC_STATUS_DISCOVERY,
        ];
        const discoverablePresent = await prisma.measurement.groupBy({
          by: ["type"],
          where: {
            userId: ctx.userId,
            type: { in: discoverableSignals.map((s) => s.measurementType) },
          },
        });
        const presentTypes = new Set(discoverablePresent.map((r) => r.type));
        for (const sig of discoverableSignals) {
          if (!presentTypes.has(sig.measurementType)) continue;
          const hay = `${sig.label} ${sig.key}`.toLowerCase();
          if (query && !hay.includes(query)) continue;
          results.push({
            id: `metric:${sig.key}`,
            title: sig.label,
            url: `${origin}/insights?metric=${encodeURIComponent(sig.key)}`,
          });
        }

        // v1.30 (G1) — nutrients (water/caffeine/24 micronutrients) presence
        // probe, gated on the opt-in `nutrients` module exactly like the
        // ingest/read routes: an account that never turned the module on gets
        // no rows here, mirroring the module's own dark-by-default posture.
        // One grouped presence query over the closed catalog, mirroring the
        // clinical-signal probe above. Without this, `search("water")` /
        // `search("magnesium")` returned `[]` even for a daily logger — a
        // truthfulness bug under the server's own absence contract.
        if (await isModuleEnabled(ctx.userId, "nutrients")) {
          const nutrientPresent = await prisma.nutrientIntakeDay.groupBy({
            by: ["nutrient"],
            where: { userId: ctx.userId },
          });
          const loggedNutrients = new Set(
            nutrientPresent.map((r) => r.nutrient),
          );
          for (const code of NUTRIENT_CODES) {
            if (!loggedNutrients.has(code)) continue;
            const label = NUTRIENT_LABELS[code];
            const hay = `${label} ${code} nutrient nutrients`.toLowerCase();
            if (query && !hay.includes(query)) continue;
            results.push({
              id: `nutrient:${code}`,
              title: label,
              url: `${origin}/insights/nutrients`,
            });
          }
        }

        // Cursor pagination over the assembled result set (was a silent
        // slice(0,50)). The set is rebuilt deterministically each call (stable
        // ordering: metrics → medications → labs), so an opaque offset cursor
        // pages it reliably and the response stays token-bounded.
        const offset = decodeOffsetCursor(args.cursor);
        const page = results.slice(offset, offset + SEARCH_PAGE_SIZE);
        const hasMore = offset + SEARCH_PAGE_SIZE < results.length;
        annotate({
          action: { name: "mcp.tool.invoked" },
          meta: { tool: "search", present: page.length > 0 },
        });
        return {
          results: page,
          ...(hasMore
            ? { nextCursor: encodeOffsetCursor(offset + SEARCH_PAGE_SIZE) }
            : {}),
        };
      },
    },
    {
      name: "fetch",
      title: "Fetch one health record",
      description:
        "Hydrate a single record returned by `search`, by its id (e.g. `metric:weight`, `med:<id>`, `lab:LDL`). Returns { id, title, text, url, metadata } where `text` is a server-authoritative, plain-text prose summary suitable for citation and `url` deep-links to the specific record in HealthLog. Returns a not-found message when the id does not resolve.",
      inputShape: { id: z.string().min(1).max(200) },
      annotations: READ_ONLY_ANNOTATIONS,
      outputShape: {
        id: z.string(),
        title: z.string(),
        text: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      async run(ctx, args) {
        const id = typeof args.id === "string" ? args.id : "";
        const origin = resolveBaseOrigin();
        const sep = id.indexOf(":");
        const kind = sep > 0 ? id.slice(0, sep) : "";
        const rid = sep > 0 ? id.slice(sep + 1) : "";

        annotate({
          action: { name: "mcp.tool.invoked" },
          meta: { tool: "fetch", kind: kind || "unknown" },
        });

        if (kind === "metric" && rid) {
          // v1.25 clinical signals AND the v1.30 metric-status-only discovery
          // set both sit off the Coach snapshot, so hydrate them through the
          // rollup-backed baseline read rather than the Coach
          // `get_metric_series` path (which would report no data for them).
          const discoverable = [
            ...MCP_CLINICAL_SIGNALS,
            ...MCP_METRIC_STATUS_DISCOVERY,
          ].find((s) => s.key.toLowerCase() === rid.toLowerCase());
          if (discoverable) {
            const baseline = await getMetricBaseline(ctx.userId, {
              metric: discoverable.key,
            });
            return {
              id,
              title: discoverable.label,
              text: plainClinicalText(discoverable.label, baseline),
              url: `${origin}/insights?metric=${encodeURIComponent(discoverable.key)}`,
              metadata: { type: "metric", metric: discoverable.key },
            };
          }
          const result = await executeCoachTool({
            userId: ctx.userId,
            name: "get_metric_series",
            rawArguments: JSON.stringify({ metric: rid }),
          });
          return {
            id,
            title: rid,
            text: plainMetricText(rid, result),
            // The metric page deep-link; the insights surface renders the series.
            url: `${origin}/insights?metric=${encodeURIComponent(rid)}`,
            metadata: { type: "metric", metric: rid },
          };
        }

        if (kind === "nutrient" && rid) {
          const code = resolveNutrientCode(rid);
          if (!code) {
            return {
              id,
              title: "Not found",
              text: `No nutrient matches "${rid}".`,
              url: `${origin}/insights/nutrients`,
              metadata: { type: "nutrient" },
            };
          }
          const result = (await getNutrients(ctx.userId, {
            nutrient: code,
          })) as NutrientsDailyResult;
          const label = NUTRIENT_LABELS[code];
          return {
            id,
            title: label,
            text: plainNutrientText(label, result),
            url: `${origin}/insights/nutrients`,
            metadata: { type: "nutrient", nutrient: code },
          };
        }

        if (kind === "lab" && rid) {
          const result = await executeCoachTool({
            userId: ctx.userId,
            name: "get_labs",
            rawArguments: JSON.stringify({ analyte: rid }),
          });
          return {
            id,
            title: rid,
            text: plainLabText(rid, result),
            // Deep-link to the labs surface filtered to this analyte.
            url: `${origin}/labs?analyte=${encodeURIComponent(rid)}`,
            metadata: { type: "lab", analyte: rid },
          };
        }

        if (kind === "med" && rid) {
          const med = await prisma.medication.findFirst({
            where: { id: rid, userId: ctx.userId },
            select: {
              name: true,
              dose: true,
              treatmentClass: true,
              asNeeded: true,
            },
          });
          if (!med) {
            return {
              id,
              title: "Not found",
              text: "No medication matches this id.",
              url: `${origin}/medications`,
              metadata: { type: "medication" },
            };
          }
          // Plain-text prose, not a JSON blob. `name` / `dose` /
          // `treatmentClass` are user-controlled free text returned as DATA,
          // never interpreted — fenced so that contract is stated on the wire
          // rather than only in the server instructions.
          const text = fenceUserText(
            `${med.name}${med.dose ? ` ${med.dose}` : ""}` +
              `${med.asNeeded ? " (as needed)" : ""}` +
              `${med.treatmentClass ? ` — ${med.treatmentClass}` : ""}.`,
          );
          return {
            id,
            title: scrubFenceMarkers(med.name),
            text,
            // Per-item deep-link to the medication detail page.
            url: `${origin}/medications/${encodeURIComponent(rid)}`,
            metadata: { type: "medication", medicationId: rid },
          };
        }

        return {
          id,
          title: "Not found",
          text: `No record matches the id "${id}".`,
          url: `${origin}/insights`,
          metadata: { type: "unknown" },
        };
      },
    },
  ];
}

// ── Output schemas ───────────────────────────────────────────────────
// Every field except the presence anchor (`present`) is optional so a grounded
// `{ present: false }` miss and a full hit both conform — the SDK validates the
// returned `structuredContent` against these (ChatGPT Apps-SDK conformance).

const bandShape = z
  .object({ low: z.number(), high: z.number() })
  .nullable()
  .optional();

/**
 * The shared output shape for the Coach-F1-backed reads (`get_metric_series`,
 * `get_glucose_panel`, `get_sleep`, `get_workouts`, `get_illness_recovery`,
 * `get_cycle`, `get_medication_compliance`, `get_correlations`). The executor
 * returns the grounded `{ present, reason?, data?, grounding? }` contract; `data`
 * is the server-authoritative domain section (its inner shape is the snapshot's,
 * carried opaque here) so both a miss and a full hit validate.
 */
const coachReadOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  data: z.unknown().optional(),
  grounding: z.string().optional(),
};

/**
 * Optional explicit `{from,to}` ISO date range that the comparison /
 * changepoint reads accept IN PLACE OF one of the five fixed trailing windows.
 * Bounds are inclusive; the read serves the range over the same rollup tier the
 * trailing windows use (see `rich-reads.ts`).
 */
const dateRangeShape = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .describe(
    "An explicit inclusive date range. Use INSTEAD OF `window` for an arbitrary span (e.g. before vs after a date). Both bounds are ISO-8601 instants.",
  );

/** Cap on metrics fetched in one `get_metrics` call (paginated past the cap). */
const MAX_METRICS_PER_CALL = 24;
/** Metrics resolved per `get_metrics` page. */
const METRICS_PAGE_SIZE = 8;
/** Results per `search` page. */
const SEARCH_PAGE_SIZE = 50;
/**
 * Per-source scan ceiling the `search` assembler reads before paging. Raised
 * from the prior 200 (which made any item past the 200th unreachable, even
 * through the cursor) to a generous documented cap so the opaque offset cursor
 * pages the FULL assembled set. A user with more medications or distinct lab
 * analytes than this ceiling is well outside any realistic personal record.
 */
const SEARCH_RESULT_SCAN_CAP = 2000;

const getCorrelationOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  pair: z
    .object({
      behaviour: z.string(),
      outcome: z.string(),
      direction: z.enum(["higher", "lower"]),
      lagDays: z.number(),
      n: z.number(),
      r: z.number(),
      note: z.string(),
    })
    .optional(),
  pairsTested: z.number().optional(),
  windowDays: z.number().optional(),
  association: z.literal("descriptive").optional(),
};

const metricWindowSnapshotSchema = z.object({
  label: z.string(),
  unit: z.string(),
  band: bandShape,
  windowDays: z.number(),
  granularity: z.string(),
  count: z.number(),
  mean: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  // Present only when the side was an explicit `{from,to}` range.
  from: z.string().optional(),
  to: z.string().optional(),
});

/** Output schema for `list_metrics` — the inventory rows + flags. */
const listMetricsOutput: z.ZodRawShape = {
  present: z.boolean(),
  window: z.string().optional(),
  restMode: z.boolean().optional(),
  cycleEnabled: z.boolean().optional(),
  metrics: z
    .array(
      z.object({
        tool: z.string(),
        domain: z.string(),
        present: z.boolean(),
        count: z.number().optional(),
        metric: z.string().optional(),
      }),
    )
    .optional(),
};

/** Output schema for `get_labs` — latest-per-biomarker OR a paginated history. */
const getLabsOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  // Latest-mode payload (the Coach labs section, carried opaque).
  data: z.unknown().optional(),
  grounding: z.string().optional(),
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

/** Output schema for `get_metrics` — the multi-metric fan-out + pagination. */
const getMetricsOutput: z.ZodRawShape = {
  present: z.boolean(),
  window: z.string().optional(),
  results: z
    .array(
      z.object({
        metric: z.string(),
        present: z.boolean(),
        reason: z.string().optional(),
        data: z.unknown().optional(),
        grounding: z.string().optional(),
      }),
    )
    .optional(),
  nextCursor: z.string().optional(),
};

const compareMetricOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  mode: z.enum(["metric_vs_metric", "window_vs_window"]).optional(),
  a: metricWindowSnapshotSchema.optional(),
  b: metricWindowSnapshotSchema.optional(),
  delta: z
    .object({ mean: z.number(), pct: z.number().nullable() })
    .nullable()
    .optional(),
};

const getMetricBaselineOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  metric: z.string().optional(),
  unit: z.string().optional(),
  baseline: z
    .object({ low: z.number(), high: z.number(), sampleDays: z.number() })
    .optional(),
  latest: z.number().optional(),
  placement: z.enum(["within", "above", "below"]).optional(),
  referenceBand: bandShape,
  driver: z
    .object({ note: z.string(), behaviour: z.string(), outcome: z.string() })
    .nullable()
    .optional(),
};

const detectChangepointsOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  metric: z.string().optional(),
  unit: z.string().optional(),
  granularity: z.string().optional(),
  windowDays: z.number().optional(),
  bucketsAnalysed: z.number().optional(),
  changepoints: z
    .array(
      z.object({
        at: z.string(),
        direction: z.enum(["increase", "decrease"]),
        beforeMean: z.number(),
        afterMean: z.number(),
        delta: z.number(),
      }),
    )
    .optional(),
};

/** Output schema for `get_medication_schedule` — per-medication next-due. */
const getMedicationScheduleOutput: z.ZodRawShape = {
  present: z.boolean(),
  medications: z
    .array(
      z.object({
        name: z.string(),
        dose: z.string().nullable(),
        nextDueAt: z.string().nullable(),
        overdue: z.boolean(),
        asNeeded: z.boolean(),
        intakeTracked: z.boolean(),
      }),
    )
    .optional(),
};

/** Output schema for `get_integration_status` — per-provider sync health. */
const getIntegrationStatusOutput: z.ZodRawShape = {
  present: z.boolean(),
  providers: z
    .array(
      z.object({
        provider: z.string(),
        state: z.string(),
        connected: z.boolean(),
        reauthRequired: z.boolean(),
        lastSuccessAt: z.string().nullable(),
        lastAttemptAt: z.string().nullable(),
        verdict: z.string(),
        since: z.string().nullable(),
      }),
    )
    .optional(),
};

/**
 * Output schema for `get_preventive_care` — the Vorsorge due-list, plus the
 * upcoming appointments booked as visits.
 *
 * `appointments` is a NAMED field on this same result rather than a second
 * due-list tool: an assistant asked "what is coming up" gets one answer instead
 * of having to know there are two lists. The Vorsorge `checkups` arm stays free
 * of `ENCOUNTER`-origin reminders (Phase 1 excluded them); the appointments are
 * read from `Encounter` directly, so the two never blur.
 */
const getPreventiveCareOutput: z.ZodRawShape = {
  present: z.boolean(),
  checkups: z
    .array(
      z.object({
        label: z.string(),
        measurementType: z.string().nullable(),
        nextDueAt: z.string().nullable(),
        overdue: z.boolean(),
        location: z.string().nullable(),
        lastSatisfiedAt: z.string().nullable(),
        // v1.37.20 (#223) — resolved skip/snooze state. Without these the
        // model sees a due date jump with no cause and invents one.
        // `lastSatisfiedAt` stays the ONLY completed signal: a skip is
        // recorded as a skip, never as done.
        snoozedUntil: z.string().nullable(),
        lastSkippedAt: z.string().nullable(),
        skipCount: z.number(),
      }),
    )
    .optional(),
  appointments: z
    .array(
      z.object({
        occurredAt: z.string(),
        practitioner: z.string().nullable(),
        specialty: z.string().nullable(),
        kind: z.string(),
        reason: z.string().nullable(),
      }),
    )
    .optional(),
};

/**
 * Output schema for `get_visits` — the account's own past visits, bounded.
 *
 * Follows `get_preventive_care`'s shape: every field beyond `present` is
 * optional so a grounded `{ present: false }` miss and a full hit both validate
 * against one schema (the ChatGPT Apps-SDK conformance rule the other reads
 * follow). Absence is `{ present: false }`, never `{ present: true, visits: [] }`
 * — "you have never recorded a visit" and "you have no visits" are different
 * claims and only the first is true when the list is empty.
 */
const getVisitsOutput: z.ZodRawShape = {
  present: z.boolean(),
  // Null when the read covered the whole record: a procedure history asked
  // for without a window (v1.39.1).
  windowMonths: z.number().nullable().optional(),
  visits: z
    .array(
      z.object({
        occurredAt: z.string(),
        status: z.string(),
        kind: z.string(),
        practitioner: z.string().nullable(),
        specialty: z.string().nullable(),
        reason: z.string().nullable(),
        outcome: z.string().nullable(),
        bodySite: z.string().nullable(),
        laterality: z.enum(["LEFT", "RIGHT", "BOTH"]).nullable(),
        conditions: z.array(z.string()),
      }),
    )
    .optional(),
};

/** Default trailing window for `get_visits` when the caller names none. */
const DEFAULT_VISITS_WINDOW_MONTHS = 12;
/** Hard cap on the `get_visits` window, so an unbounded read is impossible. */
const MAX_VISITS_WINDOW_MONTHS = 60;
/** Newest-first cap on the visits one `get_visits` call returns. */
const MAX_VISITS = 50;
/** Newest-first cap on the appointments folded into `get_preventive_care`. */
const MAX_APPOINTMENTS = 25;

/**
 * Decrypt a visit's `Bytes` free-text column, fail-soft to null.
 *
 * A key-rotation gap on one row reads as a missing reason/outcome, never as a
 * thrown tool call that takes the whole list down. Same codec + fail-soft
 * contract as `src/lib/encounters/dto.ts`.
 */
function decryptVisitText(value: Uint8Array | null): string | null {
  if (!value || value.byteLength === 0) return null;
  try {
    return decryptFromBytes(value);
  } catch {
    return null;
  }
}

/**
 * Output schema for `get_nutrients` — either the presence overview (no
 * `nutrient` arg) or one nutrient's per-day series + reference. Every field
 * beyond `present` is optional so both shapes validate against one schema.
 */
const getNutrientsOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  windowDays: z.number().optional(),
  // Overview mode.
  nutrients: z
    .array(
      z.object({
        nutrient: z.string(),
        label: z.string(),
        unit: z.string(),
        latestDay: z.string(),
        latestAmount: z.number(),
        daysWithData: z.number(),
      }),
    )
    .optional(),
  // Per-nutrient mode.
  nutrient: z.string().optional(),
  label: z.string().optional(),
  unit: z.string().optional(),
  days: z.array(z.object({ day: z.string(), amount: z.number() })).optional(),
  reference: z
    .object({
      kind: z.enum(["PRI", "AI", "safeLevel"]),
      direction: z.enum(["target", "upperGuidance"]),
      value: z.number(),
      source: z.string(),
    })
    .nullable()
    .optional(),
};

/**
 * Output schema for `get_intraday_pulse` — the 10-minute "shape of the day"
 * plus, when every confidence gate holds, one cautious elevated-at-rest
 * ("tension") window. Verbatim re-export of `IntradayPulseResult`
 * (`intraday-pulse-io.ts`); `resolution` tells the caller whether `series` is
 * the dense 10-minute grain or the coarser hourly fallback.
 */
const getIntradayPulseOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  dateKey: z.string().optional(),
  timezone: z.string().optional(),
  bucketMinutes: z.number().optional(),
  resolution: z.enum(["tenMin", "hourly"]).optional(),
  series: z
    .array(
      z.object({
        startMinute: z.number(),
        mean: z.number(),
        count: z.number(),
      }),
    )
    .optional(),
  baseline: z.number().nullable().optional(),
  baselineSource: z.enum(["resting", "proxy", "none"]).optional(),
  tension: z
    .object({
      startMinute: z.number(),
      endMinute: z.number(),
      partOfDay: z.enum(["morning", "afternoon", "evening", "night"]),
      meanHr: z.number(),
      baseline: z.number(),
      hrvConfirmed: z.boolean(),
    })
    .nullable()
    .optional(),
};

/** Defensive cap, mirrors `GET /api/insights/ecg`'s `MAX_RECORDINGS`. */
const MAX_ECG_RECORDINGS = 200;

/**
 * Output schema for `get_ecg_recordings` — METADATA only. `waveformEncrypted`
 * is never selected by the underlying query, let alone shaped here.
 * `classification` is the device's own verbatim verdict; `classificationSource`
 * is a fixed literal so a caller can never mistake it for a HealthLog-derived
 * read.
 */
const getEcgRecordingsOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  classificationSource: z.literal("device").optional(),
  recordings: z
    .array(
      z.object({
        id: z.string(),
        recordedAt: z.string(),
        durationSeconds: z.number().nullable(),
        samplingFrequency: z.number(),
        sampleCount: z.number(),
        averageHeartRate: z.number().nullable(),
        lead: z.string().nullable(),
        classification: z.string().nullable(),
        source: z.string(),
        hasWaveform: z.boolean(),
      }),
    )
    .optional(),
};

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_metrics",
    title: "List available metrics",
    description:
      "Enumerate which of the user's health data exists and how to fetch it: one row per domain with whether data is present, an approximate sample count, and the tool that retrieves it. Call this first to discover what is available before fetching figures.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: listMetricsOutput,
    async run(ctx) {
      const [inventory, statusDiscoveryRows] = await Promise.all([
        buildCoachDataInventory(ctx.userId, undefined),
        // v1.30 coverage review (G5/C4) — the metric-status-only set
        // (wrist temperature, cardio recovery, sleep score, breathing
        // disturbances, strain/load, …) is resolvable via `compare_metric` /
        // `get_metric_baseline` but sits off the Coach snapshot inventory, so
        // it never advertised itself here. Appended as supplement rows
        // rather than folded into `buildCoachDataInventory` (Coach-owned)
        // to keep the addition MCP-side, mirroring how the `search` probe
        // already surfaces the sibling v1.25 clinical-signal set.
        metricStatusDiscoveryRows(ctx.userId),
      ]);
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "list_metrics", present: true },
      });
      return {
        present: true,
        window: inventory.window,
        restMode: inventory.restMode,
        cycleEnabled: inventory.cycleEnabled,
        metrics: [...inventory.entries, ...statusDiscoveryRows],
      };
    },
  },
  {
    name: "get_metric_series",
    title: "Get a metric time series",
    description:
      "Fetch the user's own time series for ONE metric (e.g. bp, weight, pulse, hrv, resting_hr, steps, sleep, body composition, vo2_max). Returns an aggregate (count, min, max, mean, slope) plus recent-daily and weekly timelines, with units and population reference bands for safe phrasing. Returns { present: false } when the user has no data for that metric.",
    inputShape: {
      metric: coachScopeSourceSchema,
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_metric_series", args);
    },
  },
  {
    name: "get_medication_compliance",
    title: "Get medication compliance",
    description:
      "Fetch the user's cadence-aware medication adherence: the dose-weighted compliance rate, expected vs taken/missed counts, current-cycle status, and any GLP-1 titration context. Returns { present: false } when no medications are tracked.",
    inputShape: {
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_medication_compliance", args);
    },
  },
  {
    name: "get_labs",
    title: "Get lab results",
    description:
      "Fetch the user's lab results. By default returns the latest reading per biomarker over the last 12 months, optionally filtered to one named analyte. Pass history:true with an analyte to return that analyte's reading TRAJECTORY (newest first, paginated). Each reading carries its value, unit, reference range, and in-range/below/above status. Returns { present: false } when no labs match.",
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
      // Default: latest reading per biomarker via the Coach labs read.
      return runCoachTool(ctx, "get_labs", {
        ...(typeof args.analyte === "string" ? { analyte: args.analyte } : {}),
      });
    },
  },
  {
    name: "get_correlations",
    title: "Get discovered correlations",
    description:
      "Fetch the user's statistically-vetted (FDR-controlled) day-to-next-day driver pairs between behaviours (daylight, mood, glucose, blood pressure, steps) and outcomes (sleep, HRV, resting HR, weight), each with direction, lag, sample size, and a descriptive — never causal — note over a fixed trailing window. Returns { present: false } when too little paired data exists.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_correlations", args);
    },
  },
  // ── Phase 4 deep-value reads (catalogue §5 #1, #3, #4, #7) ──────────
  {
    name: "get_correlation",
    title: "Get a correlation between two metrics",
    description:
      "Fetch the statistically-vetted (FDR-controlled), lag-aware association between TWO named metrics the user tracks (e.g. 'sleep' and 'resting heart rate'). Re-exports the same discovery engine the other correlation surfaces run; returns the matched pair's direction, lag, sample size, Pearson r, and a descriptive — never causal — note. Returns { present: false } when no significant pattern links the pair (sparse data or the link did not clear the engine's floors).",
    inputShape: {
      metricA: z.string().min(1).max(60),
      metricB: z.string().min(1).max(60),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getCorrelationOutput,
    run(ctx, args) {
      return getCorrelation(ctx.userId, {
        metricA: String(args.metricA ?? ""),
        metricB: String(args.metricB ?? ""),
      });
    },
  },
  {
    name: "compare_metric",
    title: "Compare metrics or windows",
    description:
      "Compare one metric against another over the same horizon, OR a single metric across two horizons. A horizon is either one of the five fixed trailing windows OR an explicit {from,to} date range (use `range`/`rangeB` for before-vs-after-a-date). Also resolves the clinical-signal metrics (grip strength, pain 0–10 NRS, waist circumference, waist-to-height ratio). A metric can be named by its alias, its key, or its display name in any language HealthLog ships (e.g. 'poids', 'Blutzucker'). Returns each side's rollup statistics (count, mean, min, max) with units and reference bands, plus a delta + percent change when both sides share a unit. Returns { present: false } when a side has no data.",
    inputShape: {
      metric: z.string().min(1).max(60),
      metricB: z.string().min(1).max(60).optional(),
      window: coachScopeWindowSchema.optional(),
      windowB: coachScopeWindowSchema.optional(),
      range: dateRangeShape.optional(),
      rangeB: dateRangeShape.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: compareMetricOutput,
    run(ctx, args) {
      return compareMetric(ctx.userId, {
        metric: String(args.metric ?? ""),
        metricB: typeof args.metricB === "string" ? args.metricB : undefined,
        window: args.window as never,
        windowB: args.windowB as never,
        range: args.range as DateRange | undefined,
        rangeB: args.rangeB as DateRange | undefined,
      });
    },
  },
  {
    name: "get_metric_baseline",
    title: "Get a metric's personal baseline",
    description:
      "Fetch where the user's latest reading for ONE metric sits against their own usual range (median ± robust deviation), plus the strongest lagged driver of that metric. Re-exports the same baseline engine the metric page renders. Also resolves the clinical-signal metrics (grip strength, pain 0–10 NRS, waist circumference, waist-to-height ratio). A metric can be named by its alias, its key, or its display name in any language HealthLog ships (e.g. 'poids', 'Blutzucker'). Returns the personal band, today's value + placement (within/above/below), and the population reference band. Returns { present: false } with reason 'insufficient_history' below the 7-day learning floor — never a fabricated range.",
    inputShape: {
      metric: z.string().min(1).max(60),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getMetricBaselineOutput,
    run(ctx, args) {
      return getMetricBaseline(ctx.userId, {
        metric: String(args.metric ?? ""),
      });
    },
  },
  {
    name: "detect_changepoints",
    title: "Detect level shifts in a metric",
    description:
      "Surface points where a metric's level shifted over a trailing window OR an explicit {from,to} date range (e.g. 'when did my weight trend change?'). Also resolves the clinical-signal metrics (grip strength, pain 0–10 NRS, waist circumference, waist-to-height ratio). A metric can be named by its alias, its key, or its display name in any language HealthLog ships (e.g. 'poids', 'Blutzucker'). Runs a conservative changepoint scan over the rollup tier's bucket means and reports each shift's date, direction, and before/after means with units. High firing bar — returns { present: false } when too little data exists or no shift clears the threshold.",
    inputShape: {
      metric: z.string().min(1).max(60),
      window: coachScopeWindowSchema.optional(),
      range: dateRangeShape.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: detectChangepointsOutput,
    run(ctx, args) {
      return detectChangepoints(ctx.userId, {
        metric: String(args.metric ?? ""),
        window: args.window as never,
        range: args.range as DateRange | undefined,
      });
    },
  },
  // ── Coach-F1 reads bridged to the wire (catalogue Tier 1) ───────────
  // Each is a thin `runCoachTool` glue over an already-built, grounded Coach
  // retrieval tool — same gates, units, and `{ present: false }` contract. The
  // `list_metrics` inventory already advertises these, so wiring them here
  // closes the prior advertise-but-missing self-inconsistency.
  {
    name: "get_glucose_panel",
    title: "Get the glucose panel",
    description:
      "Fetch the user's glucose data: per-context daily means plus the trailing-30-day clinical panel (time-in-range, GMI, CV%, estimated A1c). Returns { present: false } when the user logs no glucose.",
    inputShape: {
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_glucose_panel", args);
    },
  },
  {
    name: "get_sleep",
    title: "Get sleep",
    description:
      "Fetch the user's sleep: per-night asleep + stage minutes plus the sleep-rhythm summary (sleep debt + chronotype). Returns { present: false } when no sleep is tracked.",
    inputShape: {
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_sleep", args);
    },
  },
  {
    name: "get_workouts",
    title: "Get workouts",
    description:
      "Fetch the user's workouts: the most recent sessions (sport, duration, energy, distance, avg/max HR) plus a per-sport rollup over the window. Use for training-load and 'how were my runs / am I overtraining?' questions. Returns { present: false } when no workouts are tracked.",
    inputShape: {
      window: coachScopeWindowSchema.optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_workouts", args);
    },
  },
  {
    name: "get_illness_recovery",
    title: "Get illness & recovery",
    description:
      "Fetch the user's illness + recovery context: rest mode, active and recently-resolved illnesses, the recovery / strain composites, and the illness retrospective (recovery-gap, nadir, red flags). Carries the rest-mode safety flag for framing. Returns { present: false } when there is nothing to report.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_illness_recovery", args);
    },
  },
  {
    name: "get_cycle",
    title: "Get menstrual cycle",
    description:
      "Fetch the user's menstrual-cycle context: current phase + day-of-cycle, the next predicted event, and the headline phase-correlation finding. Descriptive only — never a contraception-grade or 'safe day' claim. Gated on cycle tracking being enabled for the account; returns { present: false } when cycle tracking is off or there is no data.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: coachReadOutput,
    run(ctx, args) {
      return runCoachTool(ctx, "get_cycle", args);
    },
  },
  // ── Multi-metric fan-out (catalogue: query expressiveness) ──────────
  {
    name: "get_metrics",
    title: "Get several metric series at once",
    description:
      "Fetch the time series for SEVERAL metrics in one call — a fan-out over the same single-metric read `get_metric_series` runs, returning one grounded result per metric (each with { present } and the metric's aggregate/timelines when present). Paginated: when more metrics remain than fit one page, pass the opaque nextCursor back as `cursor`. Use for a multi-metric question instead of many separate calls.",
    inputShape: {
      metrics: z
        .array(z.string().min(1).max(60))
        .min(1)
        .max(MAX_METRICS_PER_CALL)
        .describe(
          "The metrics to fetch (e.g. ['weight','pulse','hrv']). Unknown metrics return { present: false } for that entry, never an error.",
        ),
      window: coachScopeWindowSchema.optional(),
      cursor: z
        .string()
        .max(256)
        .optional()
        .describe(
          "Opaque pagination cursor from a previous response's nextCursor. Treat as a black box.",
        ),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getMetricsOutput,
    async run(ctx, args) {
      const requested = Array.isArray(args.metrics)
        ? args.metrics
            .filter((m): m is string => typeof m === "string")
            .map((m) => m.trim())
            .filter((m) => m.length > 0)
            .slice(0, MAX_METRICS_PER_CALL)
        : [];
      const window = typeof args.window === "string" ? args.window : undefined;

      const offset = decodeOffsetCursor(args.cursor);
      const page = requested.slice(offset, offset + METRICS_PAGE_SIZE);
      const hasMore = offset + METRICS_PAGE_SIZE < requested.length;

      // Fan out over the SAME single-metric read; the executor validates each
      // metric and returns a grounded `{ present, … }` (never throws), so one
      // unknown metric cannot break the batch.
      const results = await Promise.all(
        page.map(async (metric) => {
          const r = (await executeCoachTool({
            userId: ctx.userId,
            name: "get_metric_series",
            rawArguments: JSON.stringify({
              metric,
              ...(window ? { window } : {}),
            }),
          })) as {
            present: boolean;
            reason?: string;
            data?: unknown;
            grounding?: string;
          };
          return {
            metric,
            present: r.present,
            ...(r.reason ? { reason: r.reason } : {}),
            ...(r.data !== undefined ? { data: r.data } : {}),
            ...(r.grounding ? { grounding: r.grounding } : {}),
          };
        }),
      );

      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: {
          tool: "get_metrics",
          present: results.some((r) => r.present),
        },
      });
      return {
        present: results.some((r) => r.present),
        ...(window ? { window } : {}),
        results,
        ...(hasMore
          ? { nextCursor: encodeOffsetCursor(offset + METRICS_PAGE_SIZE) }
          : {}),
      };
    },
  },
  // ── Operational reads (not Coach snapshot domains) ──────────────────
  // These answer "what should I do / why is my data stale" rather than "what
  // are my figures". They are NOT in the Coach data inventory (which enumerates
  // metric domains); each is a thin façade over an existing server-authoritative
  // engine — the medication recurrence engine, the integration-status ledger,
  // and the persisted Vorsorge reminder due dates — and never recomputes.
  {
    name: "get_medication_schedule",
    title: "Get the medication schedule",
    description:
      "Fetch when the user's active medications are next due, and which are overdue right now. Reuses the same server-authoritative recurrence engine the medication cards render (open overdue slots win over future ones). Returns one row per active medication: name, dose, next-due instant, an overdue flag, an as-needed (PRN) flag, and an intakeTracked flag. As-needed medications and medications whose intake tracking is off (intakeTracked: false, kept as a record only) have no due time (nextDueAt: null). Returns { present: false } when no medications are tracked.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getMedicationScheduleOutput,
    async run(ctx) {
      const now = new Date();
      const [user, medications] = await Promise.all([
        prisma.user.findUnique({
          where: { id: ctx.userId },
          select: { timezone: true },
        }),
        prisma.medication.findMany({
          where: { userId: ctx.userId, active: true },
          include: { schedules: true },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      if (medications.length === 0) {
        annotate({
          action: { name: "mcp.tool.invoked" },
          meta: { tool: "get_medication_schedule", present: false },
        });
        return { present: false };
      }

      const userTz = user?.timezone || "Europe/Berlin";

      // Same feeder reads + horizon the medications list route / dashboard
      // builder use, so the open-overdue detection matches the in-app cards.
      const resolvedWindowStart = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);
      const resolvedWindowEnd = new Date(
        now.getTime() + 2 * 24 * 60 * 60 * 1000,
      );
      const [latestIntakes, resolvedEvents, eraFloors] = await Promise.all([
        prisma.medicationIntakeEvent.groupBy({
          by: ["medicationId"],
          where: {
            userId: ctx.userId,
            deletedAt: null,
            skipped: false,
            takenAt: { not: null },
          },
          _max: { takenAt: true },
        }),
        prisma.medicationIntakeEvent.findMany({
          where: {
            userId: ctx.userId,
            deletedAt: null,
            scheduledFor: { gte: resolvedWindowStart, lte: resolvedWindowEnd },
            OR: [
              { takenAt: { not: null } },
              { skipped: true },
              { autoMissed: true },
            ],
          },
          select: { medicationId: true, scheduledFor: true, takenAt: true },
        }),
        prisma.medicationScheduleRevision.groupBy({
          by: ["medicationId"],
          where: {
            medication: { userId: ctx.userId },
            supersededByRevisionId: null,
          },
          _max: { validUntil: true },
        }),
      ]);

      const lastTakenAtByMedId = new Map<string, Date | null>(
        latestIntakes.map((e) => [e.medicationId, e._max.takenAt]),
      );
      const resolvedSlotsByMedId = new Map<string, ResolvedSlotMark[]>();
      for (const e of resolvedEvents) {
        const mark = toResolvedSlotMark(e);
        const list = resolvedSlotsByMedId.get(e.medicationId);
        if (list) list.push(mark);
        else resolvedSlotsByMedId.set(e.medicationId, [mark]);
      }
      // The live era start per medication (see `live-era.ts`).
      const eraStartByMedId = liveEraStartsByMedication(eraFloors);

      const rows = medications.map((m) => {
        const display = computeDisplayDue({
          medication: {
            id: m.id,
            startsOn: m.startsOn,
            endsOn: m.endsOn,
            oneShot: m.oneShot,
            createdAt: m.createdAt,
          },
          // v1.39.1 (#1033) — nothing is due on a medication with intake
          // tracking off.
          schedules: dueSchedules(m),
          now,
          userTz,
          lastIntakeAt: lastTakenAtByMedId.get(m.id) ?? null,
          resolvedSlots: resolvedSlotsByMedId.get(m.id) ?? [],
          eraStart: eraStartByMedId.get(m.id) ?? null,
        });
        return {
          name: m.name,
          dose: m.dose,
          nextDueAt: display ? display.at.toISOString() : null,
          overdue: display ? display.overdue : false,
          asNeeded: m.asNeeded,
          intakeTracked: m.trackIntake,
        };
      });

      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_medication_schedule", present: true },
      });
      return { present: true, medications: rows };
    },
  },
  {
    name: "get_integration_status",
    title: "Get device & service sync status",
    description:
      "Fetch the sync health of the user's connected devices and services (Withings, WHOOP, Fitbit, Nightscout, Polar, Oura, Strava, Google Health) — which are connected, when each last synced, and whether one needs reconnecting or is failing. Answers 'why is my data stale?'. Reuses the integration-status ledger; carries no secrets or tokens. `connected` means only 'not explicitly disconnected'; `verdict` is the liveness truth (fresh / stale / stalled / failing / reauth_required / parked / pending_first_sync / disconnected), where `stalled` means the sync has stopped even attempting. Returns { present: false } when no integration has ever attempted a sync.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getIntegrationStatusOutput,
    async run(ctx) {
      // Only providers with a status row have actually attempted a sync — a
      // synthetic "never attempted" provider must NOT be reported as connected.
      const rows = await prisma.integrationStatus.findMany({
        where: { userId: ctx.userId },
        select: { integration: true },
      });
      if (rows.length === 0) {
        annotate({
          action: { name: "mcp.tool.invoked" },
          meta: { tool: "get_integration_status", present: false },
        });
        return { present: false };
      }

      const providers = await Promise.all(
        rows.map(async (r) => {
          const s = await getIntegrationStatus(
            ctx.userId,
            r.integration as IntegrationKey,
          );
          // `connected` means "not explicitly disconnected" and says nothing
          // about liveness — a month-dead pull still reads true. `verdict` is
          // the liveness truth, resolved by the same server-side rule the
          // Settings page renders.
          const health = resolveSyncVerdict({
            configured: true,
            state: s.state,
            lastSuccessAt: s.lastSuccessAt,
            lastAttemptAt: s.lastAttemptAt,
            failingSinceAt: s.failingSince,
            cadence: INTEGRATION_CADENCE[s.integration],
          });
          return {
            provider: s.integration,
            state: s.state,
            connected: s.state !== "disconnected",
            reauthRequired: s.state === "error_reauth" || s.state === "parked",
            lastSuccessAt: s.lastSuccessAt,
            lastAttemptAt: s.lastAttemptAt,
            verdict: health.verdict,
            since: health.since,
          };
        }),
      );

      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_integration_status", present: true },
      });
      return { present: true, providers };
    },
  },
  {
    name: "get_preventive_care",
    title: "Get preventive-care due-list",
    description:
      "Fetch what preventive care is coming up: the user's own configured preventive-care (Vorsorge) reminders (upcoming and overdue checkups with their next-due dates) AND the appointments they have booked as future visits. Surfaces only the reminders the user has already set up (it never invents screening recommendations); each checkup carries its label, optional measurement type, next-due instant, an overdue flag, and last-completed date. Each `appointments` entry carries its date, practitioner name + specialty, visit kind, and the visit's own free-text reason. Returns { present: false } only when neither a reminder nor an appointment exists.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getPreventiveCareOutput,
    async run(ctx) {
      const now = new Date();
      // Upcoming appointments ride alongside the Vorsorge due-list, read from
      // `Encounter` (a booked visit in the future). They are a NAMED field on
      // this result, not a second tool, so "what is coming up" is one answer.
      const appointmentRows = await prisma.encounter.findMany({
        where: {
          userId: ctx.userId,
          deletedAt: null,
          status: "PLANNED",
          occurredAt: { gt: now },
        },
        orderBy: { occurredAt: "asc" },
        take: MAX_APPOINTMENTS,
        include: { practitioner: { select: { name: true, specialty: true } } },
      });
      const appointments = appointmentRows.map((r) => {
        const reason = decryptVisitText(r.reasonEncrypted);
        return {
          occurredAt: r.occurredAt.toISOString(),
          practitioner: r.practitioner
            ? scrubFenceMarkers(r.practitioner.name)
            : null,
          specialty: r.practitioner?.specialty
            ? scrubFenceMarkers(r.practitioner.specialty)
            : null,
          kind: r.kind,
          // A visit's reason is user- and document-derived free text, so it
          // rides the same USER_TEXT wrapping every other free-text field uses.
          reason: reason !== null ? fenceUserText(reason) : null,
        };
      });

      const reminders = await prisma.measurementReminder.findMany({
        // A booked visit's one-shot reminder rides this same engine with
        // `origin: ENCOUNTER`. It is not a checkup and must not appear on a
        // Vorsorge surface, or the list fills with appointments. Four read
        // sites carry this exclusion; `encounter-reminder-exclusion.test.ts`
        // proves every one of them, and the DTO mapper refuses such a row
        // outright so a site that lost its filter fails loudly.
        where: {
          userId: ctx.userId,
          deletedAt: null,
          enabled: true,
          origin: { not: "ENCOUNTER" },
        },
        // Most-urgent first; a null next-due (uncomputable) sinks to the end.
        orderBy: [
          { nextDueAt: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
        ],
      });
      // Present when EITHER arm carries something: a person with a booked
      // appointment but no configured Vorsorge reminder still has preventive
      // care coming up, and hiding the appointment behind `present: false`
      // would be the silent-zero this contract forbids.
      if (reminders.length === 0 && appointments.length === 0) {
        annotate({
          action: { name: "mcp.tool.invoked" },
          meta: { tool: "get_preventive_care", present: false },
        });
        return { present: false };
      }

      // Overdue is a CALENDAR-day verdict, the same one the checkups screen
      // renders. Comparing the instants said a checkup booked for nine this
      // morning was overdue by ten past, so the tool called something overdue
      // on the very day it is due while the screen next to it read "today".
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { timezone: true },
      });
      const timezone = user?.timezone || DEFAULT_TIMEZONE;
      const checkups = reminders.map((r) => {
        const dto = toMeasurementReminderDto(r);
        return {
          // Label and location are the user's own free text — same fencing
          // the sibling appointment `reason` carries, so a forged marker in
          // a reminder cannot impersonate the fence around its neighbours.
          label: fenceUserText(dto.label),
          measurementType: dto.measurementType,
          nextDueAt: dto.nextDueAt,
          overdue:
            dto.nextDueAt !== null
              ? calendarDaysUntil(new Date(dto.nextDueAt), now, timezone) < 0
              : false,
          location: dto.location !== null ? fenceUserText(dto.location) : null,
          lastSatisfiedAt: dto.lastSatisfiedAt,
          // Timestamps + a counter, no free text — nothing to fence here.
          snoozedUntil: dto.snoozedUntil,
          lastSkippedAt: dto.lastSkippedAt,
          skipCount: dto.skipCount,
        };
      });

      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_preventive_care", present: true },
      });
      return {
        present: true,
        ...(checkups.length > 0 ? { checkups } : {}),
        ...(appointments.length > 0 ? { appointments } : {}),
      };
    },
  },
  // ── v1.30 coverage review (G1) — the nutrients pipeline ─────────────
  {
    name: "get_nutrients",
    title: "Get nutrient intake",
    description:
      "Fetch the user's synced micronutrient intake — water, caffeine, and the 24 tracked vitamins/minerals — as day totals summed across sources (e.g. an Apple Health sync AND a manual water entry on the same day). Omit `nutrient` for a presence overview across every logged code (latest logged day, latest day's total, days with data). Pass a catalog code, or the nutrient's display name in any language HealthLog ships (e.g. 'water', 'magnesium', 'vitamin_d', 'Magnésium', 'Żelazo'), for that nutrient's per-day series over a trailing window, plus its EFSA dietary reference resolved against the user's own profile sex — omitted, never guessed, when sex is not on file. Gated on the opt-in `nutrients` module. Returns { present: false, reason: \"module_disabled\" } when the module is off, or { present: false } when nothing matches.",
    inputShape: {
      nutrient: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe(
          "A catalog code (e.g. 'water', 'caffeine', 'vitamin_d', 'magnesium') or its display name in any language HealthLog ships. Omit for a presence overview across all logged nutrients.",
        ),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe(
          "Trailing window in days. Overview mode (no `nutrient`) defaults to 14, capped at 365. Per-nutrient mode defaults to 30, capped at 90.",
        ),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getNutrientsOutput,
    async run(ctx, args) {
      const result = await getNutrients(ctx.userId, {
        nutrient: typeof args.nutrient === "string" ? args.nutrient : undefined,
        days: typeof args.days === "number" ? args.days : undefined,
      });
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_nutrients", present: result.present },
      });
      return result;
    },
  },
  // ── v1.30 coverage review (G2) — the intraday pulse / "shape of the day" ──
  {
    name: "get_intraday_pulse",
    title: "Get the intraday pulse shape",
    description:
      "Fetch the user's own 10-minute heart-rate shape for ONE local day — 'what happened this afternoon?', 'was I tense during the meeting?'. When every confidence gate holds, also carries a single cautious elevated-at-rest ('tension') window: a DESCRIPTIVE pattern only, NEVER a stress diagnosis. Falls back to an hourly-grain shape for a day outside the dense-retention window — see the `resolution` field ('tenMin' vs 'hourly'); `tension` is only ever computed at the dense grain. Pulse is a core vital: no AI switch and no module gate apply. Returns { present: false } when the day has no pulse data.",
    inputShape: {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          "YYYY-MM-DD in the user's own timezone. Defaults to the user's local today.",
        ),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getIntradayPulseOutput,
    async run(ctx, args) {
      // Mirrors `GET /api/insights/pulse/intraday`: a computation over core
      // vitals, served whatever the AI analysis opt-out says.
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { timezone: true },
      });
      const timezone = user?.timezone || DEFAULT_TIMEZONE;
      const dateKey =
        typeof args.date === "string" && args.date
          ? args.date
          : userDayKey(new Date(), timezone);

      const result = await loadIntradayPulse(ctx.userId, timezone, dateKey);
      const present = result.series.length > 0;

      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_intraday_pulse", present },
      });
      return {
        present,
        ...(present ? {} : { reason: "no_data" }),
        dateKey: result.dateKey,
        timezone: result.timezone,
        bucketMinutes: result.bucketMinutes,
        resolution: result.resolution,
        series: result.series,
        baseline: result.baseline,
        baselineSource: result.baselineSource,
        tension: result.tension,
      };
    },
  },
  // ── v1.30 coverage review (G3) — ECG recording metadata ─────────────
  {
    name: "get_ecg_recordings",
    title: "Get ECG recordings",
    description:
      "Fetch METADATA for the user's own ECG recordings — recorded time, duration, sampling rate, sample count, average heart rate, lead, and the DEVICE's own rhythm classification. NEVER reads or returns the waveform (that stays app-only). Non-diagnostic: this reflects ONLY the classification result the recording device's own certified on-device algorithm produced — HealthLog never re-classifies an ECG and never forms a diagnosis from it; `classificationSource` is always the fixed literal 'device'. Device data: no AI switch and no module gate apply. Returns { present: false } when no recordings exist.",
    inputShape: {},
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getEcgRecordingsOutput,
    async run(ctx) {
      // Device data, served whatever the AI switches or the AI analysis
      // opt-out say, like `GET /api/insights/ecg`.
      const rows = await prisma.ecgRecording.findMany({
        where: { userId: ctx.userId },
        // Everything EXCEPT `waveformEncrypted` — mirrors `GET
        // /api/insights/ecg`'s own select exactly; no decrypt ever happens
        // on this path.
        select: {
          id: true,
          recordedAt: true,
          durationSeconds: true,
          samplingFrequency: true,
          sampleCount: true,
          averageHeartRate: true,
          lead: true,
          rhythmClassification: true,
          source: true,
        },
        orderBy: { recordedAt: "desc" },
        take: MAX_ECG_RECORDINGS,
      });

      if (rows.length === 0) {
        annotate({
          action: { name: "mcp.tool.invoked" },
          meta: { tool: "get_ecg_recordings", present: false },
        });
        return { present: false, reason: "no_data" };
      }

      const recordings = rows.map((r) => ({
        id: r.id,
        recordedAt: r.recordedAt.toISOString(),
        durationSeconds: r.durationSeconds,
        samplingFrequency: r.samplingFrequency,
        sampleCount: r.sampleCount,
        averageHeartRate: r.averageHeartRate,
        lead: r.lead,
        classification: r.rhythmClassification,
        source: r.source,
        // A `ts-` fallback event carries a verdict but no signal to fetch.
        hasWaveform: r.sampleCount > 0,
      }));

      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_ecg_recordings", present: true },
      });
      return {
        present: true,
        classificationSource: "device" as const,
        recordings,
      };
    },
  },
  // ── v1.38 — the visit history, bounded ──────────────────────────────
  {
    name: "get_visits",
    title: "Get past doctor visits",
    description:
      "Fetch the user's own past doctor visits over a bounded window (default: the last 12 months) so a question like 'when did I last see a cardiologist' is answerable from the record. Each visit carries its date, lifecycle status (DONE / CANCELLED / NO_SHOW — a no-show is not a visit that happened), kind, practitioner name + specialty, the visit's own free-text reason and outcome, the body site and side (set on procedures), and the labels of any conditions it was filed against. Optionally narrow to one practitioner by a name substring, or to one kind. kind PROCEDURE is the procedure and surgery history: without a months argument it reads the whole record, because a surgery years ago is still the answer to 'what surgeries have I had'. Newest first, bounded. Returns { present: false } when the user has never recorded a visit — distinct from a filtered read that simply matched none.",
    inputShape: {
      months: z
        .number()
        .int()
        .min(1)
        .max(MAX_VISITS_WINDOW_MONTHS)
        .optional()
        .describe(
          "Trailing window in months. Defaults to 12, capped at 60. Past visits only — a future appointment is surfaced by get_preventive_care, not here.",
        ),
      practitioner: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Optional case-insensitive name substring to narrow to one practitioner (e.g. a surname read back from an earlier result). Omit for every practitioner.",
        ),
      kind: encounterKindEnum
        .optional()
        .describe(
          "Optional visit kind to narrow to. PROCEDURE lists procedures and surgeries, over the whole record unless months is given.",
        ),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    outputShape: getVisitsOutput,
    async run(ctx, args) {
      const kindArg = encounterKindEnum.safeParse(args.kind);
      const kind = kindArg.success ? kindArg.data : undefined;
      // A procedure history is lifetime reference data; every other read keeps
      // the default year. A window the caller names always wins.
      const months =
        typeof args.months === "number"
          ? args.months
          : kind === "PROCEDURE"
            ? null
            : DEFAULT_VISITS_WINDOW_MONTHS;
      const practitioner =
        typeof args.practitioner === "string" && args.practitioner.trim()
          ? args.practitioner.trim()
          : undefined;
      const now = new Date();
      const cutoff = months === null ? null : new Date(now);
      cutoff?.setMonth(cutoff.getMonth() - (months ?? 0));

      const rows = await prisma.encounter.findMany({
        // `userId` is the resolved session's, never an argument — a visit
        // belonging to another account is unreachable by construction.
        where: {
          userId: ctx.userId,
          deletedAt: null,
          occurredAt: { ...(cutoff ? { gte: cutoff } : {}), lte: now },
          ...(kind ? { kind } : {}),
          ...(practitioner
            ? {
                practitioner: {
                  is: {
                    name: { contains: practitioner, mode: "insensitive" },
                    deletedAt: null,
                  },
                },
              }
            : {}),
        },
        orderBy: { occurredAt: "desc" },
        take: MAX_VISITS,
        include: { practitioner: { select: { name: true, specialty: true } } },
      });

      // Absence is explicit. An empty list is { present: false } — "you have
      // never recorded a visit" — NEVER { present: true, visits: [] }, which
      // would read as "you have no visits", a claim the empty read cannot make.
      if (rows.length === 0) {
        annotate({
          action: { name: "mcp.tool.invoked" },
          meta: { tool: "get_visits", present: false },
        });
        return { present: false };
      }

      // The linked condition labels, one grouped read for the whole page, from
      // the same link service every other visit surface goes through.
      const conditionsBySource = await listTargetsBySource(prisma, {
        userId: ctx.userId,
        sourceKind: "encounter",
        sourceIds: rows.map((r) => r.id),
        targetKind: "conditionEpisode",
      });

      const visits = rows.map((r) => {
        const reason = decryptVisitText(r.reasonEncrypted);
        const outcome = decryptVisitText(r.outcomeEncrypted);
        const bodySite = decryptVisitText(r.bodySiteEncrypted);
        return {
          occurredAt: r.occurredAt.toISOString(),
          status: r.status,
          kind: r.kind,
          practitioner: r.practitioner
            ? scrubFenceMarkers(r.practitioner.name)
            : null,
          specialty: r.practitioner?.specialty
            ? scrubFenceMarkers(r.practitioner.specialty)
            : null,
          // Reason and outcome are user- and document-derived free text, so
          // they ride the USER_TEXT wrapping; the markers are stripped from the
          // content they wrap. A condition label is the user's own free text
          // too — scrubbed of any forged marker before it enters the payload.
          reason: reason !== null ? fenceUserText(reason) : null,
          outcome: outcome !== null ? fenceUserText(outcome) : null,
          bodySite: bodySite !== null ? fenceUserText(bodySite) : null,
          laterality: r.laterality,
          conditions: (conditionsBySource.get(r.id) ?? []).map((c) =>
            scrubFenceMarkers(c.label),
          ),
        };
      });

      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_visits", present: true },
      });
      return { present: true, windowMonths: months, visits };
    },
  },
  ...searchAndFetchTools(),
];

/** Stable list of the registered tool names. */
export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);
