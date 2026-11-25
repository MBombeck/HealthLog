/**
 * The one reader of the model-written blocks the briefing card renders:
 * `dailyBriefing` and `trendAnnotations`.
 *
 * The server runs it on every generated reply before the reply may be
 * committed, and every reader of a stored payload (the Insights hook, the
 * dashboard snapshot, the today read) runs the same function. A briefing
 * the server keeps is therefore exactly a briefing the card can render. The
 * two used to disagree: the server validated the loose top-level shape only
 * and stored whatever `dailyBriefing` the model wrote, while the client ran
 * `dailyBriefingSchema` and dropped a block that failed it without a word,
 * so a generation could succeed and the card still read "no briefing yet".
 *
 * Safely recoverable slips are repaired rather than costing the whole
 * briefing: a row without `delta` gets `null`, a row that fails its own
 * schema (an unknown `sourceMetric`, an empty headline) is dropped on its
 * own, a list over its cap keeps its first entries, and a missing
 * `keyFindings` list reads as empty. What cannot be repaired (no paragraph,
 * a block or list of the wrong type) is `invalid`.
 *
 * Client-safe: imports only the schema module, so the Insights hook can load
 * it lazily next to the schemas it already loaded.
 */
import {
  dailyBriefingKeyFindingSchema,
  dailyBriefingSchema,
  dailyBriefingSignalSchema,
  trendAnnotationsSchema,
  type DailyBriefing,
  type TrendAnnotations,
} from "./schema";

/** The caps `dailyBriefingSchema` holds the two lists to. */
const MAX_SIGNALS = 3;
const MAX_FINDINGS = 5;

export type DailyBriefingRead =
  | { state: "valid"; briefing: DailyBriefing; repairs: string[] }
  | { state: "absent" }
  | { state: "invalid"; issues: string[] };

/** Fill a row's missing `delta` with the `null` the schema expects. */
function withDelta(row: unknown): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }
  return "delta" in row ? row : { ...row, delta: null };
}

/**
 * Keep the rows that pass their own schema, up to the cap. Null when the
 * list is not an array at all.
 */
function readRows<T>(
  rows: unknown,
  schema: {
    safeParse: (v: unknown) => { success: true; data: T } | { success: false };
  },
  cap: number,
  name: string,
  repairs: string[],
): T[] | null {
  if (!Array.isArray(rows)) return null;
  const kept: T[] = [];
  let dropped = 0;
  let filled = 0;
  for (const row of rows) {
    const filledRow = withDelta(row);
    if (filledRow !== row) filled += 1;
    const parsed = schema.safeParse(filledRow);
    if (parsed.success) kept.push(parsed.data);
    else dropped += 1;
  }
  if (filled > 0) repairs.push(`${name}-delta-filled`);
  if (dropped > 0) repairs.push(`${name}-dropped`);
  if (kept.length > cap) repairs.push(`${name}-capped`);
  return kept.slice(0, cap);
}

/**
 * Read a `dailyBriefing` candidate: `absent` for null / undefined, `valid`
 * with the repaired briefing, or `invalid` with what could not be repaired.
 * Unknown keys on the block are kept, so a field a later version adds
 * survives the round trip.
 */
export function readDailyBriefing(candidate: unknown): DailyBriefingRead {
  if (candidate === null || candidate === undefined) return { state: "absent" };
  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    return { state: "invalid", issues: ["dailyBriefing: not an object"] };
  }
  const block = candidate as Record<string, unknown>;
  const repairs: string[] = [];
  const issues: string[] = [];

  let signalsOfDay: unknown = block.signalsOfDay;
  if (signalsOfDay !== null && signalsOfDay !== undefined) {
    signalsOfDay = readRows(
      signalsOfDay,
      dailyBriefingSignalSchema,
      MAX_SIGNALS,
      "signals",
      repairs,
    );
    if (signalsOfDay === null) {
      issues.push("dailyBriefing.signalsOfDay: not an array");
    }
  }

  let keyFindings: unknown;
  if (block.keyFindings === null || block.keyFindings === undefined) {
    keyFindings = [];
    repairs.push("findings-defaulted");
  } else {
    keyFindings = readRows(
      block.keyFindings,
      dailyBriefingKeyFindingSchema,
      MAX_FINDINGS,
      "findings",
      repairs,
    );
    if (keyFindings === null) {
      issues.push("dailyBriefing.keyFindings: not an array");
    }
  }
  if (issues.length > 0) return { state: "invalid", issues };

  const parsed = dailyBriefingSchema.safeParse({
    ...block,
    signalsOfDay,
    keyFindings,
  });
  if (!parsed.success) {
    return {
      state: "invalid",
      issues: parsed.error.issues.map(
        (issue) =>
          `dailyBriefing.${issue.path.map(String).join(".")}: ${issue.message}`,
      ),
    };
  }
  return {
    state: "valid",
    briefing: { ...block, ...parsed.data } as DailyBriefing,
    repairs,
  };
}

/**
 * Read a `trendAnnotations` candidate. Each annotation stands alone, so one
 * that fails its rule (empty, over 200 characters, not a string) is dropped
 * and the others stay. Null when nothing usable is left.
 */
export function readTrendAnnotations(
  candidate: unknown,
): TrendAnnotations | null {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return null;
  }
  const kept: Record<string, string> = {};
  for (const [key, field] of Object.entries(trendAnnotationsSchema.shape)) {
    const value = (candidate as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = field.safeParse(value);
    if (parsed.success && typeof parsed.data === "string") {
      kept[key] = parsed.data;
    }
  }
  return Object.keys(kept).length > 0 ? (kept as TrendAnnotations) : null;
}

export type GatedInsightBlocks<T> =
  | { ok: true; insights: T; repairs: string[] }
  | { ok: false; issues: string[] };

/**
 * The commit gate every generation path runs on a parsed reply. Returns the
 * reply with its briefing and trend annotations exactly as the card will
 * render them, or the reason it may not be stored.
 *
 * `briefingRequired` is true when the snapshot handed the model signals of
 * the day: the prompt then requires a briefing, and a reply without one is
 * a failed generation, not a quiet day. Without signals the prompt allows
 * the block to be left out, and an absent briefing passes.
 */
export function gateBriefingBlocks<T extends object>(
  insights: T,
  options: { briefingRequired: boolean },
): GatedInsightBlocks<T> {
  const record = insights as Record<string, unknown>;
  const briefing = readDailyBriefing(record.dailyBriefing);
  if (briefing.state === "invalid") {
    return { ok: false, issues: briefing.issues };
  }
  if (briefing.state === "absent" && options.briefingRequired) {
    return {
      ok: false,
      issues: ["dailyBriefing: missing although the snapshot had signals"],
    };
  }
  const repairs = briefing.state === "valid" ? [...briefing.repairs] : [];
  const next: Record<string, unknown> = { ...record };
  if (briefing.state === "valid") next.dailyBriefing = briefing.briefing;
  if (record.trendAnnotations != null) {
    const annotations = readTrendAnnotations(record.trendAnnotations);
    if (annotations === null) {
      delete next.trendAnnotations;
      repairs.push("trend-annotations-dropped");
    } else {
      next.trendAnnotations = annotations;
      const offered = Object.keys(record.trendAnnotations as object).length;
      if (Object.keys(annotations).length !== offered) {
        repairs.push("trend-annotations-trimmed");
      }
    }
  }
  return { ok: true, insights: next as T, repairs };
}

/**
 * Whether a snapshot obliges the model to write a briefing: it carried at
 * least one signal of the day. Both generation paths decide it here.
 */
export function briefingRequiredFor(
  signalsOfDay: readonly unknown[] | null | undefined,
): boolean {
  return (signalsOfDay?.length ?? 0) > 0;
}

/**
 * The briefing of a stored payload when it can stand in for a withheld one:
 * it must render, so a malformed block from before the gate never comes
 * back as the fallback. Null when there is none.
 */
export function previousRenderableBriefing(
  cachedText: string | null | undefined,
): DailyBriefing | null {
  if (!cachedText) return null;
  try {
    const prev = JSON.parse(cachedText) as Record<string, unknown> | null;
    const read = readDailyBriefing(prev?.dailyBriefing);
    return read.state === "valid" ? read.briefing : null;
  } catch {
    // Unparseable previous payload, nothing safe to stand in.
    return null;
  }
}
