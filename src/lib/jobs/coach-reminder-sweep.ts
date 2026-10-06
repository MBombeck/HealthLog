/**
 * v1.22 (B2/M4) — daily Coach-reminder sweep.
 *
 * The active scheduler the "remind me" complaint needs: a single indexed query
 * per tick that brings a reminder back at its chosen moment. Two sources:
 *
 *   1. `CoachReminder` rows that are date-triggered, `active`, and whose `dueAt`
 *      has passed.
 *   2. `CoachPlan` rows whose dangling `reviewDate` (written nowhere, read
 *      nowhere until now — see the design §1c) has passed and that are still
 *      `active` → a one-off `CoachReminder` is minted from the plan's own
 *      cue→action text (relatedPlanId set, source `extractor`) and the plan's
 *      `reviewDate` is cleared so the review fires once. This finally activates
 *      the column the B1 schema anticipated.
 *
 * Both sources converge on ONE surfacing step, and that convergence is the
 * point. Until v1.37 the sweep only flipped a reminder's status to `due` and
 * stopped: nothing was written into the conversation, `surfaced` had no writer
 * at all, and the FAB lit its unread dot off a separate "is anything due?"
 * query. So the dot appeared over an empty Coach, opening it showed the empty
 * state, and opening it did not clear the dot either — the only way out was to
 * resolve the reminder in Settings, which nothing on the badge suggested. A
 * badge and the content it promises must come from one event.
 *
 * They do now. Surfacing writes the reminder into the user's Coach thread as a
 * real assistant message and flips the reminder to `surfaced` in the SAME
 * transaction, so the two cannot drift: no message, no status change, no
 * badge. The badge itself is derived from that message
 * (`readCoachNudgeStatus` compares the newest assistant message against
 * `User.coachLastSeenAt`), which means opening the Coach clears it the way it
 * clears any other proactive message.
 *
 * Rows left `due` by an older build are picked up by the same pass, so a badge
 * that has been stuck on an empty conversation resolves into the message it
 * always implied rather than staying stuck.
 *
 * While the record's `coach` capability is unavailable its reminders are held:
 * none is surfaced, charged or auto-dismissed, and they resume once the Coach
 * is back (`coachRemindersHeld`, the same answer that keeps the badge dark).
 *
 * v1.41 — the sweep also lets unanswered proposals lapse: a plan the Coach
 * proposed and a health fact waiting for the person's "Yes, remember it" are
 * dropped after `PROPOSAL_EXPIRY_DAYS`, so an ignored suggestion neither
 * blocks new ones (a person holds at most three open plan proposals) nor
 * waits forever. A lapsed plan is `abandoned`, the way the person's "Not now"
 * leaves it; a lapsed fact proposal is soft-deleted like a declined one.
 *
 * The sweep still never calls a provider and never pushes. The message body is
 * a deterministic localized template around the user's OWN note text — the
 * words they asked to be reminded of, never anything fabricated.
 *
 * Context-cue reminders (`triggerKind: "context"`) are evaluated eventfully:
 * the measurement cues by the `reminder-satisfy` worker after every ingest,
 * `NEXT_APP_OPEN` on the nudge-status read (`ai/coach/context-reminders.ts`).
 * This sweep re-runs the measurement-cue evaluation once a day as the
 * idempotent backstop for any ingest path that never enqueued — the same
 * cron-behind-event pattern the Vorsorge engine uses. Every trigger
 * converges on the ONE surfacing transaction in `ai/coach/reminder-surface.ts`.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { evaluateCoachContextReminders } from "@/lib/ai/coach/context-reminders";
import { annotate } from "@/lib/logging/context";
import {
  PROPOSAL_EXPIRY_DAYS,
  PROPOSED_FACT_SOURCE,
} from "@/lib/ai/coach/memory/shared";
import {
  coachRemindersHeld,
  surfaceCoachReminders,
} from "@/lib/ai/coach/reminder-surface";

export const COACH_REMINDER_SWEEP_QUEUE = "coach-reminder-sweep";
// Daily at 05:20 Europe/Berlin — just after the 05:15 nudge tick so both
// proactive passes run on settled overnight rows.
export const COACH_REMINDER_SWEEP_CRON = "20 5 * * *";

/** Bound the plan-review fan-out per tick so one sweep can't run unbounded. */
const PLAN_REVIEW_BATCH = 200;
/** Bound the surfacing fan-out per tick for the same reason. */
const SURFACE_BATCH = 500;
/** Bound the context-backstop fan-out per tick for the same reason. */
const CONTEXT_BACKSTOP_BATCH = 500;

/**
 * How many surfacings an untouched reminder gets before it auto-dismisses —
 * the cap the `surfaceCount` schema comment has promised since v1.22. A
 * `surfaced` row keeps riding the prompt injection and the suggested-actions
 * rail; every daily tick it is still sitting there counts as one more
 * surfacing, and at the cap the row flips to `dismissed` so an ignored
 * reminder cannot nag indefinitely.
 */
export const REMINDER_NAG_CAP = 3;
/**
 * A row surfaced within this window is not re-counted — the tick that wrote
 * the surfacing message must not also charge the first "still ignored" day.
 * 20 h (not 24) so the daily 05:20 cron never misses by clock drift.
 */
const NAG_STALE_MS = 20 * 60 * 60 * 1000;

export interface CoachReminderSweepSummary {
  /** Reminders whose moment arrived AND that reached the conversation. */
  remindersDue: number;
  planReviewsMinted: number;
  /** Context-cue reminders the daily backstop surfaced. */
  contextSurfaced: number;
  /** Ignored reminders auto-dismissed at the nag cap. */
  nagDismissed: number;
  /** Plan proposals left unanswered past the expiry, now abandoned. */
  planProposalsLapsed: number;
  /** Fact proposals left unanswered past the expiry, now dropped. */
  factProposalsLapsed: number;
  errored: number;
}

type SweepPrisma = Pick<
  PrismaClient,
  | "coachReminder"
  | "coachPlan"
  | "coachFact"
  | "coachConversation"
  | "coachMessage"
  | "measurement"
  | "user"
  | "$transaction"
>;

/**
 * Run one sweep tick. Idempotent: a reminder already `surfaced` is not
 * re-surfaced, and a plan whose `reviewDate` was cleared on a prior tick is not
 * re-minted.
 */
export async function runCoachReminderSweep(
  prisma: SweepPrisma,
  now: Date = new Date(),
): Promise<CoachReminderSweepSummary> {
  const summary: CoachReminderSweepSummary = {
    remindersDue: 0,
    planReviewsMinted: 0,
    contextSurfaced: 0,
    nagDismissed: 0,
    planProposalsLapsed: 0,
    factProposalsLapsed: 0,
    errored: 0,
  };

  // ── 0. lapse unanswered proposals ─────────────────────────────
  const lapseBefore = new Date(
    now.getTime() - PROPOSAL_EXPIRY_DAYS * 86_400_000,
  );
  try {
    const plansLapsed = await prisma.coachPlan.updateMany({
      where: {
        deletedAt: null,
        status: "proposed",
        createdAt: { lt: lapseBefore },
      },
      data: { status: "abandoned", reviewDate: null },
    });
    summary.planProposalsLapsed = plansLapsed.count;
    const factsLapsed = await prisma.coachFact.updateMany({
      where: {
        deletedAt: null,
        source: PROPOSED_FACT_SOURCE,
        createdAt: { lt: lapseBefore },
      },
      data: { deletedAt: now },
    });
    summary.factProposalsLapsed = factsLapsed.count;
    if (plansLapsed.count + factsLapsed.count > 0) {
      annotate({
        action: { name: "coach.proposals.lapsed" },
        meta: { plans: plansLapsed.count, facts: factsLapsed.count },
      });
    }
  } catch {
    summary.errored += 1;
  }

  // ── 1. mint plan-review reminders for passed reviewDates ──────
  //
  // Minted `active` with `dueAt: now` so the surfacing pass below picks them
  // up in this same tick. One path reaches the conversation, not two.
  const plans = await prisma.coachPlan.findMany({
    where: {
      deletedAt: null,
      status: "active",
      reviewDate: { not: null, lte: now },
    },
    take: PLAN_REVIEW_BATCH,
    select: {
      id: true,
      userId: true,
      metric: true,
      ifCueEncrypted: true,
      thenActionEncrypted: true,
    },
  });

  for (const plan of plans) {
    try {
      // The note is the plan's OWN cue→action prose (the user's words), never
      // fabricated. Decrypt fault-isolated — an undecryptable plan is skipped
      // (its reviewDate stays so a future key fix can still surface it).
      let note: string;
      try {
        const ifCue = decryptFromBytes(plan.ifCueEncrypted);
        const thenAction = decryptFromBytes(plan.thenActionEncrypted);
        note = `${ifCue} → ${thenAction}`.slice(0, 280);
      } catch {
        summary.errored += 1;
        continue;
      }

      // Mint the reminder and clear the plan's reviewDate atomically: if the
      // clear failed after a standalone create committed, the next tick would
      // re-select the plan (reviewDate still set) and mint a DUPLICATE review
      // reminder. One transaction makes the pair all-or-nothing.
      await prisma.$transaction([
        prisma.coachReminder.create({
          data: {
            userId: plan.userId,
            noteEncrypted: encryptToBytes(note),
            metric: plan.metric,
            relatedPlanId: plan.id,
            triggerKind: "date",
            dueAt: now,
            status: "active",
            source: "extractor",
          },
        }),
        prisma.coachPlan.update({
          where: { id: plan.id },
          data: { reviewDate: null },
        }),
      ]);
      summary.planReviewsMinted += 1;
    } catch {
      summary.errored += 1;
    }
  }

  // ── 2. surface everything whose moment has passed ─────────────
  //
  // `due` is included alongside `active` deliberately: rows an older build
  // flipped to `due` never reached a conversation, and they are exactly the
  // ones showing a badge with nothing behind it. Picking them up here converts
  // a stuck indicator into the message it always promised.
  const overdue = await prisma.coachReminder.findMany({
    where: {
      deletedAt: null,
      status: { in: ["active", "due"] },
      triggerKind: "date",
      dueAt: { not: null, lte: now },
    },
    take: SURFACE_BATCH,
    orderBy: { dueAt: "asc" },
    select: { id: true, userId: true, noteEncrypted: true },
  });

  const byUser = new Map<string, typeof overdue>();
  for (const row of overdue) {
    const bucket = byUser.get(row.userId);
    if (bucket) bucket.push(row);
    else byUser.set(row.userId, [row]);
  }

  for (const [userId, rows] of byUser) {
    // The shared surfacing step: decrypt fault-isolated per row, one
    // localized message per user, conversation + message + status flip in
    // ONE transaction. On failure the rows stay where they were — the next
    // tick retries, and until then no badge claims a message that was
    // never written.
    const outcome = await surfaceCoachReminders(prisma, userId, rows, now);
    summary.remindersDue += outcome.surfaced;
    summary.errored += outcome.errored;
  }

  // ── 3. context-cue backstop ───────────────────────────────────
  //
  // The measurement cues fire eventfully from the `reminder-satisfy`
  // worker; this daily pass re-evaluates them so an ingest path that
  // never enqueued (boss unavailable, direct DB write) still resolves
  // within a day. NEXT_APP_OPEN is deliberately absent: only a real
  // app-open signal may satisfy it.
  const contextRows = await prisma.coachReminder.findMany({
    where: {
      deletedAt: null,
      status: { in: ["active", "due"] },
      triggerKind: "context",
      contextCue: { not: "NEXT_APP_OPEN" },
    },
    take: CONTEXT_BACKSTOP_BATCH,
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  for (const userId of new Set(contextRows.map((r) => r.userId))) {
    try {
      const outcome = await evaluateCoachContextReminders(
        prisma,
        userId,
        "measurement",
        now,
      );
      summary.contextSurfaced += outcome.surfaced;
      summary.errored += outcome.errored;
    } catch {
      summary.errored += 1;
    }
  }

  // ── 4. nag cap ────────────────────────────────────────────────
  //
  // A `surfaced` reminder stays in the prompt injection and the
  // suggested-actions rail until the user acts on it. Charge every tick
  // it has already sat there for a day as one more surfacing, then
  // auto-dismiss the rows that reached the cap. Two bulk statements, no
  // message: dismissal is silence, not another nag.
  // A day the Coach was unavailable is not a day the reminder sat ignored:
  // the badge was dark and there was nothing to open. Those users' rows are
  // neither charged nor dismissed.
  const surfacedOwners = await prisma.coachReminder.findMany({
    where: { deletedAt: null, status: "surfaced" },
    distinct: ["userId"],
    select: { userId: true },
  });
  const heldOwners: string[] = [];
  for (const { userId } of surfacedOwners) {
    if (await coachRemindersHeld(userId)) heldOwners.push(userId);
  }
  const notHeld =
    heldOwners.length > 0 ? { userId: { notIn: heldOwners } } : {};
  await prisma.coachReminder.updateMany({
    where: {
      deletedAt: null,
      status: "surfaced",
      lastSurfacedAt: { lte: new Date(now.getTime() - NAG_STALE_MS) },
      ...notHeld,
    },
    data: { surfaceCount: { increment: 1 } },
  });
  const capped = await prisma.coachReminder.updateMany({
    where: {
      deletedAt: null,
      status: "surfaced",
      surfaceCount: { gte: REMINDER_NAG_CAP },
      ...notHeld,
    },
    data: { status: "dismissed" },
  });
  summary.nagDismissed = capped.count;

  return summary;
}
