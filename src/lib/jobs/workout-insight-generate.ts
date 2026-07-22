/**
 * The per-workout Activity Insight worker.
 *
 * Dispatched by the data-arrival spine when a workout genuinely LANDS. There is
 * no other trigger and there is deliberately no regenerate button: a per-workout
 * provider button is a saturation surface, and a read path that could generate
 * would turn opening the workout list on a fresh install into a bill.
 *
 * The consequence is worth stating because it looks like a bug and is not: every
 * workout that predates this feature, and every workout re-synced from a
 * provider backfill, renders NO card, forever. That is the design. The spine's
 * recency classifier drops historical samples before anything is enqueued, the
 * upsert seams only emit for rows they actually created, and nothing on the read
 * side ever writes here.
 *
 * Five gates stand in front of the provider, in ascending cost order, and each
 * is a claim on its own rather than a layer of one claim:
 *
 *   1. modules   — `workouts` AND `insights` on
 *   2. duration  — at least ten minutes of session
 *   3. daily cap — at most four paragraphs generated today
 *   4. inputHash — the evidence is unchanged since the last paragraph
 *   5. budget    — the token ledger, inside `runStatusCompletion`
 *
 * Gate 3 and gate 4 both independently stop a device double-post, which is why
 * they are both here: the singleton queue key that would normally collapse a
 * burst is best-effort, and a lost singleton race is an ordinary event.
 *
 * Every business refusal RETURNS a status. It does not throw. pg-boss retries a
 * failed job, and retrying against a daily cap that does not move until midnight
 * is an unbounded loop. Only a genuine transient fault escapes to earn its
 * backed-off retries.
 */
import { randomUUID } from "node:crypto";

import type { Job } from "pg-boss";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import {
  getWorkoutInsightSystemPrompt,
  getWorkoutInsightUserPrompt,
  WORKOUT_INSIGHT_PROMPT_VERSION,
} from "@/lib/ai/prompts/workout-insight";
import { prisma } from "@/lib/db";
import { pickCanonicalWorkoutRows } from "@/lib/measurements/pick-canonical-workout-rows";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { finalizeStatusSummary } from "@/lib/insights/status-shared";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { resolveModuleMap } from "@/lib/modules/gate";
import { userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { startOfLocalDayInTz } from "@/lib/tz/local-day";
import { buildWorkoutHrSeries } from "@/lib/workouts/hr-series";
import {
  buildWorkoutInsightEvidence,
  OWN_HISTORY_LOOKBACK_DAYS,
  OWN_HISTORY_MAX_ROWS,
} from "@/lib/workouts/insight-evidence";
import {
  MAX_INSIGHTS_PER_DAY,
  meetsDurationFloor,
  workoutInsightInputHash,
} from "@/lib/workouts/insight-gates";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import {
  computeZones,
  hrMaxFromAge,
  parseWhoopZoneDurations,
} from "@/lib/workouts/zones";

import {
  WORKOUT_INSIGHT_GENERATE_CONCURRENCY,
  WORKOUT_INSIGHT_GENERATE_QUEUE,
  type WorkoutInsightGeneratePayload,
} from "./workout-insight-generate-shared";

export { WORKOUT_INSIGHT_GENERATE_CONCURRENCY, WORKOUT_INSIGHT_GENERATE_QUEUE };
export type { WorkoutInsightGeneratePayload };

const MS_PER_DAY = 86_400_000;
const WORKOUT_INSIGHT_CLAIM_LEASE_MS = 10 * 60_000;

type WorkoutInsightClaimResult =
  | { status: "claimed"; claimId: string; claimRowId: string }
  | {
      status: "skipped";
      reason: "already_claimed" | "already_attempted" | "daily_cap";
    };

type ClaimWorkoutInsightGenerationArgs = {
  userId: string;
  workoutId: string;
  localDate: string;
  dayStart: Date;
  now: Date;
};

/**
 * Serialize the local-day capacity check with the durable claim insert.
 * PostgreSQL advisory transaction locks keep the count and write atomic across
 * every worker process; the unique workout key independently protects a
 * same-workout race that crosses a local-day boundary.
 */
export async function claimWorkoutInsightGeneration({
  userId,
  workoutId,
  localDate,
  dayStart,
  now,
}: ClaimWorkoutInsightGenerationArgs): Promise<WorkoutInsightClaimResult> {
  const claimId = randomUUID();
  const staleBefore = new Date(now.getTime() - WORKOUT_INSIGHT_CLAIM_LEASE_MS);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtext('workout-insight-workout'),
        hashtext(${workoutId})
      )::text AS locked
    `;
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${userId}),
        hashtext(${localDate})
      )::text AS locked
    `;

    const existing = await tx.workoutInsightGenerationClaim.findUnique({
      where: { workoutId },
      select: {
        id: true,
        claimId: true,
        claimedAt: true,
        providerInvokedAt: true,
        completedAt: true,
      },
    });
    if (existing?.providerInvokedAt != null || existing?.completedAt != null) {
      return { status: "skipped", reason: "already_attempted" };
    }
    if (
      existing?.claimId != null &&
      existing.claimedAt != null &&
      existing.claimedAt >= staleBefore
    ) {
      return { status: "skipped", reason: "already_claimed" };
    }

    const [generatedToday, claimedToday] = await Promise.all([
      tx.workoutInsight.count({
        where: { userId, generatedAt: { gte: dayStart } },
      }),
      tx.workoutInsightGenerationClaim.count({
        where: {
          userId,
          localDate,
          completedAt: null,
          ...(existing ? { workoutId: { not: workoutId } } : {}),
        },
      }),
    ]);
    if (generatedToday + claimedToday >= MAX_INSIGHTS_PER_DAY) {
      return { status: "skipped", reason: "daily_cap" };
    }

    if (existing) {
      const reclaimed = await tx.workoutInsightGenerationClaim.updateMany({
        where: {
          id: existing.id,
          userId,
          workoutId,
          providerInvokedAt: null,
          completedAt: null,
        },
        data: { localDate, claimId, claimedAt: now },
      });
      if (reclaimed.count !== 1) {
        return { status: "skipped", reason: "already_claimed" };
      }
      return { status: "claimed", claimId, claimRowId: existing.id };
    }

    const created = await tx.workoutInsightGenerationClaim.create({
      data: { userId, workoutId, localDate, claimId, claimedAt: now },
      select: { id: true },
    });
    return { status: "claimed", claimId, claimRowId: created.id };
  });
}

/**
 * What one run did. `skipped` is a SUCCESS — the distinction is observability.
 */
export type WorkoutInsightOutcome =
  | { status: "skipped"; reason: string }
  | { status: "generated"; providerType: string; length: number };

/**
 * Generate one workout's paragraph. Owner-scoped throughout: `userId` comes
 * from the queue payload the spine wrote from an authenticated ingest, and it
 * is in the `where` of every read and every write below. There is no path here
 * that resolves a workout by id alone.
 */
export async function runWorkoutInsightGenerate(
  payload: WorkoutInsightGeneratePayload,
  now: Date = new Date(),
): Promise<WorkoutInsightOutcome> {
  const { userId, workoutId } = payload;
  if (!userId || !workoutId)
    return { status: "skipped", reason: "bad_payload" };

  // ── Gate 1: modules ──────────────────────────────────────────────────────
  // Both, not either. `workouts` is the domain the surface lives in and
  // `insights` is the AI surface family it belongs to; a user who turned either
  // off has said no to this card.
  const modules = await resolveModuleMap(userId);
  if (modules.workouts === false || modules.insights === false) {
    return { status: "skipped", reason: "module_off" };
  }

  const row = await prisma.workout.findFirst({
    where: { id: workoutId, userId },
    select: {
      id: true,
      sportType: true,
      startedAt: true,
      endedAt: true,
      durationSec: true,
      totalDistanceM: true,
      totalEnergyKcal: true,
      avgHeartRate: true,
      maxHeartRate: true,
      minHeartRate: true,
      elevationM: true,
      metadata: true,
      route: { select: { geometry: true } },
      samples: { select: { samples: true } },
    },
  });
  // Gone between the emit and the run (a hard delete), or never ours.
  if (!row) return { status: "skipped", reason: "not_found" };

  // ── Gate 2: duration floor ───────────────────────────────────────────────
  // A four-minute walk has no zone distribution, no front/back-half story and
  // nothing to compare. Silence is the honest output.
  if (!meetsDurationFloor(row.durationSec)) {
    annotate({
      action: { name: "workouts.insight.skipped" },
      meta: { workoutId, reason: "too_short", durationSec: row.durationSec },
    });
    return { status: "skipped", reason: "too_short" };
  }

  const tz = await resolveUserTimezone(userId);

  // ── Gate 3: atomic ownership and hard daily cap ──────────────────────────
  // The capacity check and durable claim write are one serialized PostgreSQL
  // transaction. A count performed before the write would let concurrent
  // workouts all observe the same free slot and exceed the cap.
  const dayStart = startOfLocalDayInTz(now, tz);
  const localDate = userDayKey(now, tz);
  const claim = await claimWorkoutInsightGeneration({
    userId,
    workoutId,
    localDate,
    dayStart,
    now,
  });
  if (claim.status === "skipped") {
    annotate({
      action: { name: "workouts.insight.skipped" },
      meta: { workoutId, reason: claim.reason },
    });
    return { status: "skipped", reason: claim.reason };
  }

  const releaseClaim = async () => {
    await prisma.workoutInsightGenerationClaim.deleteMany({
      where: {
        id: claim.claimRowId,
        userId,
        workoutId,
        claimId: claim.claimId,
        providerInvokedAt: null,
        completedAt: null,
      },
    });
  };
  const finishTerminalAttempt = async () => {
    await prisma.workoutInsightGenerationClaim.updateMany({
      where: {
        id: claim.claimRowId,
        userId,
        workoutId,
        claimId: claim.claimId,
        providerInvokedAt: { not: null },
      },
      data: { claimId: null, claimedAt: null },
    });
  };

  const prepared = await (async () => {
    // ── Evidence: deterministic, numbers-only, no free text ────────────────
    const profile = await prisma.user.findUnique({
      where: { id: userId },
      select: { dateOfBirth: true, locale: true, sourcePriorityJson: true },
    });

    const hrSeries = await buildWorkoutHrSeries({
      userId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSec: row.durationSec,
      storedSamples: row.samples?.samples ?? null,
      now,
    });

    const zones = computeZones({
      hrMax: hrMaxFromAge(getAgeFromDateOfBirth(profile?.dateOfBirth ?? null)),
      series: hrSeries?.points ?? [],
      bucketSec: hrSeries?.bucketSec ?? 0,
      whoopZoneDurations: parseWhoopZoneDurations(row.metadata),
    });

    // The current workout is excluded in SQL before canonicalization. The
    // canonical picker then collapses cross-source twins before any median or
    // prompt is built.
    const historyRows = await prisma.workout.findMany({
      where: {
        userId,
        sportType: row.sportType,
        id: { not: row.id },
        startedAt: {
          gte: new Date(
            row.startedAt.getTime() - OWN_HISTORY_LOOKBACK_DAYS * MS_PER_DAY,
          ),
          lt: row.startedAt,
        },
      },
      orderBy: { startedAt: "desc" },
      take: OWN_HISTORY_MAX_ROWS,
      select: {
        id: true,
        source: true,
        startedAt: true,
        sportType: true,
        durationSec: true,
        avgHeartRate: true,
        totalDistanceM: true,
        totalEnergyKcal: true,
      },
    });
    const history = pickCanonicalWorkoutRows(
      historyRows,
      profile?.sourcePriorityJson ?? null,
    );

    const evidence = buildWorkoutInsightEvidence({
      row,
      tz,
      hrSeries,
      zones,
      routeGeometry: row.route?.geometry ?? null,
      history,
    });
    const inputHash = workoutInsightInputHash(
      evidence,
      WORKOUT_INSIGHT_PROMPT_VERSION,
    );
    const existing = await prisma.workoutInsight.findFirst({
      where: { workoutId, userId },
      select: { id: true, inputHash: true },
    });
    if (existing && existing.inputHash === inputHash) {
      return { status: "unchanged" as const };
    }

    const locale: Locale = (locales as readonly string[]).includes(
      profile?.locale ?? "",
    )
      ? (profile?.locale as Locale)
      : defaultLocale;
    return { status: "ready" as const, evidence, inputHash, locale };
  })().catch(async (err) => {
    // Nothing could have reached a provider. Delete the reservation so a
    // backed-off retry can safely reclaim both ownership and daily capacity.
    await releaseClaim().catch(() => {});
    throw err;
  });

  if (prepared.status === "unchanged") {
    await releaseClaim().catch(() => {});
    annotate({
      action: { name: "workouts.insight.skipped" },
      meta: { workoutId, reason: "unchanged" },
    });
    return { status: "skipped", reason: "unchanged" };
  }

  // This is the last durable boundary before the accounting/provider
  // chokepoint. Once written, a crash or an ambiguous persistence failure is
  // terminal: the provider may have received the request, so retrying could
  // spend twice.
  const providerClaim = await prisma.workoutInsightGenerationClaim.updateMany({
    where: {
      id: claim.claimRowId,
      userId,
      workoutId,
      claimId: claim.claimId,
      providerInvokedAt: null,
      completedAt: null,
      claimedAt: {
        gte: new Date(now.getTime() - WORKOUT_INSIGHT_CLAIM_LEASE_MS),
      },
    },
    data: { providerInvokedAt: now, claimedAt: now },
  });
  if (providerClaim.count !== 1) {
    return { status: "skipped", reason: "claim_lost" };
  }

  // The existing status chokepoint owns reserve → provider → reconcile. It is
  // called exactly once for the durable attempt; this worker never reserves or
  // reconciles separately.
  let outcome;
  try {
    outcome = await runStatusCompletion({
      userId,
      cacheAction: "insights.workout-insight",
      consentSurface: "insights",
      systemPrompt: getWorkoutInsightSystemPrompt(prepared.locale),
      userPrompt: getWorkoutInsightUserPrompt(
        JSON.stringify(prepared.evidence),
        localDate,
        prepared.locale,
        openerArchetypeHint(`${userId}:workout:${workoutId}`, prepared.locale),
      ),
      temperature: AI_BUDGETS.workoutInsight.temperature,
      maxTokens: AI_BUDGETS.workoutInsight.maxTokens,
    });
  } catch {
    await finishTerminalAttempt().catch(() => {});
    return { status: "skipped", reason: "provider_uncertain" };
  }

  if (outcome.kind !== "ok") {
    await finishTerminalAttempt().catch(() => {});
    annotate({
      action: { name: "workouts.insight.skipped" },
      meta: { workoutId, reason: outcome.kind },
    });
    return { status: "skipped", reason: outcome.kind };
  }

  const screened = finalizeStatusSummary(outcome.content, prepared.locale);
  if (!screened.ok || !screened.text) {
    await finishTerminalAttempt().catch(() => {});
    annotate({
      action: { name: "workouts.insight.outbound_blocked" },
      meta: { workoutId, reason: screened.ok ? "empty" : screened.reason },
    });
    return { status: "skipped", reason: "screened" };
  }

  const data = {
    paragraphEncrypted: encryptToBytes(screened.text),
    inputHash: prepared.inputHash,
    promptVersion: WORKOUT_INSIGHT_PROMPT_VERSION,
    providerType: outcome.providerType,
    locale: prepared.locale,
    generatedAt: now,
  };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.workoutInsight.upsert({
        where: { workoutId },
        create: { userId, workoutId, ...data },
        update: data,
      });
      const completed = await tx.workoutInsightGenerationClaim.updateMany({
        where: {
          id: claim.claimRowId,
          userId,
          workoutId,
          claimId: claim.claimId,
          providerInvokedAt: now,
          completedAt: null,
        },
        data: {
          completedAt: now,
          claimId: null,
          claimedAt: null,
        },
      });
      if (completed.count !== 1) {
        throw new Error("Workout insight generation claim was lost");
      }
    });
  } catch {
    await finishTerminalAttempt().catch(() => {});
    return { status: "skipped", reason: "persistence_uncertain" };
  }

  annotate({
    action: { name: "workouts.insight.generated" },
    meta: {
      workoutId,
      providerType: outcome.providerType,
      sportType: prepared.evidence.sportType,
      length: screened.text.length,
    },
  });
  return {
    status: "generated",
    providerType: outcome.providerType,
    length: screened.text.length,
  };
}

export async function handleWorkoutInsightGenerate(
  jobs: Job<WorkoutInsightGeneratePayload>[],
): Promise<void> {
  await withBackgroundEvent("job.workout_insight_generate", async (evt) => {
    for (const job of jobs) {
      const outcome = await runWorkoutInsightGenerate(job.data);
      evt.addMeta(
        "workout_insight",
        outcome.status === "skipped"
          ? `skipped:${outcome.reason}`
          : `generated:${outcome.providerType}`,
      );
    }
  });
}
