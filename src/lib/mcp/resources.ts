/**
 * Transport-agnostic MCP resource registry.
 *
 * Resources expose read-only context the assistant can surface alongside tool
 * results (REQ-R10). Like the tools, they are server-authoritative reads of the
 * canonical tables scoped to the session `userId` — no new analytics, no
 * caller-supplied id. Absence is explicit via `{ present: false }` (REQ-SEC-4).
 *
 * Two shapes live here:
 *   - FIXED resources (`MCP_RESOURCES`) — one concrete URI each (profile,
 *     medications, the biomarker catalogue, the data inventory, the
 *     doctor-visit summary).
 *   - resource TEMPLATES (`MCP_RESOURCE_TEMPLATES`) — RFC 6570 URI templates
 *     (`healthlog://metric/{type}`, `healthlog://lab/{analyte}`,
 *     `healthlog://medication/{id}`, …) that give a host a per-item address it
 *     can attach without a tool round-trip. Each template is a thin façade over
 *     the SAME server-authoritative read path the matching tool already uses, so
 *     the wire shape can never fork. Per-variable completion + per-template
 *     listing are user-scoped, so they double as honest discovery: a host only
 *     ever sees the metrics / analytes / medications the user actually has.
 *
 * The profile resource is deliberately data-minimised: it ships only the
 * health-relevant context an assistant needs (age in whole years, gender,
 * height, timezone, unit preferences) and omits direct identifiers (email,
 * username, role, insurance number) — narrowing the surface on the
 * external-assistant boundary.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
import {
  BIOMARKER_CATALOG,
  BIOMARKER_PANELS,
} from "@/lib/labs/biomarker-catalog";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { resolveSavedSelection } from "@/lib/report-selection/saved-profile";
import { isModuleEnabled } from "@/lib/modules/gate";
import { NUTRIENT_CODES, type NutrientCode } from "@/lib/nutrients/catalog";
import { getNutrients, NUTRIENT_LABELS } from "@/lib/mcp/nutrients-read";
import { metricStatusDiscoveryRows } from "@/lib/mcp/rich-reads";
import { summariseForVisit } from "./doctor-visit-summary";
import type { McpAuthContext } from "./auth";

export interface McpResourceDefinition {
  name: string;
  /** Fixed resource URI (e.g. `healthlog://profile`). */
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  read: (ctx: McpAuthContext) => Promise<unknown>;
}

/**
 * A parameterised resource (RFC 6570 URI template). Bound to one session in
 * `createMcpServer`, so both `complete` and `list` are user-scoped — they only
 * ever surface the data this user owns. `read` resolves one concrete instance
 * from its matched template variables.
 */
export interface McpResourceTemplateDefinition {
  name: string;
  /** RFC 6570 URI template (e.g. `healthlog://metric/{type}/{window}`). */
  uriTemplate: string;
  title: string;
  description: string;
  mimeType: string;
  /**
   * Per-variable autocomplete sources, user-scoped. The host calls these as the
   * user types a template variable; returning only the user's own metrics /
   * analytes makes completion double as honest discovery.
   */
  complete?: Record<
    string,
    (ctx: McpAuthContext, value: string) => Promise<string[]> | string[]
  >;
  /**
   * Optional user-scoped enumeration of the concrete resources this template
   * resolves to. Gives a host a browseable list without a tool round-trip.
   */
  list?: (
    ctx: McpAuthContext,
  ) => Promise<Array<{ uri: string; name: string; title?: string }>>;
  /** Resolve one instance from its matched template variables (user-scoped). */
  read: (
    ctx: McpAuthContext,
    variables: Record<string, string | string[] | undefined>,
  ) => Promise<unknown>;
}

/** The fixed trailing windows the windowed reads accept (mirrors the Coach). */
export const MCP_WINDOW_VALUES = [
  "last7days",
  "last30days",
  "last90days",
  "lastYear",
  "allTime",
] as const;

/** Trailing-day count per window, capped at the doctor-report 365-day ceiling. */
const WINDOW_DAYS: Record<string, number> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  lastYear: 365,
  allTime: 365,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole-year age from a date of birth, or null when unknown. */
function ageYears(dateOfBirth: Date | null): number | null {
  if (!dateOfBirth) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())
  ) {
    age -= 1;
  }
  return age >= 0 && age < 150 ? age : null;
}

/** First value of a template variable that may arrive exploded as an array. */
function firstVar(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export const MCP_RESOURCES: McpResourceDefinition[] = [
  {
    name: "profile",
    uri: "healthlog://profile",
    title: "User profile",
    description:
      "The user's health-relevant profile context: age, gender, height, timezone, and unit preferences. Identifiers are omitted.",
    mimeType: "application/json",
    async read(ctx) {
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: {
          heightCm: true,
          dateOfBirth: true,
          gender: true,
          timezone: true,
          unitPreference: true,
          glucoseUnit: true,
        },
      });
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "profile", present: user !== null },
      });
      if (!user) return { present: false };
      return {
        present: true,
        ageYears: ageYears(user.dateOfBirth),
        gender: user.gender ?? null,
        heightCm: user.heightCm ?? null,
        timezone: user.timezone,
        unitPreference:
          user.unitPreference === "imperial" ? "imperial" : "metric",
        glucoseUnit: user.glucoseUnit ?? "mg/dL",
      };
    },
  },
  {
    name: "medications",
    uri: "healthlog://medications",
    title: "Medications",
    description:
      "The user's tracked medications with their schedules (dose, cadence, time windows). Read-only list; use get_medication_compliance for adherence figures.",
    mimeType: "application/json",
    async read(ctx) {
      const medications = await prisma.medication.findMany({
        where: { userId: ctx.userId },
        include: { schedules: true },
        orderBy: { createdAt: "desc" },
      });
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "medications", present: medications.length > 0 },
      });
      if (medications.length === 0) return { present: false, count: 0 };
      return {
        present: true,
        count: medications.length,
        medications: medications.map((med) => ({
          name: med.name,
          dose: med.dose,
          treatmentClass: med.treatmentClass,
          asNeeded: med.asNeeded,
          // v1.39.1 (#1033) — false: kept as a record, nothing is due and
          // no adherence applies; the schedules below are information.
          intakeTracked: med.trackIntake,
          paused: med.pausedAt !== null,
          startsOn: med.startsOn ? med.startsOn.toISOString() : null,
          endsOn: med.endsOn ? med.endsOn.toISOString() : null,
          schedules: med.schedules.map((s) => ({
            label: s.label ?? null,
            dose: s.dose ?? null,
            windowStart: s.windowStart,
            windowEnd: s.windowEnd,
            timesOfDay: s.timesOfDay,
            daysOfWeek: s.daysOfWeek ?? null,
            rrule: s.rrule ?? null,
            rollingIntervalDays: s.rollingIntervalDays ?? null,
            scheduleType: s.scheduleType,
          })),
        })),
      };
    },
  },
  {
    name: "labs-catalogue",
    uri: "healthlog://labs/catalogue",
    title: "Lab biomarker catalogue",
    description:
      "The curated catalogue of common lab biomarkers with their canonical units and suggested reference bounds, grouped by panel. These are EDITABLE DEFAULTS, not gospel — reference windows vary by lab, sex, and age. Use healthlog://lab/{analyte} or get_labs for the user's own readings.",
    mimeType: "application/json",
    async read() {
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "labs-catalogue", present: true },
      });
      return {
        present: true,
        note: "Suggested reference bounds are editable defaults, not clinical limits.",
        panels: BIOMARKER_PANELS,
        biomarkers: BIOMARKER_CATALOG.map((b) => ({
          slug: b.slug,
          panel: b.panel,
          unit: b.unit,
          suggestedRange: { low: b.lowerBound, high: b.upperBound },
        })),
      };
    },
  },
  {
    name: "measurements-inventory",
    uri: "healthlog://measurements/inventory",
    title: "Data inventory",
    description:
      "What health data the user has and which tool retrieves each domain — one row per domain with presence + approximate sample count. The same manifest list_metrics returns; read this first to discover what is available before fetching figures.",
    mimeType: "application/json",
    async read(ctx) {
      const [inventory, statusDiscoveryRows] = await Promise.all([
        buildCoachDataInventory(ctx.userId, undefined),
        // v1.30 coverage review (G5/C4) — mirrors the same supplement rows
        // `list_metrics` appends, so the two discovery surfaces stay in sync.
        metricStatusDiscoveryRows(ctx.userId),
      ]);
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "measurements-inventory", present: true },
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
    name: "doctor-visit-report",
    uri: "healthlog://report/doctor-visit",
    title: "Doctor-visit summary",
    description:
      "A grounded, clinician-oriented summary of the user's own records over the last 90 days — vitals (with units + reference bands), medications & adherence, and labs (with reference ranges). Reuses the doctor-report data path so the numbers match the exported PDF. Use healthlog://report/doctor-visit/{window} for a different window. Data + context only: no diagnosis, no verdict.",
    mimeType: "application/json",
    async read(ctx) {
      return readDoctorVisit(ctx, "last90days");
    },
  },
];

// ── Doctor-visit summariser ──────────────────────────────────────────
// The reducer is shared with the `doctor_visit_summary` prompt
// (`doctor-visit-summary.ts`) so both surfaces ground identically.

async function readDoctorVisit(
  ctx: McpAuthContext,
  window: string,
): Promise<unknown> {
  // v1.30.22 — gate the whole-record aggregate on its own module key. Both
  // the fixed resource and the `{window}` template funnel through here, so
  // this is the one door for the MCP side.
  //
  // REFUSE rather than return `{ present: false }`: unlike the per-domain
  // reads, this resource IS the whole record, so there is no honest partial
  // payload — mirroring the 403 `/api/export/health-record` answers for the
  // same state. Thrown, which the MCP transport surfaces as a JSON-RPC error
  // on the read, so the assistant learns the resource is unavailable instead
  // of receiving an empty summary it might narrate as "nothing on file".
  if (!(await isModuleEnabled(ctx.userId, "doctorReport"))) {
    annotate({
      action: { name: "mcp.resource.read" },
      meta: { resource: "doctor-visit-report", refused: "module_disabled" },
    });
    throw new Error(
      'The "doctorReport" module is turned off for this account, so the ' +
        "doctor-visit summary is not available.",
    );
  }

  const days = WINDOW_DAYS[window] ?? 90;
  const end = new Date();
  const start = new Date(end.getTime() - days * MS_PER_DAY);
  // The assistant cannot ask a human, so this replays the owner's SAVED
  // selection — the same object reviewed in Settings. An account that never
  // saved one resolves to the empty selection and this surface says so,
  // rather than inventing a scope. It used to assemble the full record at
  // server defaults, on the one wire that egresses to a third party.
  const selection = await resolveSavedSelection(ctx.userId);
  const data = await collectDoctorReportData(
    ctx.userId,
    { start, end, days },
    selection,
  );
  annotate({
    action: { name: "mcp.resource.read" },
    meta: { resource: "doctor-visit-report", days },
  });
  return summariseForVisit(data);
}

// ── User-scoped completion + listing sources ─────────────────────────

/** Complete the trailing-window enum by prefix. Not user-specific. */
function completeWindow(_ctx: McpAuthContext, value: string): string[] {
  const v = value.toLowerCase();
  return MCP_WINDOW_VALUES.filter((w) => w.toLowerCase().startsWith(v));
}

/** The user's own present metric types (the `metric` arg get_metric_series takes). */
async function userMetricTypes(ctx: McpAuthContext): Promise<string[]> {
  const inventory = await buildCoachDataInventory(ctx.userId, undefined);
  const seen = new Set<string>();
  for (const entry of inventory.entries) {
    if (entry.present && entry.metric) seen.add(entry.metric);
  }
  return [...seen];
}

async function completeMetric(
  ctx: McpAuthContext,
  value: string,
): Promise<string[]> {
  const v = value.toLowerCase();
  return (await userMetricTypes(ctx)).filter((m) =>
    m.toLowerCase().includes(v),
  );
}

/** The user's own lab analytes (distinct, non-deleted). */
async function userAnalytes(ctx: McpAuthContext): Promise<string[]> {
  const rows = await prisma.labResult.findMany({
    where: { userId: ctx.userId, deletedAt: null },
    select: { analyte: true },
    distinct: ["analyte"],
    take: 200,
  });
  return rows.map((r) => r.analyte);
}

async function completeAnalyte(
  ctx: McpAuthContext,
  value: string,
): Promise<string[]> {
  const v = value.toLowerCase();
  return (await userAnalytes(ctx)).filter((a) => a.toLowerCase().includes(v));
}

/**
 * The user's own logged nutrient codes (v1.30 coverage review G1). Gated on
 * the opt-in `nutrients` module exactly like `get_nutrients` — an account
 * with the module off sees an empty template, never a leaked code list.
 */
async function userNutrientCodes(ctx: McpAuthContext): Promise<NutrientCode[]> {
  const enabled = await isModuleEnabled(ctx.userId, "nutrients");
  if (!enabled) return [];
  const rows = await prisma.nutrientIntakeDay.groupBy({
    by: ["nutrient"],
    where: { userId: ctx.userId },
  });
  const logged = new Set(rows.map((r) => r.nutrient));
  return NUTRIENT_CODES.filter((code) => logged.has(code));
}

async function completeNutrient(
  ctx: McpAuthContext,
  value: string,
): Promise<string[]> {
  const v = value.toLowerCase();
  return (await userNutrientCodes(ctx)).filter((code) =>
    code.toLowerCase().includes(v),
  );
}

export const MCP_RESOURCE_TEMPLATES: McpResourceTemplateDefinition[] = [
  {
    name: "metric",
    uriTemplate: "healthlog://metric/{type}",
    title: "Metric time series",
    description:
      "One metric's time series for the user (e.g. healthlog://metric/weight) over the default window. Same server-authoritative read get_metric_series serves: aggregate + recent timelines, units, and population reference bands. Returns { present: false } when the user has no data for that metric.",
    mimeType: "application/json",
    complete: { type: completeMetric },
    async list(ctx) {
      return (await userMetricTypes(ctx)).map((type) => ({
        uri: `healthlog://metric/${type}`,
        name: type,
        title: `Metric: ${type}`,
      }));
    },
    async read(ctx, variables) {
      const metric = firstVar(variables.type);
      const result = await executeCoachTool({
        userId: ctx.userId,
        name: "get_metric_series",
        rawArguments: JSON.stringify({ metric }),
      });
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "metric", present: result.present },
      });
      return result;
    },
  },
  {
    name: "metric-windowed",
    uriTemplate: "healthlog://metric/{type}/{window}",
    title: "Metric time series over a window",
    description:
      "One metric's time series for the user over a chosen trailing window (e.g. healthlog://metric/weight/last30days). Window is one of last7days, last30days, last90days, lastYear, allTime. Returns { present: false } when no data exists.",
    mimeType: "application/json",
    complete: { type: completeMetric, window: completeWindow },
    async read(ctx, variables) {
      const metric = firstVar(variables.type);
      const window = firstVar(variables.window);
      const result = await executeCoachTool({
        userId: ctx.userId,
        name: "get_metric_series",
        rawArguments: JSON.stringify(window ? { metric, window } : { metric }),
      });
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "metric-windowed", present: result.present },
      });
      return result;
    },
  },
  {
    name: "lab",
    uriTemplate: "healthlog://lab/{analyte}",
    title: "Lab analyte readings",
    description:
      "The user's recent readings for one named lab analyte (e.g. healthlog://lab/LDL) over the last 12 months — value, unit, reference range, and in-range/below/above status per reading. Same read get_labs serves. Returns { present: false } when no readings exist for that analyte.",
    mimeType: "application/json",
    complete: { analyte: completeAnalyte },
    async list(ctx) {
      return (await userAnalytes(ctx)).map((analyte) => ({
        uri: `healthlog://lab/${encodeURIComponent(analyte)}`,
        name: analyte,
        title: `Lab: ${analyte}`,
      }));
    },
    async read(ctx, variables) {
      const analyte = decodeURIComponent(firstVar(variables.analyte));
      const result = await executeCoachTool({
        userId: ctx.userId,
        name: "get_labs",
        rawArguments: JSON.stringify({ analyte }),
      });
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "lab", present: result.present },
      });
      return result;
    },
  },
  {
    name: "medication",
    uriTemplate: "healthlog://medication/{id}",
    title: "Medication summary",
    description:
      "One of the user's medications by id, with its schedules. User-scoped: returns { present: false } when the id does not belong to this user. Use get_medication_compliance for adherence figures.",
    mimeType: "application/json",
    async list(ctx) {
      const meds = await prisma.medication.findMany({
        where: { userId: ctx.userId },
        select: { id: true, name: true, dose: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return meds.map((m) => ({
        uri: `healthlog://medication/${m.id}`,
        name: m.dose ? `${m.name} ${m.dose}` : m.name,
        title: m.name,
      }));
    },
    async read(ctx, variables) {
      const id = firstVar(variables.id);
      // user-scoped: a medication that is not this user's resolves to absent,
      // never another tenant's row.
      const med = await prisma.medication.findFirst({
        where: { id, userId: ctx.userId },
        include: { schedules: true },
      });
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "medication", present: med !== null },
      });
      if (!med) return { present: false };
      return {
        present: true,
        name: med.name,
        dose: med.dose,
        treatmentClass: med.treatmentClass,
        asNeeded: med.asNeeded,
        intakeTracked: med.trackIntake,
        paused: med.pausedAt !== null,
        startsOn: med.startsOn ? med.startsOn.toISOString() : null,
        endsOn: med.endsOn ? med.endsOn.toISOString() : null,
        schedules: med.schedules.map((s) => ({
          label: s.label ?? null,
          dose: s.dose ?? null,
          windowStart: s.windowStart,
          windowEnd: s.windowEnd,
          timesOfDay: s.timesOfDay,
          daysOfWeek: s.daysOfWeek ?? null,
          rrule: s.rrule ?? null,
          rollingIntervalDays: s.rollingIntervalDays ?? null,
          scheduleType: s.scheduleType,
        })),
      };
    },
  },
  {
    name: "nutrient",
    uriTemplate: "healthlog://nutrient/{code}",
    title: "Nutrient intake",
    description:
      "One tracked nutrient's per-day summed intake series (e.g. healthlog://nutrient/water) over the default 30-day window, plus its EFSA dietary reference resolved against the user's own profile sex. Same read get_nutrients serves. Gated on the opt-in nutrients module. Returns { present: false } when the module is off or nothing is logged for that code.",
    mimeType: "application/json",
    complete: { code: completeNutrient },
    async list(ctx) {
      const codes = await userNutrientCodes(ctx);
      return codes.map((code) => ({
        uri: `healthlog://nutrient/${code}`,
        name: code,
        title: `Nutrient: ${NUTRIENT_LABELS[code]}`,
      }));
    },
    async read(ctx, variables) {
      const code = firstVar(variables.code);
      const result = await getNutrients(ctx.userId, { nutrient: code });
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "nutrient", present: result.present },
      });
      return result;
    },
  },
  {
    name: "doctor-visit-windowed",
    uriTemplate: "healthlog://report/doctor-visit/{window}",
    title: "Doctor-visit summary over a window",
    description:
      "The grounded doctor-visit summary over a chosen trailing window (e.g. healthlog://report/doctor-visit/last30days). Window is one of last7days, last30days, last90days, lastYear, allTime. Reuses the doctor-report data path; data + context only, no diagnosis.",
    mimeType: "application/json",
    complete: { window: completeWindow },
    async read(ctx, variables) {
      const window = firstVar(variables.window) || "last90days";
      return readDoctorVisit(ctx, window);
    },
  },
];

/** Stable list of the registered fixed resource URIs. */
export const MCP_RESOURCE_URIS: readonly string[] = MCP_RESOURCES.map(
  (r) => r.uri,
);

/** Stable list of the registered resource-template URI patterns. */
export const MCP_RESOURCE_TEMPLATE_URIS: readonly string[] =
  MCP_RESOURCE_TEMPLATES.map((t) => t.uriTemplate);
