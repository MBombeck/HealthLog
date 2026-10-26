/**
 * `PATCH /api/cycle/day-logs/{id}` — edit a single day-log
 * (ios-contract §2.A).
 * `DELETE /api/cycle/day-logs/{id}` — soft-delete (ios-contract §2.F):
 *   set `deletedAt` + bump `syncVersion`, emit a tombstone on the next
 *   sync page. 204. Idempotent. With `Prefer: return=representation` 200
 *   with the removed cycle and the starts given back (v1.43).
 *
 * Both are gated (`cycle.disabled` 403) and owner-scoped (a row owned by
 * another user 404s).
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import {
  ensureCycleForBleedingDay,
  removeCycleStartedOn,
} from "@/lib/cycle/cycle-boundaries";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { encrypt, decrypt } from "@/lib/crypto";
import { getOrCreateCycleProfile } from "@/lib/cycle/profile";
import { replaceSymptomLinks } from "@/lib/cycle/day-log-write";
import { cycleDayLogPatchSchema } from "@/lib/validations/cycle";
import { toCycleDayLogDTO, dayLogSymptomInclude } from "@/lib/cycle/dto";
import { cycleDeleteOutcome } from "@/lib/cycle/delete-outcome";

type RouteParams = { params: Promise<{ id: string }> };

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Editing one day of the cycle log.
    const { user } = await requireRecordAuth("manage", "cycle");

    const gate = await requireCycleEnabled(user.id, user.gender);
    if (!gate.enabled) return gate.response;

    const { id } = await params;

    const existing = await prisma.cycleDayLog.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        userId: true,
        // v1.37.0 — the day the audit row names (C4).
        date: true,
        sexualActivity: true,
        protectedSex: true,
        pregnancyTest: true,
        progesteroneTest: true,
        contraceptive: true,
        sensitiveEncrypted: true,
      },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Day-log not found", 404);
    }

    const parsed = await parseJsonBody(request, cycleDayLogPatchSchema, {
      maxBytes: 64 * 1024,
      action: "cycle.day-log.patch.validation-failed",
      countIssues: true,
      errorCode: "cycle.day-log.invalid",
    });
    if (!parsed.ok) return parsed.error;

    const body = parsed.data;

    // Resolve the stored plaintext sensitive fields (from the envelope when
    // the row was encrypted, else the columns) so a partial patch merges
    // against the true current value.
    const encryptSensitive = (await getOrCreateCycleProfile(user.id))
      .sensitiveCategoryEncryption;
    const stored = readStoredSensitive(existing);
    const merged = {
      sexualActivity:
        body.sexualActivity !== undefined
          ? body.sexualActivity
          : stored.sexualActivity,
      protectedSex:
        body.protectedSex !== undefined
          ? (body.protectedSex ?? null)
          : stored.protectedSex,
      pregnancyTest:
        body.pregnancyTest !== undefined
          ? (body.pregnancyTest ?? null)
          : stored.pregnancyTest,
      progesteroneTest:
        body.progesteroneTest !== undefined
          ? (body.progesteroneTest ?? null)
          : stored.progesteroneTest,
      contraceptive:
        body.contraceptive !== undefined
          ? (body.contraceptive ?? null)
          : stored.contraceptive,
    };

    // Field-by-field update (no mass assignment). Non-sensitive fields are
    // written only when present; the sensitive set is re-resolved and split
    // between plaintext columns and the envelope per the flag.
    await prisma.cycleDayLog.update({
      where: { id },
      data: {
        ...(body.flow !== undefined && { flow: body.flow }),
        ...(body.intermenstrualBleeding !== undefined && {
          intermenstrualBleeding: body.intermenstrualBleeding,
        }),
        ...(body.basalBodyTempC !== undefined && {
          basalBodyTempC: body.basalBodyTempC,
        }),
        ...(body.ovulationTest !== undefined && {
          ovulationTest: body.ovulationTest,
        }),
        ...(body.cervicalMucus !== undefined && {
          cervicalMucus: body.cervicalMucus,
        }),
        sexualActivity: encryptSensitive ? false : merged.sexualActivity,
        protectedSex: encryptSensitive ? null : merged.protectedSex,
        pregnancyTest: (encryptSensitive
          ? null
          : merged.pregnancyTest) as never,
        progesteroneTest: (encryptSensitive
          ? null
          : merged.progesteroneTest) as never,
        contraceptive: (encryptSensitive
          ? null
          : merged.contraceptive) as never,
        sensitiveEncrypted: encryptSensitive
          ? encrypt(JSON.stringify(merged))
          : null,
        ...(body.note !== undefined && {
          notesEncrypted: body.note ? encrypt(body.note) : null,
        }),
        syncVersion: { increment: 1 },
      },
    });

    // Replace symptom links only when `symptoms` was supplied.
    if (body.symptoms !== undefined) {
      await replaceSymptomLinks(user.id, id, body.symptoms);
    }

    const row = await prisma.cycleDayLog.findUniqueOrThrow({
      where: { id },
      include: dayLogSymptomInclude,
    });

    // An edit that turns a day into a first bleeding day opens the cycle it
    // starts, and an edit that takes the bleeding back off it removes the
    // cycle that day opened. Both directions go through the same shared
    // boundary work the capture route and the one-tap start use — a cycle that
    // could be created here but not undone here is how the record ends up
    // holding a period nothing on the day says happened.
    const openedCycleId = await ensureCycleForBleedingDay(
      user.id,
      existing.date,
      user.timezone ?? DEFAULT_TIMEZONE,
      row,
    );
    let removedCycleId: string | null = null;
    let restored: Array<{ cycleId: string; startDate: string }> = [];
    if (!openedCycleId && !stillBleeds(row)) {
      const removed = await prisma.$transaction((db) =>
        removeCycleStartedOn(db, user.id, existing.date),
      );
      removedCycleId = removed?.cycleId ?? null;
      restored = removed?.restored ?? [];
    }

    await auditLog("cycle.day-log.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C4 in this domain's shape: the date and the fields replaced, named
      // and never valued. See the sibling create route for why the values
      // stay off the audit table in this domain.
      details: {
        dayLogId: id,
        date: existing.date,
        ...(openedCycleId ? { openedCycleId } : {}),
        ...(removedCycleId ? { removedCycleId } : {}),
        ...overwriteDetails({
          before: {},
          after: {},
          redacted: Object.entries(body)
            .filter(([, value]) => value !== undefined)
            .map(([key]) => key)
            .sort(),
        }),
      },
    });

    // A day-log edit changes the cycle context the cached analytics /
    // snapshot / digest cells carry — evict the analytics bucket.
    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "cycle.day-log.update",
        entity_type: "cycle_day_log",
        entity_id: id,
      },
      meta: {
        opened_cycle: openedCycleId !== null,
        removed_cycle: removedCycleId !== null,
      },
    });

    // v1.43 (ios #116 item 9) — the starts this edit gave back by clearing
    // the flow on a start day; empty when it removed none.
    return apiSuccess({ ...toCycleDayLogDTO(row), restored });
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Soft delete: the row stays and the sync feed carries
    // it as a tombstone.
    const { user } = await requireRecordAuth("manage", "cycle");

    const gate = await requireCycleEnabled(user.id, user.gender);
    if (!gate.enabled) return gate.response;

    const { id } = await params;

    const existing = await prisma.cycleDayLog.findUnique({
      where: { id },
      select: { id: true, userId: true, date: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Day-log not found", 404);
    }

    // Soft-delete: leave the row in place so the `/api/sync/changes`
    // delta feed surfaces it as a tombstone. A re-delete re-bumps
    // `syncVersion` harmlessly (idempotent).
    //
    // A day that OPENS a cycle takes that cycle with it. The one-tap "started
    // my period" writes both rows, and this delete is the only way the web
    // offers to take it back — leaving the cycle behind meant the previous one
    // stayed closed against a start whose last trace had just been removed, and
    // the forecast never came back. The cycle boundary is then re-derived for
    // the preceding cycle, the same repair the cycle delete does.
    const removed = await prisma.$transaction(async (db) => {
      await db.cycleDayLog.update({
        where: { id },
        data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
      });
      return removeCycleStartedOn(db, user.id, existing.date);
    });

    await auditLog("cycle.day-log.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        dayLogId: id,
        date: existing.date,
        ...(removed ? { removedCycleId: removed.cycleId } : {}),
        ...(removed?.reanchored
          ? {
              reanchoredCycleId: removed.reanchored.cycleId,
              ...overwriteDetails({
                before: {
                  endDate: removed.reanchored.endDateBefore,
                  lengthDays: removed.reanchored.lengthDaysBefore,
                },
                after: {
                  endDate: removed.reanchored.endDateAfter,
                  lengthDays: removed.reanchored.lengthDaysAfter,
                },
              }),
            }
          : {}),
      },
    });

    // A removed day (possibly with its cycle) changes the cycle context the
    // cached analytics / snapshot / digest cells carry — evict the bucket.
    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "cycle.day-log.delete",
        entity_type: "cycle_day_log",
        entity_id: id,
      },
      meta: {
        removed_cycle: removed !== null,
        reanchored_prior: removed?.reanchored != null,
      },
    });

    return cycleDeleteOutcome(
      request,
      removed?.cycleId ?? null,
      removed?.restored ?? [],
    );
  },
);

/** The stored plaintext sensitive fields (envelope when encrypted, else columns). */
function readStoredSensitive(row: {
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: string | null;
  progesteroneTest: string | null;
  contraceptive: string | null;
  sensitiveEncrypted: string | null;
}): {
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: string | null;
  progesteroneTest: string | null;
  contraceptive: string | null;
} {
  if (row.sensitiveEncrypted) {
    try {
      const dec = JSON.parse(decrypt(row.sensitiveEncrypted)) as Record<
        string,
        unknown
      >;
      return {
        sexualActivity: (dec.sexualActivity as boolean) ?? false,
        protectedSex: (dec.protectedSex as boolean | null) ?? null,
        pregnancyTest: (dec.pregnancyTest as string | null) ?? null,
        progesteroneTest: (dec.progesteroneTest as string | null) ?? null,
        contraceptive: (dec.contraceptive as string | null) ?? null,
      };
    } catch {
      // Fail-soft: an undecryptable envelope reads as cleared.
      return {
        sexualActivity: false,
        protectedSex: null,
        pregnancyTest: null,
        progesteroneTest: null,
        contraceptive: null,
      };
    }
  }
  return {
    sexualActivity: row.sexualActivity,
    protectedSex: row.protectedSex,
    pregnancyTest: row.pregnancyTest,
    progesteroneTest: row.progesteroneTest,
    contraceptive: row.contraceptive,
  };
}

/**
 * Whether the edited day still records a period. A cleared or downgraded flow,
 * or one re-flagged as bleeding between periods, no longer anchors a cycle.
 */
function stillBleeds(row: {
  flow: string | null;
  intermenstrualBleeding: boolean;
}): boolean {
  if (row.intermenstrualBleeding) return false;
  return row.flow !== null && row.flow !== "NONE" && row.flow !== "SPOTTING";
}
