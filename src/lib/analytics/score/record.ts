/**
 * Writing the health score down.
 *
 * The score is computed live, every time, from the rows standing behind it at
 * that moment. That is the right thing for today and it is why nothing older
 * than today survives: correct a reading from last month, finish a sync that
 * had stalled, or simply add the fourteenth night of sleep that made a pillar
 * eligible, and the score the person saw back then can no longer be
 * reproduced. There is nothing dishonest about that, but it does mean the
 * "history" a surface can offer today is two numbers computed seconds apart.
 *
 * So each local day's score is written down once, the first time it is
 * computed, and then left alone. Three properties follow, and all three are
 * deliberate:
 *
 *   * **Append-only.** A second computation of the same local day finds the
 *     row and does nothing. Not an upsert with a cleverer conflict target,
 *     not a "refresh if newer" — the number the person saw stays the number
 *     they saw. Restating it would make the stored series agree with whatever
 *     the data happens to look like now, which is precisely the property that
 *     makes it worth nothing.
 *   * **Never authoritative.** No surface reads this instead of computing.
 *     The record answers questions about past days; today's number always
 *     comes from today's rows.
 *   * **Never fatal.** The write hangs off a read path. A score that renders
 *     must not fail because a bookkeeping insert did, so the failure is
 *     annotated onto the wide event and swallowed. The integration round trip
 *     is what proves the write actually happens; a unit test that only
 *     watches this function return would be watching it succeed at nothing.
 *
 * Server-only — reaches for the Prisma client.
 */
import { createHash } from "node:crypto";

import { prisma as globalPrisma } from "@/lib/db";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { annotate, getEvent } from "@/lib/logging/context";
import { userDayKey } from "@/lib/tz/format";

import {
  resolveHealthScoreConfig,
  scoreConfigBoundary,
  type ScoreConfigBoundary,
} from "./config";
import { computeUserHealthScore, type UserHealthScoreInput } from "./reader";
import { keepHealthScoreReport } from "./report-cell";
import type {
  HealthScoreReport,
  ScoreBand,
  ScorePillarId,
  ScorePillarResult,
} from "./types";

/**
 * The bands a stored row may carry, and the same closed set the migration's
 * CHECK constraint spells out.
 *
 * Pinned to {@link ScoreBand} in BOTH directions at compile time: `satisfies`
 * rejects a member that is not a band, and `_BandsAreExhaustive` fails to
 * compile if a band is ever added to the union without being added here. A
 * one-directional check would let a fourth band reach a column that refuses
 * it, which is a runtime constraint violation on a write path that is
 * supposed to be unable to fail loudly.
 */
export const SCORE_BANDS = [
  "green",
  "yellow",
  "red",
] as const satisfies readonly ScoreBand[];

type _BandsAreExhaustive =
  Exclude<ScoreBand, (typeof SCORE_BANDS)[number]> extends never ? true : never;
const _bandsAreExhaustive: _BandsAreExhaustive = true;
void _bandsAreExhaustive;

/** Fingerprint format version. Bump when the covered set below changes. */
const FINGERPRINT_VERSION = 1;

/** The row a computed report turns into, before it reaches the database. */
export interface HealthScoreRecordDraft {
  dayKey: string;
  timezone: string;
  composite: number;
  band: ScoreBand;
  scoreVersion: number;
  composition: ScorePillarId[];
  pillarScores: Record<string, number>;
  inputFingerprint: string;
  /** The recipe version in force. 0 when the account never chose. */
  configVersion: number;
  configChangedAt: Date | null;
  computedAt: Date;
}

/** What the caller knows that the report itself does not carry. */
export interface HealthScoreRecordContext {
  /** The account's IANA zone — the clock the local day is cut on. */
  timezone: string;
  /** The instant the score was computed for. */
  now: Date;
  /**
   * The recipe this day was scored under: the account's own
   * configuration version, and when that configuration last changed.
   *
   * Required, and deliberately not optional. This is what a later
   * reader compares one day against the next to find the seam, so a
   * caller allowed to stay silent would write a row that claims a
   * recipe it does not know. A never-configured account passes
   * `{ version: 0, changedAt: null }` — an honest zero, not an absence.
   */
  config: ScoreConfigBoundary;
}

/**
 * Every pillar that actually counted, in the composition's own order, with
 * the score and the scoring-mode identity that produced it.
 *
 * Reads the composition rather than the pillar list, because the pillar list
 * carries pillars that were graded and then not counted (insufficient
 * coverage, module off). Storing those would make the fingerprint move for
 * reasons the composite never saw.
 */
function countedPillars(
  composition: readonly ScorePillarId[],
  pillars: readonly ScorePillarResult[],
): Array<{ id: ScorePillarId; score: number; deltaIdentity: string }> {
  const byId = new Map(pillars.map((pillar) => [pillar.id, pillar]));
  return composition.flatMap((id) => {
    const pillar = byId.get(id);
    if (!pillar || pillar.result.status !== "ok") return [];
    return [
      {
        id,
        score: pillar.result.value.score,
        deltaIdentity: pillar.result.value.deltaIdentity,
      },
    ];
  });
}

/**
 * SHA-256 over exactly what the stored composite and band depend on.
 *
 * The covered set is the whole point, so it is spelled out rather than
 * "hash the report": the algorithm version, and then one ordered triple per
 * counted pillar — its id, its score, and the scoring mode that produced that
 * score. Drop any one of those and two genuinely different standings collapse
 * onto one fingerprint, which is a key missing a dimension its value depends
 * on, a defect class this codebase has shipped before.
 *
 * The composition is not hashed separately. It IS the ordered list of ids in
 * those triples, and an earlier draft carried it twice: a key that no input
 * could ever make disagree with its neighbour, and therefore a key no test
 * could make fail. A hash term nothing can move is not defence in depth, it
 * is decoration on a guard.
 *
 * What is deliberately NOT covered: the account's configuration version. A
 * configuration decides the composition, and the composition is already here.
 * A configuration change that leaves the composition alone leaves the score
 * alone too, and a fingerprint that moved anyway would report a break that
 * did not happen.
 */
export function healthScoreInputFingerprint(input: {
  scoreVersion: number;
  composition: readonly ScorePillarId[];
  pillars: readonly ScorePillarResult[];
}): string {
  const counted = countedPillars(input.composition, input.pillars);
  const canonical = JSON.stringify({
    v: FINGERPRINT_VERSION,
    scoreVersion: input.scoreVersion,
    pillars: counted.map((pillar) => [
      pillar.id,
      pillar.score,
      pillar.deltaIdentity,
    ]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Turn a computed report into the row it would be stored as, or `null` when
 * there is nothing to record.
 *
 * `null` means the composite did not resolve — too few domains, no
 * physiological pillar, a read that failed. That is honest absence and it is
 * NOT a row: a stored zero, or a stored "insufficient" placeholder, would put
 * a value on a day that never had one, and every reader downstream would have
 * to know to disbelieve it.
 *
 * Pure, so the fingerprint and the shape can be tested without a database.
 */
export function buildHealthScoreRecord(
  report: HealthScoreReport,
  context: HealthScoreRecordContext,
): HealthScoreRecordDraft | null {
  if (report.composite.status !== "ok") return null;
  const composite = report.composite.value;
  const counted = countedPillars(composite.composition, report.pillars);
  if (counted.length === 0) return null;

  return {
    dayKey: userDayKey(context.now, context.timezone),
    timezone: context.timezone,
    composite: composite.score,
    band: composite.band,
    scoreVersion: composite.scoreVersion,
    composition: [...composite.composition],
    pillarScores: Object.fromEntries(
      counted.map((pillar) => [pillar.id, pillar.score]),
    ),
    inputFingerprint: healthScoreInputFingerprint({
      scoreVersion: composite.scoreVersion,
      composition: composite.composition,
      pillars: report.pillars,
    }),
    configVersion: context.config.version,
    configChangedAt: context.config.changedAt
      ? new Date(context.config.changedAt)
      : null,
    computedAt: context.now,
  };
}

/** What the write did, so a caller or a test can tell the three apart. */
export type HealthScoreRecordOutcome =
  /** A new day was recorded. */
  | "written"
  /** The day already had a record, which was left exactly as it was. */
  | "already_recorded"
  /** Nothing to record — the composite did not resolve. */
  | "no_score"
  /** The insert failed. Annotated, not thrown. */
  | "failed";

type RecordDelegate = Pick<PrismaClient, "healthScoreRecord">;

/**
 * Record one local day's score, once.
 *
 * `createMany` with `skipDuplicates` compiles to `ON CONFLICT DO NOTHING`
 * against the `(user_id, day_key)` unique index, so two concurrent requests
 * on the same day race into the same outcome the second request would have
 * reached anyway: the first row stands. An `upsert` would have been the
 * obvious call here and would have been wrong — its update branch is exactly
 * the restatement this table must not do.
 */
export async function recordHealthScore(
  db: RecordDelegate,
  userId: string,
  report: HealthScoreReport,
  context: HealthScoreRecordContext,
): Promise<HealthScoreRecordOutcome> {
  const draft = buildHealthScoreRecord(report, context);
  if (!draft) return "no_score";

  try {
    const written = await db.healthScoreRecord.createMany({
      data: [
        {
          userId,
          dayKey: draft.dayKey,
          timezone: draft.timezone,
          composite: draft.composite,
          band: draft.band,
          scoreVersion: draft.scoreVersion,
          composition: draft.composition,
          pillarScores: draft.pillarScores as Prisma.InputJsonValue,
          inputFingerprint: draft.inputFingerprint,
          configVersion: draft.configVersion,
          configChangedAt: draft.configChangedAt,
          computedAt: draft.computedAt,
        },
      ],
      skipDuplicates: true,
    });
    if (written.count === 0) return "already_recorded";
    annotate({
      action: { name: "score.record.write" },
      meta: {
        dayKey: draft.dayKey,
        scoreVersion: draft.scoreVersion,
        pillars: draft.composition.length,
      },
    });
    return "written";
  } catch (err) {
    // A failed bookkeeping write must not take a rendered score down with it,
    // but it must not pass for silence either: the warning rides the wide
    // event so an operator sees the day that went unrecorded.
    getEvent()?.addWarning(
      `health score record write failed for ${draft.dayKey}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "failed";
  }
}

/**
 * Compute the account's health score and record the day it was computed for.
 *
 * One entry point rather than a write bolted onto each of the surfaces that
 * compute a score. Three callers each remembering to record is three places
 * that can independently stop remembering, and the one that forgets leaves a
 * gap in the series that nothing reports.
 */
export async function computeAndRecordUserHealthScore(
  input: UserHealthScoreInput,
): Promise<HealthScoreReport> {
  const report = await computeUserHealthScore(input);
  // Kept for the day, so a surface that cannot compute on its own read
  // serves this number rather than none (`report-cell.ts`).
  keepHealthScoreReport(
    input.userId,
    input.profile.timezone,
    input.now,
    report,
  );
  // The recipe is resolved here rather than asked of the caller. Three
  // routes call this function and every one of them already holds the
  // raw blob, so a parameter would have been three chances to pass
  // nothing and write a row that names no recipe. `resolveHealthScoreConfig`
  // is pure over that same blob, so the version stamped on the row and
  // the composition the reader scored are the same recipe by
  // construction, not by two callers agreeing.
  await recordHealthScore(input.prisma ?? globalPrisma, input.userId, report, {
    timezone: input.profile.timezone,
    now: input.now,
    config: scoreConfigBoundary(
      resolveHealthScoreConfig(input.healthScoreConfigJson),
    ),
  });
  return report;
}
