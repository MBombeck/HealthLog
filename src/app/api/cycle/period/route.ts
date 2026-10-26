/**
 * `POST /api/cycle/period` — one-tap period-boundary shortcut
 * (ios-contract §2.C).
 *
 * `action:"start"` opens a new `MenstrualCycle` anchored at `date`,
 * closes the prior open cycle (endDate = day before, lengthDays set),
 * and writes the boundary `CycleDayLog(flow=MEDIUM)`. `action:"end"`
 * stamps the current cycle's `periodEndDate` and writes the boundary
 * day-log. Convenience over §2.A; returns
 * `{ cycle: MenstrualCycleDTO, dayLog: CycleDayLogDTO, absorbed }`, where
 * `absorbed` names a later start this one folded in (v1.43, null otherwise).
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { withIdempotency } from "@/lib/idempotency";
import { cyclePeriodSchema } from "@/lib/validations/cycle";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";
import type { FlowLevel } from "@/lib/cycle/types";
import {
  toCycleDayLogDTO,
  toMenstrualCycleDTO,
  dayLogSymptomInclude,
} from "@/lib/cycle/dto";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { openCycleAt, type MovedAnchors } from "@/lib/cycle/cycle-boundaries";

export const POST = apiHandler(withIdempotency<[NextRequest]>(postPeriod));

/**
 * v1.37.0 — the anchors a boundary write moves, carried out of the
 * transaction so the audit row can name them (C4). The `start` arm's own
 * anchors live with the shared boundary helper; the `end` arm adds the one
 * column it overwrites.
 */
type PeriodMovedAnchors = MovedAnchors & {
  periodEndDateBefore?: string | null;
  periodEndDateAfter?: string | null;
};

async function postPeriod(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE. Setting a boundary re-anchors the neighbouring cycles,
  // which is the destructive part of it: a handful of dates move and nothing
  // else records what they were. The audit row below carries them (C4).
  const { user } = await requireRecordAuth("manage", "cycle");

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(request, cyclePeriodSchema, {
    maxBytes: 64 * 1024,
    errorCode: "cycle.period.invalid",
    onInvalid: (error, rawBody) => {
      const shape = unstableExternalIdShape(rawBody);
      annotate({
        action: { name: "cycle.period.validation-failed" },
        meta: {
          issue_count: error.issues.length,
          ...(shape ? unstableExternalIdMeta("cycle.period", [shape]) : {}),
        },
      });
    },
  });
  if (!parsed.ok) return parsed.error;

  const { action, date, externalId, loggedAt } = parsed.data;
  const tz = user.timezone ?? DEFAULT_TIMEZONE;

  // The close-prior + open-new (start) or stamp-current (end) mutation set
  // is run inside a single transaction so two concurrent taps can never
  // double-close a prior cycle or compute the new cycle's length against a
  // stale read. `withIdempotency` on the route additionally collapses an
  // exact-key replay; the transaction guards the interleaving case.
  const txResult = await prisma.$transaction(async (db) => {
    if (action === "start") {
      // Close the prior open cycle, open this one, and re-anchor the following
      // neighbour when the start is back-filled between two existing cycles.
      // The same helper runs when a first bleeding day is captured as flow, so
      // a period start means one thing however it was entered.
      const { cycleId, moved } = await openCycleAt(db, user.id, date, tz);
      return {
        cycleId: cycleId as string | null,
        moved: moved as PeriodMovedAnchors,
      };
    }

    // `end`: stamp the current cycle's periodEndDate.
    const current = await db.menstrualCycle.findFirst({
      where: { userId: user.id, deletedAt: null, startDate: { lte: date } },
      orderBy: { startDate: "desc" },
      // v1.37.0 — `periodEndDate` for the audit row: this arm overwrites it.
      select: { id: true, periodEndDate: true },
    });
    if (!current) {
      return { cycleId: null, moved: {} satisfies PeriodMovedAnchors };
    }
    await db.menstrualCycle.update({
      where: { id: current.id },
      data: { periodEndDate: date, syncVersion: { increment: 1 } },
    });
    return {
      cycleId: current.id as string | null,
      moved: {
        periodEndDateBefore: current.periodEndDate,
        periodEndDateAfter: date,
      } satisfies PeriodMovedAnchors,
    };
  });

  if (txResult.cycleId === null) {
    return apiSuccessNoCycle();
  }
  const cycleId: string = txResult.cycleId;

  // Boundary flow. Start → MEDIUM opens the bleed; end → SPOTTING tail.
  // Never downgrade a richer flow already logged for the same day (e.g. a
  // manual HEAVY entry must survive a later one-tap "start") — only set the
  // boundary flow when it ranks at or above what's stored.
  const boundaryFlow: FlowLevel = action === "start" ? "MEDIUM" : "SPOTTING";
  const existingDay = await prisma.cycleDayLog.findFirst({
    where: { userId: user.id, date, deletedAt: null },
    select: { flow: true },
  });
  const flow =
    flowRank(boundaryFlow) >= flowRank(existingDay?.flow ?? null)
      ? boundaryFlow
      : undefined;

  await upsertCycleDayLog(
    user.id,
    {
      date,
      ...(flow !== undefined ? { flow } : {}),
      loggedAt,
      source: "MANUAL",
      ...(externalId ? { externalId } : {}),
    },
    tz,
    cycleId,
  );

  const [cycleRow, dayLogRow] = await Promise.all([
    prisma.menstrualCycle.findUniqueOrThrow({ where: { id: cycleId } }),
    prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: user.id, date, deletedAt: null },
      include: dayLogSymptomInclude,
    }),
  ]);

  await auditLog("cycle.period.boundary", {
    userId: user.id,
    ipAddress: getClientIp(request),
    // The dates this boundary moved on the neighbouring cycles. They are
    // the only unrecoverable part of the write: the day log it upserts is a
    // row, the re-anchoring is an overwrite of two columns on somebody else's
    // cycle history.
    details: {
      action,
      date,
      cycleId,
      ...(txResult.moved.priorCycleId
        ? { priorCycleId: txResult.moved.priorCycleId }
        : {}),
      // A later start folded into this one (the same period, recorded in
      // the other order): name the row that stopped existing and its date.
      ...(txResult.moved.absorbedCycleId
        ? {
            absorbedCycleId: txResult.moved.absorbedCycleId,
            absorbedStartDate: txResult.moved.absorbedStartDate,
          }
        : {}),
      ...overwriteDetails({
        before: {
          priorEndDate: txResult.moved.priorEndDateBefore,
          priorLengthDays: txResult.moved.priorLengthBefore,
          openedEndDate: txResult.moved.openedEndDateBefore,
          periodEndDate: txResult.moved.periodEndDateBefore,
        },
        after: {
          priorEndDate: txResult.moved.priorEndDateAfter,
          priorLengthDays: txResult.moved.priorLengthAfter,
          openedEndDate: txResult.moved.openedEndDateAfter,
          periodEndDate: txResult.moved.periodEndDateAfter,
        },
      }),
    },
  });

  // A period boundary changes the cycle context the cached analytics /
  // snapshot / digest cells carry — evict the analytics bucket.
  invalidateUserHealthContext(user.id);

  annotate({
    action: {
      name: "cycle.period.boundary",
      entity_type: "menstrual_cycle",
      entity_id: cycleId,
    },
    meta: { boundary: action },
  });

  return apiSuccess({
    cycle: toMenstrualCycleDTO(cycleRow),
    dayLog: toCycleDayLogDTO(dayLogRow),
    // v1.43 (ios #116 item 9) — a later start inside the same period that
    // this start folded in, so the client can say which date stopped being a
    // start. Null when nothing was folded; present on every `start`.
    absorbed:
      txResult.moved.absorbedCycleId && txResult.moved.absorbedStartDate
        ? {
            cycleId: txResult.moved.absorbedCycleId,
            startDate: txResult.moved.absorbedStartDate,
          }
        : null,
  });
}

/** `end` with no preceding cycle is a no-op the client should not hit. */
function apiSuccessNoCycle(): Response {
  return apiSuccess({ cycle: null, dayLog: null, absorbed: null });
}

/**
 * Ordinal rank of a flow level (NONE = 0 … HEAVY = 5; a missing flow ranks
 * below NONE). Used to keep the one-tap boundary flow from downgrading a
 * richer same-day entry.
 */
function flowRank(flow: FlowLevel | string | null): number {
  switch (flow) {
    case "NONE":
      return 1;
    case "SPOTTING":
      return 2;
    case "LIGHT":
      return 3;
    case "MEDIUM":
      return 4;
    case "HEAVY":
      return 5;
    default:
      return 0;
  }
}
