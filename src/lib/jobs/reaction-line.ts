/**
 * The `reaction-line-generate` worker — the day's single sentence about what
 * just landed.
 *
 * This is the ONE provider call the arrival spine can cause, and the whole
 * design of the surface is arranged so that call is bounded before it is made:
 *
 *   - The THROTTLE is a durable unique row plus a provider-attempt timestamp.
 *     The worker conditionally owns a lease, then writes
 *     `generationProviderInvokedAt` immediately before egress. A crash,
 *     timeout, racing spine job, retry, or hand-sent job therefore cannot
 *     produce a second provider call for the same kind and local day.
 *   - The SPEND reservation and its marker linkage commit in one PostgreSQL
 *     transaction. A pre-provider retry reuses that reservation. Reported
 *     usage is reconciled before ciphertext commits; unknown usage retains the
 *     conservative reservation.
 *   - The FLOOR is complete without any of this. No provider, no consent, an
 *     exhausted budget, a refused output, a dead network — every one of them
 *     leaves the row line-less, and a line-less row still drives the "just in"
 *     chip and the provisional→final flip. The reaction is a state change; the
 *     sentence is garnish. `reaction-line-degradation.test.ts` holds that line.
 *
 * The prompt starts with the exact owned row referenced by the arrival marker
 * (or its exact occurrence timestamp), projected to bounded numeric fields.
 * The deterministic digest adds only the same computed context rendered next
 * to the reaction.
 */
import type { Job } from "pg-boss";

import { prisma } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { resolveProviderChain } from "@/lib/ai/provider";
import {
  chainRequiresServerManagedConsent,
  hasActiveConsentForSurface,
} from "@/lib/ai/consent-guard";
import { isModuleEnabled } from "@/lib/modules/gate";
import {
  buildDateKey,
  reconcileSpend,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { screenCoachReply } from "@/lib/ai/coach/outbound-guard";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { fenceUserText } from "@/lib/ai/coach/data-fence";
import { singleUserTurn, type CompletionResult } from "@/lib/ai/types";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import type { DailyDigest } from "@/lib/daily/digest";
import {
  pickMainNightAndNaps,
  reconstructSleepSessions,
} from "@/lib/analytics/sleep-night";
import {
  getArrivalReactionSystemPrompt,
  getArrivalReactionUserPrompt,
} from "@/lib/ai/prompts/arrival-reaction";
import {
  REACTION_LINE_QUEUE,
  type ReactionLineJob,
} from "@/lib/arrivals/reaction-line-shared";

import { workerLog } from "./reminder/shared";

export { REACTION_LINE_QUEUE };

/** Upstream timeout. A hero line is not worth holding a worker slot for long. */
export const REACTION_LINE_TIMEOUT_MS = 12_000;

/**
 * Hard ceiling on a shippable line. The contract asks for one sentence; a
 * model that returns a paragraph has not followed it, and clamping mid-thought
 * would ship a truncated verdict. Reject and keep the deterministic lead.
 */
export const REACTION_LINE_MAX_CHARS = 240;

/**
 * Tokens reserved per call.
 *
 * Sized to the whole call, not the output ceiling: the base assessment system
 * prompt plus a compact evidence block plus the 220-token output. Reserving
 * only the output would let a day's reactions spend materially more than they
 * booked against the user's daily cap — the reconcile corrects the number
 * afterwards, but the CAP check happens at reservation time.
 */
export const ARRIVAL_REACTION_RESERVE_TOKENS = 1_400;

/** A dead worker's claim becomes recoverable well beyond the 13s call timeout. */
export const REACTION_LINE_CLAIM_LEASE_MS = 2 * 60_000;

export type ReactionLineOutcome =
  { status: "skipped"; reason: string } | { status: "generated" };

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * Normalise the model's output into a shippable sentence, or null.
 *
 * Rejects rather than repairs: a line that broke the shape broke the contract,
 * and the deterministic lead it would replace is already good.
 */
export function sanitiseReactionLine(
  raw: string,
  locale: Locale,
): string | null {
  let text = (raw ?? "").trim();
  if (!text) return null;
  text = text
    .replace(/^["“”'`]+/, "")
    .replace(/["“”'`]+$/, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length > REACTION_LINE_MAX_CHARS) return null;
  // The same outbound content fence the Coach reply path runs — a dose
  // prescription or a fabricated risk score never reaches the hero.
  if (screenCoachReply(text, locale).block) return null;
  return text;
}

/**
 * Ground the reaction in the row that actually triggered this marker. This is
 * intentionally a narrow, labels-and-numbers-only projection: no notes or
 * other free text can enter the provider prompt through this path.
 */
async function loadArrivalEvidence(
  job: ReactionLineJob,
  row: { occurredAt: Date; refId: string | null },
  user: { timezone: string; sourcePriorityJson: unknown },
): Promise<string> {
  if (job.kind === "weight" || job.kind === "blood_pressure") {
    const types =
      job.kind === "weight"
        ? (["WEIGHT"] as const)
        : (["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] as const);
    const readings = await prisma.measurement.findMany({
      where: {
        userId: job.userId,
        type: { in: [...types] },
        measuredAt: row.occurredAt,
        deletedAt: null,
      },
      select: { type: true, value: true, unit: true },
      orderBy: { type: "asc" },
    });
    if (readings.length > 0) {
      return readings
        .map(
          (reading) =>
            `- Newly arrived reading: ${reading.type} ${reading.value} ${reading.unit}.`,
        )
        .join("\n");
    }
  }

  if (job.kind === "sleep_night") {
    const sleepWindowBeforeMs = 18 * 60 * 60 * 1_000;
    const sleepWindowAfterMs = 6 * 60 * 60 * 1_000;
    const readings = await prisma.measurement.findMany({
      where: {
        userId: job.userId,
        type: "SLEEP_DURATION",
        measuredAt: {
          gte: new Date(row.occurredAt.getTime() - sleepWindowBeforeMs),
          lte: new Date(row.occurredAt.getTime() + sleepWindowAfterMs),
        },
        deletedAt: null,
      },
      select: {
        value: true,
        measuredAt: true,
        sleepStage: true,
        source: true,
        deviceType: true,
      },
      orderBy: { measuredAt: "asc" },
    });
    const sessions = reconstructSleepSessions(
      readings,
      user.timezone,
      user.sourcePriorityJson,
    );
    const occurredAtMs = row.occurredAt.getTime();
    const anchor = sessions
      .filter(
        (session) =>
          session.start.getTime() <= occurredAtMs &&
          session.end.getTime() >= occurredAtMs,
      )
      .sort(
        (a, b) =>
          Math.abs(a.end.getTime() - occurredAtMs) -
          Math.abs(b.end.getTime() - occurredAtMs),
      )
      .at(0);
    if (anchor) {
      const { main } = pickMainNightAndNaps(
        sessions.filter((session) => session.night === anchor.night),
      );
      if (main) {
        const details = [
          `${Math.round(main.asleepMinutes)} minutes asleep`,
          main.awakeMinutes === null
            ? null
            : `${Math.round(main.awakeMinutes)} minutes awake`,
          main.inBedMinutes === null
            ? null
            : `${Math.round(main.inBedMinutes)} minutes in bed`,
        ].filter((detail): detail is string => detail !== null);
        return `- Last night's completed sleep: ${details.join("; ")}.`;
      }
    }
  }

  if (job.kind === "workout" && row.refId) {
    const workout = await prisma.workout.findFirst({
      where: { id: row.refId, userId: job.userId },
      select: {
        sportType: true,
        durationSec: true,
        totalDistanceM: true,
        totalEnergyKcal: true,
        avgHeartRate: true,
      },
    });
    if (workout) {
      return `- Newly arrived workout: ${workout.sportType}; duration ${workout.durationSec} seconds; distance ${workout.totalDistanceM ?? "not reported"} metres; energy ${workout.totalEnergyKcal ?? "not reported"} kcal; average heart rate ${workout.avgHeartRate ?? "not reported"} bpm.`;
    }
  }

  if (job.kind === "labs_panel") {
    const labs = await prisma.labResult.findMany({
      where: {
        userId: job.userId,
        takenAt: row.occurredAt,
        deletedAt: null,
        ...(row.refId ? { panel: row.refId } : {}),
      },
      select: { analyte: true, value: true, valueText: true, unit: true },
      orderBy: { analyte: "asc" },
      take: 8,
    });
    if (labs.length > 0) {
      return labs
        .map((lab) => {
          const value =
            lab.value === null
              ? fenceUserText(lab.valueText ?? "not reported")
              : String(lab.value);
          const unit = lab.unit ? ` ${fenceUserText(lab.unit)}` : "";
          return `- Newly arrived lab result: ${fenceUserText(lab.analyte)} ${value}${unit}.`;
        })
        .join("\n");
    }
  }

  return "- The arrival marker was written, but its exact value is unavailable.";
}

/**
 * The deterministic evidence block. The first section is the exact new datum;
 * the remaining context comes from the already-computed digest the line will
 * sit inside.
 */
function buildEvidence(
  arrived: string,
  digest: {
    score: { value: number; band: string; delta: number | null } | null;
    topSignal: { headline: string; delta: string | null } | null;
    briefingLead: string | null;
  },
): string {
  const parts: string[] = [arrived];
  if (digest.score) {
    const delta =
      digest.score.delta === null
        ? "no baseline comparison available"
        : `${digest.score.delta > 0 ? "+" : ""}${Math.round(digest.score.delta)} vs their baseline`;
    parts.push(
      `- Health score: ${Math.round(digest.score.value)} (${digest.score.band}), ${delta}.`,
    );
  }
  if (digest.topSignal) {
    parts.push(
      `- Today's leading signal: ${digest.topSignal.headline}${
        digest.topSignal.delta ? ` (${digest.topSignal.delta})` : ""
      }.`,
    );
  }
  if (digest.briefingLead) {
    parts.push(`- The day's standing read: ${digest.briefingLead}`);
  }
  return parts.join("\n");
}

type ReactionReservation = {
  allowed: boolean;
  reserved: number;
  dateKey: string;
};

class ReactionClaimLostError extends Error {
  constructor() {
    super("Arrival reaction generation claim was lost");
  }
}

/**
 * Atomically reserve the token ceiling and link that reservation to the
 * claimed marker. If either write fails, PostgreSQL rolls both back; a stale
 * claimant can therefore never reserve twice after crashing between them.
 */
async function reserveClaimBudget(
  rowId: string,
  generationClaimId: string,
  userId: string,
  revision: Date,
  dateKey: string,
  cap: number,
): Promise<ReactionReservation> {
  return prisma.$transaction(async (tx) => {
    const stillOwned = await tx.arrivalReaction.updateMany({
      where: {
        id: rowId,
        userId,
        occurredAt: revision,
        generatedAt: null,
        generationClaimId,
        generationProviderInvokedAt: null,
        generationReservedTokens: null,
        generationBudgetDateKey: null,
      },
      data: { generationClaimedAt: new Date() },
    });
    if (stillOwned.count !== 1) throw new ReactionClaimLostError();

    const reserved = ARRIVAL_REACTION_RESERVE_TOKENS;
    const rows = await tx.$queryRaw<{ total_tokens: number }[]>`
      INSERT INTO coach_usage (id, user_id, date_key, total_tokens, message_count, created_at, updated_at)
      VALUES (gen_random_uuid()::text, ${userId}, ${dateKey}, ${reserved}, 1, NOW(), NOW())
      ON CONFLICT (user_id, date_key) DO UPDATE SET
        total_tokens = coach_usage.total_tokens + ${reserved},
        message_count = coach_usage.message_count + 1,
        updated_at = NOW()
      RETURNING total_tokens
    `;
    const totalAfter = Number(rows[0]?.total_tokens ?? reserved);
    if (totalAfter - reserved >= cap) {
      await tx.$executeRaw`
        UPDATE coach_usage
        SET total_tokens = GREATEST(0, total_tokens - ${reserved}),
            message_count = GREATEST(0, message_count - 1),
            updated_at = NOW()
        WHERE user_id = ${userId} AND date_key = ${dateKey}
      `;
      await tx.arrivalReaction.updateMany({
        where: { id: rowId, userId, occurredAt: revision, generationClaimId },
        data: { generationClaimId: null, generationClaimedAt: null },
      });
      return { allowed: false, reserved, dateKey };
    }

    const linked = await tx.arrivalReaction.updateMany({
      where: {
        id: rowId,
        userId,
        occurredAt: revision,
        generatedAt: null,
        generationClaimId,
        generationProviderInvokedAt: null,
        generationReservedTokens: null,
        generationBudgetDateKey: null,
      },
      data: {
        generationReservedTokens: reserved,
        generationBudgetDateKey: dateKey,
      },
    });
    if (linked.count !== 1) throw new ReactionClaimLostError();

    return { allowed: true, reserved, dateKey };
  });
}

/**
 * Generate and persist one reaction line.
 *
 * Every refusal RETURNS a status rather than throwing — the discipline the
 * spine's worker documents at length. A ceiling that does not move until the
 * local day rolls over must never be retried against.
 */
export async function runReactionLine(
  job: ReactionLineJob,
): Promise<ReactionLineOutcome> {
  const revision = new Date(job.revision);
  if (Number.isNaN(revision.getTime())) {
    return { status: "skipped", reason: "invalid_revision" };
  }

  const row = await prisma.arrivalReaction.findUnique({
    where: {
      userId_kind_localDate: {
        userId: job.userId,
        kind: job.kind,
        localDate: job.localDate,
      },
      occurredAt: revision,
    },
    select: {
      id: true,
      generatedAt: true,
      generationClaimId: true,
      generationClaimedAt: true,
      generationReservedTokens: true,
      generationBudgetDateKey: true,
      generationProviderInvokedAt: true,
      occurredAt: true,
      refId: true,
    },
  });

  if (!row) return { status: "skipped", reason: "no_marker" };
  if (row.generatedAt !== null) {
    return { status: "skipped", reason: "already_generated" };
  }
  // This timestamp is written immediately before provider invocation. Even if
  // every subsequent database write failed, a retry cannot spend again.
  if (row.generationProviderInvokedAt != null) {
    return { status: "skipped", reason: "already_attempted" };
  }

  if (!(await isModuleEnabled(job.userId, "insights"))) {
    return { status: "skipped", reason: "module_disabled" };
  }

  const user = await prisma.user.findUnique({ where: { id: job.userId } });
  if (!user) return { status: "skipped", reason: "no_user" };

  const locale = resolveLocale(user.locale);
  const chain = await resolveProviderChain(job.userId);
  if (chain.length === 0) return { status: "skipped", reason: "no_provider" };

  if (
    chainRequiresServerManagedConsent(chain) &&
    !(await hasActiveConsentForSurface(job.userId, "insights"))
  ) {
    return { status: "skipped", reason: "consent_required" };
  }

  const generationClaimId = randomUUID();
  const claimedAt = new Date();
  const claimed = await prisma.arrivalReaction.updateMany({
    where: {
      id: row.id,
      userId: job.userId,
      occurredAt: revision,
      generatedAt: null,
      generationProviderInvokedAt: null,
      OR: [
        { generationClaimId: null },
        {
          generationClaimedAt: {
            lt: new Date(claimedAt.getTime() - REACTION_LINE_CLAIM_LEASE_MS),
          },
        },
      ],
    },
    data: { generationClaimId, generationClaimedAt: claimedAt },
  });
  if (claimed.count !== 1) {
    return { status: "skipped", reason: "already_claimed" };
  }

  const releaseClaim = async () => {
    await prisma.arrivalReaction.updateMany({
      where: {
        id: row.id,
        userId: job.userId,
        occurredAt: revision,
        generationClaimId,
        generationProviderInvokedAt: null,
      },
      data: { generationClaimId: null, generationClaimedAt: null },
    });
  };
  const finishTerminalAttempt = async () => {
    await prisma.arrivalReaction.updateMany({
      where: {
        id: row.id,
        userId: job.userId,
        occurredAt: revision,
        generationClaimId,
        generationProviderInvokedAt: { not: null },
      },
      data: { generationClaimId: null, generationClaimedAt: null },
    });
  };

  const hasReservedTokens = row.generationReservedTokens != null;
  const hasReservationDate = row.generationBudgetDateKey != null;
  if (hasReservedTokens !== hasReservationDate) {
    await releaseClaim().catch(() => {});
    return { status: "skipped", reason: "invalid_reservation_state" };
  }

  let reservation: ReactionReservation;
  if (hasReservedTokens && hasReservationDate) {
    reservation = {
      allowed: true,
      reserved: row.generationReservedTokens!,
      dateKey: row.generationBudgetDateKey!,
    };
  } else {
    try {
      reservation = await reserveClaimBudget(
        row.id,
        generationClaimId,
        job.userId,
        revision,
        buildDateKey(),
        resolveDailyCap(chain),
      );
    } catch (err) {
      if (err instanceof ReactionClaimLostError) {
        return { status: "skipped", reason: "claim_lost" };
      }
      await releaseClaim().catch(() => {});
      throw err;
    }
  }
  if (!reservation.allowed) {
    return { status: "skipped", reason: "budget_exceeded" };
  }

  const budget = AI_BUDGETS.arrivalReaction;
  const maxTokens = budget.maxTokens ?? 220;
  let digest: DailyDigest;
  let arrived: string;
  try {
    [digest, arrived] = await Promise.all([
      loadDailyDigest(user),
      loadArrivalEvidence(job, row, user),
    ]);
  } catch (err) {
    // No provider was touched, so releasing ownership is retry-safe. The
    // durable reservation remains attached and is reused by the retry.
    await releaseClaim().catch(() => {});
    throw err;
  }

  // Revalidate the exact owner and a live lease at the last durable boundary
  // before spend. Setting `generationProviderInvokedAt` first is conservative:
  // a crash on the following instruction may lose the garnish, never money.
  const providerInvokedAt = new Date();
  const providerClaim = await prisma.arrivalReaction.updateMany({
    where: {
      id: row.id,
      userId: job.userId,
      occurredAt: revision,
      generatedAt: null,
      generationClaimId,
      generationProviderInvokedAt: null,
      generationReservedTokens: reservation.reserved,
      generationBudgetDateKey: reservation.dateKey,
      generationClaimedAt: {
        gte: new Date(
          providerInvokedAt.getTime() - REACTION_LINE_CLAIM_LEASE_MS,
        ),
      },
    },
    data: {
      generationProviderInvokedAt: providerInvokedAt,
      generationClaimedAt: providerInvokedAt,
    },
  });
  if (providerClaim.count !== 1) {
    return { status: "skipped", reason: "claim_lost" };
  }

  let result: CompletionResult;
  try {
    result = await chain[0].instance.generateCompletion(
      singleUserTurn({
        system: getArrivalReactionSystemPrompt(locale),
        user: getArrivalReactionUserPrompt(
          {
            kind: job.kind,
            evidence: buildEvidence(arrived, digest),
            openerHint: openerArchetypeHint(
              `${job.userId}:reaction:${job.kind}:${job.localDate}`,
              locale,
            ),
          },
          locale,
        ),
        temperature: budget.temperature,
        maxTokens,
        timeoutMs: REACTION_LINE_TIMEOUT_MS,
        signal: AbortSignal.timeout(REACTION_LINE_TIMEOUT_MS + 1_000),
      }),
    );
  } catch (err) {
    // Invocation is durable and terminal. A provider error may still have
    // burned tokens, so retain the conservative reservation and never retry.
    await reconcileSpend(
      job.userId,
      reservation.reserved,
      reservation.reserved,
      reservation.dateKey,
    ).catch(() => {});
    await finishTerminalAttempt().catch(() => {});
    workerLog("error", "[reaction-line] generation failed", err);
    return { status: "skipped", reason: "provider_failed" };
  }

  try {
    await reconcileSpend(
      job.userId,
      reservation.reserved,
      result.tokensUsed ?? reservation.reserved,
      reservation.dateKey,
      result.cachedInputTokens ?? 0,
    );
  } catch (err) {
    // Do not publish a line whose spend was not durably reconciled. The
    // invocation timestamp remains terminal, preventing a second provider call.
    await finishTerminalAttempt().catch(() => {});
    workerLog("error", "[reaction-line] spend reconciliation failed", err);
    return { status: "skipped", reason: "spend_reconciliation_failed" };
  }

  const line = sanitiseReactionLine(result.content, locale);
  if (!line) {
    await finishTerminalAttempt().catch(() => {});
    return { status: "skipped", reason: "unusable_output" };
  }

  const committed = await prisma.arrivalReaction.updateMany({
    where: {
      id: row.id,
      userId: job.userId,
      occurredAt: revision,
      generationClaimId,
      generationProviderInvokedAt: providerInvokedAt,
      generatedAt: null,
    },
    data: {
      lineEncrypted: encryptToBytes(line),
      generatedAt: new Date(),
      generationClaimId: null,
      generationClaimedAt: null,
    },
  });
  if (committed.count !== 1) {
    return { status: "skipped", reason: "claim_lost" };
  }

  return { status: "generated" };
}

export async function handleReactionLine(
  jobs: Job<ReactionLineJob>[],
): Promise<void> {
  await withBackgroundEvent("job.reaction_line", async (evt) => {
    for (const job of jobs) {
      try {
        const outcome = await runReactionLine(job.data);

        if (outcome.status === "skipped") {
          annotate({
            action: { name: "arrival.reaction_line.skipped" },
            meta: { reason: outcome.reason, kind: job.data.kind },
          });
          evt.addMeta("reaction_line", `skipped:${outcome.reason}`);
          continue;
        }

        annotate({
          action: { name: "arrival.reaction_line.generated" },
          meta: { kind: job.data.kind, local_date: job.data.localDate },
        });
        evt.addMeta("reaction_line", "generated");
      } catch (err) {
        // Only a pre-provider transient fault reaches here. The durable
        // reservation is reused on retry; a provider-invoked marker returns a
        // terminal skipped outcome instead of spending twice.
        workerLog("error", "[reaction-line] pass failed", err);
        throw err;
      }
    }
  });
}
