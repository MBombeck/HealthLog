/**
 * v1.18.1 P4 — illness / condition context block for the Coach snapshot.
 *
 * Gives the Coach the FACT that the user has (or recently had) a condition so
 * its replies are grounded: it should not push a "measure more often" cadence
 * at someone who is unwell, and it should read a low recovery / off-band vital
 * as illness-explained rather than alarming. This is CONTEXT, not a metric —
 * the block carries no measured number, only labels + lifecycle + dates, and
 * since v1.39.2 the body site when one is stated (never the decrypted
 * free-text note, which must not reach the prompt).
 *
 * Server-authoritative and module-gated: a non-illness / opted-out account
 * gets `null` (no block, no read). Since v1.40 it also names the person's own
 * symptoms of the last two weeks (their names, sanitised, and counts), which
 * reach the model the way custom mood-tag names reach the mood analysis. The active set drives the `restMode` flag
 * the Coach reads; a short resolved-history tail lets it answer "how often do
 * I get sick" without re-deriving anything.
 */
import { prisma } from "@/lib/db";
import { isIllnessEnabled } from "@/lib/illness/gate";
import { computeEpisodeCorrelation } from "@/lib/illness/correlation-read";
import {
  BASELINE_WINDOW_DAYS,
  PRE_ONSET_LOOKBACK_DAYS,
} from "@/lib/illness/correlation";
import {
  UNBOUNDED_REACH,
  laterOfFloor,
  reachFloor,
  withinReach,
  type CoachHistoryReach,
} from "./history-reach";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import { decryptSymptomText } from "@/lib/symptoms/server";

/** How many recently-resolved episodes to include as history context. */
const RESOLVED_HISTORY_LIMIT = 6;

/** Max characters of the user free-text label that may enter the prompt. */
const MAX_LABEL_CHARS = 80;

/**
 * Cap + strip the user-supplied free-text episode label before it enters the
 * Coach LLM prompt. The label is the one user-controlled string in this block,
 * so it is a (self-scoped) prompt-injection surface: collapse control chars +
 * newlines to spaces so an embedded "ignore previous instructions\n..." can't
 * reshape the prompt structure, and bound the length.
 */
export function sanitizeLabel(label: string): string {
  // Replace every C0/C1 control char (incl. newlines) with a space, collapse
  // runs of whitespace, trim, then bound the length.
  let out = "";
  for (const ch of label) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
}

/** Max characters of a decrypted body site that may enter the prompt. */
const MAX_BODY_SITE_CHARS = 120;

/**
 * Where on the body, when the person said (v1.39.2). Decrypted fail-soft and
 * put through the same sanitiser as every other free-text leaf, since it is
 * the person's own words inside the fenced snapshot. Absent rather than null
 * when not stated, so the block does not grow for conditions that carry none.
 */
function siteFields(row: {
  bodySiteEncrypted: Uint8Array | null;
  laterality: string | null;
}): { bodySite?: string; laterality?: string } {
  if (!row.bodySiteEncrypted || row.bodySiteEncrypted.byteLength === 0) {
    return {};
  }
  let plaintext: string;
  try {
    plaintext = decryptFromBytes(row.bodySiteEncrypted);
  } catch {
    return {};
  }
  const bodySite = sanitizeForPrompt(plaintext, MAX_BODY_SITE_CHARS);
  if (!bodySite) return {};
  return {
    bodySite,
    ...(row.laterality ? { laterality: row.laterality } : {}),
  };
}

export interface CoachIllnessBlock {
  /** True when ≥ 1 episode is active right now (the Rest Mode flag). */
  restMode: boolean;
  /** Active (unresolved) episodes — the Coach frames its reply around these. */
  active: Array<{
    label: string;
    type: string;
    lifecycle: string;
    onsetAt: string;
    /** Where on the body, sanitised; present only when stated (v1.39.2). */
    bodySite?: string;
    /** The side of `bodySite`, when one is stated. */
    laterality?: string;
  }>;
  /** Recently-resolved episodes, newest first — light history context. */
  recentResolved: Array<{
    label: string;
    type: string;
    onsetAt: string;
    resolvedAt: string;
    bodySite?: string;
    laterality?: string;
  }>;
  /**
   * v1.40 — the person's own symptoms over the last 14 days, most frequent
   * first (at most ten): the name they gave it, how often, how strong at
   * worst (0-10), and when last. Absent when nothing was logged.
   */
  symptoms?: CoachSymptomSummary[];
}

export interface CoachSymptomSummary {
  label: string;
  count14d: number;
  maxIntensity14d: number;
  lastOccurredAt: string;
}

/** How many of the person's own symptoms the block may name. */
const MAX_SYMPTOMS = 10;
/** Max characters of a symptom name that may enter the prompt. */
const MAX_SYMPTOM_LABEL_CHARS = 40;
const SYMPTOM_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The person's own symptoms over the trailing 14 days, by how often they
 * occurred. A name that will not decrypt is left out rather than sent as an
 * id. Hidden definitions still count: hiding takes a symptom out of the quick
 * entry, not out of what happened.
 */
async function readRecentSymptoms(
  userId: string,
  now: Date,
  reach: CoachHistoryReach,
): Promise<CoachSymptomSummary[]> {
  const since = laterOfFloor(
    new Date(now.getTime() - SYMPTOM_WINDOW_MS),
    reach,
    now,
  );
  const grouped = await prisma.symptomEvent.groupBy({
    by: ["definitionId"],
    where: { userId, occurredAt: { gte: since, lte: now } },
    _count: { _all: true },
    _max: { intensity: true, occurredAt: true },
  });
  if (grouped.length === 0) return [];
  const definitions = await prisma.symptomDefinition.findMany({
    where: { userId, id: { in: grouped.map((g) => g.definitionId) } },
    select: { id: true, labelEncrypted: true },
  });
  const labelById = new Map(
    definitions.map((d) => [
      d.id,
      decryptSymptomText(d.labelEncrypted, "label"),
    ]),
  );
  const out: CoachSymptomSummary[] = [];
  for (const g of grouped) {
    const raw = labelById.get(g.definitionId);
    const label = raw ? sanitizeForPrompt(raw, MAX_SYMPTOM_LABEL_CHARS) : "";
    if (!label || g._max.occurredAt === null || g._max.intensity === null) {
      continue;
    }
    out.push({
      label,
      count14d: g._count._all,
      maxIntensity14d: g._max.intensity,
      lastOccurredAt: g._max.occurredAt.toISOString(),
    });
  }
  return out
    .sort(
      (a, b) =>
        b.count14d - a.count14d ||
        b.lastOccurredAt.localeCompare(a.lastOccurredAt),
    )
    .slice(0, MAX_SYMPTOMS);
}

/**
 * Build the illness context block, or `null` when the module is off / the
 * account has no episode history. Reads label + lifecycle + dates and the body
 * site — the `noteEncrypted` column is never selected.
 */
export async function buildIllnessSnapshotBlock(
  userId: string,
  now: Date = new Date(),
  /**
   * The Coach's lookback limit. An episode that is still ongoing is current
   * state and always shown (it carries Rest Mode); resolved episodes and
   * symptoms are history and are read from inside the limit only.
   */
  reach: CoachHistoryReach = UNBOUNDED_REACH,
): Promise<CoachIllnessBlock | null> {
  if (!(await isIllnessEnabled(userId))) return null;
  const floor = reachFloor(reach, now);

  const [activeRows, resolvedRows, symptoms] = await Promise.all([
    prisma.illnessEpisode.findMany({
      where: {
        userId,
        deletedAt: null,
        resolvedAt: null,
        onsetAt: { lte: now },
      },
      orderBy: { onsetAt: "asc" },
      select: {
        label: true,
        type: true,
        lifecycle: true,
        onsetAt: true,
        bodySiteEncrypted: true,
        laterality: true,
      },
    }),
    prisma.illnessEpisode.findMany({
      where: {
        userId,
        deletedAt: null,
        resolvedAt: { not: null },
        ...(floor ? { onsetAt: { gte: floor } } : {}),
      },
      orderBy: { resolvedAt: "desc" },
      take: RESOLVED_HISTORY_LIMIT,
      select: {
        label: true,
        type: true,
        onsetAt: true,
        resolvedAt: true,
        bodySiteEncrypted: true,
        laterality: true,
      },
    }),
    readRecentSymptoms(userId, now, reach),
  ]);

  if (
    activeRows.length === 0 &&
    resolvedRows.length === 0 &&
    symptoms.length === 0
  ) {
    return null;
  }

  return {
    restMode: activeRows.length > 0,
    active: activeRows.map((e) => ({
      label: sanitizeLabel(e.label),
      type: e.type,
      lifecycle: e.lifecycle,
      onsetAt: e.onsetAt.toISOString(),
      ...siteFields(e),
    })),
    recentResolved: resolvedRows.map((e) => ({
      label: sanitizeLabel(e.label),
      type: e.type,
      onsetAt: e.onsetAt.toISOString(),
      // `resolvedAt` is non-null by the query filter above.
      resolvedAt: (e.resolvedAt as Date).toISOString(),
      ...siteFields(e),
    })),
    ...(symptoms.length > 0 ? { symptoms } : {}),
  };
}

/* ── v1.21.0 (NEW-B B-2) — illness SCORES for the Coach ────────────────────
 *
 * The Coach illness CONTEXT block above carries only labels / lifecycle /
 * dates — it never reaches the computed retrospective the illness card shows
 * (recovery-gap, the metric that dominated it, the nadir, and the red flags).
 * So a user asking "how long did my body take to recover last time" got the
 * recovery COMPOSITE, not the recovery-GAP the card renders, and a sustained-
 * fever / low-SpO2 escalation was invisible in-conversation.
 *
 * This block surfaces those same numbers, READ-ONLY, by running the existing
 * `computeEpisodeCorrelation` read-layer (the one the card + the notification
 * path use) for the single most relevant episode — the active one, else the
 * most-recently-resolved. The engine is coverage-gated: a thin signal returns
 * `insufficient`, which yields `null` here (no fabricated number). It is
 * RETROSPECTIVE and DESCRIPTIVE — never a prediction, never a diagnosis. The
 * Coach reads these to restate what the card already shows.
 */

/** Cap on per-finding rows so the block never balloons the prompt. */
const MAX_FINDING_ROWS = 3;

/** One vital deviation finding, compacted for the prompt. */
export interface CoachVitalFinding {
  type: string;
  day: string;
  deviationSd: number;
  direction: "above" | "below";
}

/** One illness red-flag escalation, compacted for the prompt. */
export interface CoachIllnessRedFlag {
  type: string;
  reason: "sustained_low_spo2" | "sustained_fever";
  worstValue: number;
  days: number;
}

/** The computed retrospective scores for the most relevant episode. */
export interface CoachIllnessScores {
  /** Which episode these scores describe (label + lifecycle, no free-text note). */
  episodeLabel: string;
  episodeType: string;
  /** "active" | "resolved" — the lifecycle context for the gap. */
  state: "active" | "resolved";
  /**
   * The headline recovery-gap in days (the body lagged the felt-better marker),
   * or null when still active / no vital returned. Mirrors the card's headline.
   */
  recoveryGapDays: number | null;
  /** The metric whose physiological return dominated the gap (or null). */
  gapDriverType: string | null;
  /** "What dropped" — each vital's worst (nadir) deviation, capped + adverse-first. */
  nadir: CoachVitalFinding[];
  /** "How it announced itself" — notable pre-onset deviations, capped. */
  preOnset: CoachVitalFinding[];
  /** Sustained-fever / low-SpO2 escalations during the episode (empty when none). */
  redFlags: CoachIllnessRedFlag[];
}

function compactFindings(
  findings: ReadonlyArray<{
    type: string;
    day: string;
    deviationSd: number;
    direction: "above" | "below";
    adverse: boolean;
  }>,
): CoachVitalFinding[] {
  // Adverse-direction findings lead (the illness-relevant moves), then the
  // largest absolute deviation; cap the row count.
  return [...findings]
    .sort((a, b) => {
      if (a.adverse !== b.adverse) return a.adverse ? -1 : 1;
      return Math.abs(b.deviationSd) - Math.abs(a.deviationSd);
    })
    .slice(0, MAX_FINDING_ROWS)
    .map((f) => ({
      type: f.type,
      day: f.day,
      // Round to one decimal — the felt grain, never false precision.
      deviationSd: Math.round(f.deviationSd * 10) / 10,
      direction: f.direction,
    }));
}

/**
 * Build the computed illness-scores block for the Coach, or `null` when the
 * module is off, there is no episode to score, or the engine withholds
 * (insufficient coverage). Reads the active episode first, else the most-
 * recently-resolved. Server-authoritative + coverage-gated; the engine is the
 * SAME one the illness card + the red-flag notifier run.
 */
export async function buildIllnessScores(
  userId: string,
  now: Date = new Date(),
  /**
   * The Coach's lookback limit. The scores compare the episode against a
   * baseline read before its onset, so they are computed only when that
   * baseline lies inside the limit too.
   */
  reach: CoachHistoryReach = UNBOUNDED_REACH,
): Promise<CoachIllnessScores | null> {
  if (!(await isIllnessEnabled(userId))) return null;

  const [user, active, resolved] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    }),
    prisma.illnessEpisode.findFirst({
      where: {
        userId,
        deletedAt: null,
        resolvedAt: null,
        onsetAt: { lte: now },
      },
      orderBy: { onsetAt: "desc" },
      select: {
        id: true,
        label: true,
        type: true,
        onsetAt: true,
        resolvedAt: true,
        lifecycle: true,
      },
    }),
    prisma.illnessEpisode.findFirst({
      where: { userId, deletedAt: null, resolvedAt: { not: null } },
      orderBy: { resolvedAt: "desc" },
      select: {
        id: true,
        label: true,
        type: true,
        onsetAt: true,
        resolvedAt: true,
        lifecycle: true,
      },
    }),
  ]);

  // Active episode wins (it is the one a "how am I recovering" question is
  // about); fall back to the most-recently-resolved for "last time" questions.
  const episode = active ?? resolved;
  if (!episode) return null;
  const baselineStart = new Date(
    episode.onsetAt.getTime() -
      (PRE_ONSET_LOOKBACK_DAYS + BASELINE_WINDOW_DAYS) * 86_400_000,
  );
  if (!withinReach(baselineStart, reach, now)) return null;

  const tz = user?.timezone ?? DEFAULT_TIMEZONE;
  const derived = await computeEpisodeCorrelation(
    userId,
    {
      id: episode.id,
      onsetAt: episode.onsetAt,
      resolvedAt: episode.resolvedAt,
      lifecycle: episode.lifecycle,
    },
    tz,
    now,
  );
  if (derived.status !== "ok") return null;

  const v = derived.value;
  return {
    episodeLabel: sanitizeLabel(episode.label),
    episodeType: episode.type,
    state: episode.resolvedAt === null ? "active" : "resolved",
    recoveryGapDays: v.recoveryGapDays,
    gapDriverType: v.gapDriverType,
    nadir: compactFindings(v.nadir),
    preOnset: compactFindings(v.preOnset),
    redFlags: v.redFlags.map((f) => ({
      type: f.type,
      reason: f.reason,
      worstValue: f.worstValue,
      days: f.days,
    })),
  };
}
