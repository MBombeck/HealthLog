/**
 * PHQ-9 and GAD-7 administrations from Apple Health, as they arrive on the
 * measurement batch (`HKScoredAssessmentTypeIdentifierPHQ9` / `GAD7`).
 *
 * A screener is not a measurement. Every administration lives in exactly one
 * place, `MentalHealthAssessment`, whichever door it came through, and its
 * total reaches the charts, the rollups and the doctor report through the one
 * `COMPUTED` projection row both writers share
 * (`writeAssessmentScoreProjection`). So an Apple Health PHQ-9 is written as an
 * administration with `source = APPLE_HEALTH` and the HealthKit sample UUID as
 * its `externalId`, never as an `APPLE_HEALTH` `PHQ9_SCORE` measurement beside
 * the projection, which would count it twice on the trend and leave it out of
 * the screener history.
 *
 * The score is the entry's `value`; the per-item answers are optional. With
 * them the server scores the administration itself and the entry is refused
 * when the client's total disagrees; item 9 of the PHQ-9 sets the same flag
 * the in-app questionnaire sets. Without them the administration is score
 * only: the stored answer blob says `items: null`, the detail read reports the
 * items unavailable, and nothing can be known about item 9.
 *
 * Per-entry refusals, never a failed batch:
 *   - `unsupported_source`: a bridge token, or an entry tagged `MANUAL`. Only
 *     the phone's own Apple Health import writes a screener here;
 *   - `module_disabled`: the account turned the mental-health module off, so
 *     nothing of it is stored;
 *   - `implausible_timestamp`, `value_out_of_range`,
 *     `invalid_assessment_answers`.
 *
 * A re-sent sample, or one whose administration was deleted, answers
 * `duplicate`: the externalId lookup ignores `deletedAt`, so a late replay
 * cannot bring a deleted administration back.
 */
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { isModuleEnabled } from "@/lib/modules/gate";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { isPlausibleEntryInstant } from "@/lib/validations/entry-instant";

import {
  INSTRUMENTS,
  isSafetyFlagged,
  scoreTotal,
  severityBand,
} from "./instruments";
import { writeAssessmentScoreProjection } from "./score-projection";

/** The HealthKit scored-assessment identifiers the batch takes. */
export const HK_SCORED_ASSESSMENT_INSTRUMENT = {
  HKScoredAssessmentTypeIdentifierPHQ9: "PHQ9",
  HKScoredAssessmentTypeIdentifierGAD7: "GAD7",
} as const;

export type AppleHealthScreener =
  (typeof HK_SCORED_ASSESSMENT_INSTRUMENT)[keyof typeof HK_SCORED_ASSESSMENT_INSTRUMENT];

const APPLE_HEALTH = "APPLE_HEALTH";

export function scoredAssessmentInstrument(
  hkIdentifier: string,
): AppleHealthScreener | null {
  return Object.prototype.hasOwnProperty.call(
    HK_SCORED_ASSESSMENT_INSTRUMENT,
    hkIdentifier,
  )
    ? HK_SCORED_ASSESSMENT_INSTRUMENT[
        hkIdentifier as keyof typeof HK_SCORED_ASSESSMENT_INSTRUMENT
      ]
    : null;
}

/** One scored-assessment entry of the batch, set aside by the first pass. */
export interface AppleHealthAssessmentEntry {
  index: number;
  instrument: AppleHealthScreener;
  value: number;
  startDate: string;
  externalId: string;
  answers?: number[];
  source?: "APPLE_HEALTH" | "MANUAL";
}

export interface AssessmentEntryResult {
  index: number;
  status: "inserted" | "duplicate" | "skipped" | "failed";
  reason?: string;
  range?: { min: number; max: number; unit: string };
}

type Verdict =
  | { ok: true; total: number; answers: number[] | null; takenAt: Date }
  | { ok: false; result: AssessmentEntryResult };

/** Validate one entry against its instrument. Pure. */
export function checkAppleHealthAssessment(
  entry: AppleHealthAssessmentEntry,
): Verdict {
  const { index, instrument } = entry;
  const def = INSTRUMENTS[instrument];
  const skip = (reason: string): Verdict => ({
    ok: false,
    result: { index, status: "skipped", reason },
  });

  const takenAt = new Date(entry.startDate);
  if (!isPlausibleEntryInstant(takenAt)) return skip("implausible_timestamp");

  if (
    !Number.isInteger(entry.value) ||
    entry.value < 0 ||
    entry.value > def.maxScore
  ) {
    return {
      ok: false,
      result: {
        index,
        status: "skipped",
        reason: "value_out_of_range",
        range: { min: 0, max: def.maxScore, unit: "score" },
      },
    };
  }

  if (entry.answers === undefined) {
    return { ok: true, total: entry.value, answers: null, takenAt };
  }
  const answers = entry.answers;
  const shaped =
    answers.length === def.itemCount &&
    answers.every((a) => Number.isInteger(a) && a >= 0 && a <= def.itemMax);
  // The server scores the answers; a total that disagrees with them means
  // one of the two is wrong, and storing either would be a guess.
  if (!shaped || scoreTotal(instrument, answers) !== entry.value) {
    return skip("invalid_assessment_answers");
  }
  return { ok: true, total: entry.value, answers, takenAt };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Write the batch's scored assessments and answer each entry. `scoped` is a
 * bridge token, which may not write a screener.
 */
export async function writeAppleHealthAssessments(args: {
  userId: string;
  scoped: boolean;
  entries: readonly AppleHealthAssessmentEntry[];
}): Promise<AssessmentEntryResult[]> {
  const { userId, scoped, entries } = args;
  if (entries.length === 0) return [];

  const results: AssessmentEntryResult[] = [];
  const admitted: Array<{
    entry: AppleHealthAssessmentEntry;
    verdict: Extract<Verdict, { ok: true }>;
  }> = [];
  for (const entry of entries) {
    if (scoped || (entry.source ?? APPLE_HEALTH) !== APPLE_HEALTH) {
      results.push({
        index: entry.index,
        status: "skipped",
        reason: "unsupported_source",
      });
      continue;
    }
    const verdict = checkAppleHealthAssessment(entry);
    if (verdict.ok) admitted.push({ entry, verdict });
    else results.push(verdict.result);
  }
  if (admitted.length === 0) return results;

  if (!(await isModuleEnabled(userId, "mentalHealth"))) {
    for (const { entry } of admitted) {
      results.push({
        index: entry.index,
        status: "skipped",
        reason: "module_disabled",
      });
    }
    return results;
  }

  // The partial unique index on `(user_id, external_id)` spans every source
  // and every deleted row, so the lookup does too.
  const known = new Set(
    (
      await prisma.mentalHealthAssessment.findMany({
        where: {
          userId,
          externalId: { in: admitted.map(({ entry }) => entry.externalId) },
        },
        select: { externalId: true },
      })
    ).map((row) => row.externalId),
  );
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { locale: true },
  });
  const locale = user?.locale ?? "en";

  let inserted = 0;
  for (const { entry, verdict } of admitted) {
    if (known.has(entry.externalId)) {
      results.push({ index: entry.index, status: "duplicate" });
      continue;
    }
    known.add(entry.externalId);
    const outcome = await writeOne(userId, locale, entry, verdict);
    results.push({ index: entry.index, status: outcome });
    if (outcome === "inserted") inserted += 1;
  }

  // A screening can be planned as a reminder keyed on PHQ9_SCORE / GAD7_SCORE;
  // the eventful worker resolves it now rather than at the next sweep.
  if (inserted > 0) await enqueueReminderSatisfy(userId);
  annotate({
    meta: {
      apple_health_assessments: entries.length,
      apple_health_assessments_inserted: inserted,
    },
  });
  return results;
}

async function writeOne(
  userId: string,
  locale: string,
  entry: AppleHealthAssessmentEntry,
  verdict: Extract<Verdict, { ok: true }>,
): Promise<"inserted" | "duplicate"> {
  const { instrument } = entry;
  const band = severityBand(instrument, verdict.total);
  const flagged =
    verdict.answers !== null && isSafetyFlagged(instrument, verdict.answers);

  let assessmentId: string;
  try {
    const row = await prisma.mentalHealthAssessment.create({
      data: {
        userId,
        instrument,
        locale,
        // Apple's own text was shown, not one of HealthLog's wordings.
        wording: null,
        version: "standard",
        responsesEncrypted: encryptToBytes(
          JSON.stringify({ items: verdict.answers, schema: 1 }),
        ),
        totalScore: verdict.total,
        severityBand: band,
        item9Flagged: flagged,
        // Nothing was shown to anyone: the sample arrived in a sync.
        crisisShownAt: null,
        takenAt: verdict.takenAt,
        tz: null,
        source: APPLE_HEALTH,
        externalId: entry.externalId,
      },
      select: { id: true },
    });
    assessmentId = row.id;
  } catch (err) {
    // A concurrent batch carrying the same sample won the insert.
    if (isUniqueViolation(err)) return "duplicate";
    throw err;
  }

  await writeAssessmentScoreProjection({
    userId,
    instrument,
    assessmentId,
    total: verdict.total,
    takenAt: verdict.takenAt,
  });
  await auditLog("mental-health.create", {
    userId,
    // The band is non-sensitive; item answers are never logged.
    details: { instrument, severityBand: band, source: APPLE_HEALTH },
  });
  return "inserted";
}
