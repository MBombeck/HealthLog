import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { createMedicationSchema } from "@/lib/validations/medication";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import {
  getMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { readMedicationsListCached } from "@/lib/medications/list-read";
import { serializeScheduleUnitsPerDose } from "@/lib/medications/schedule-units-dto";
import { withIdempotency } from "@/lib/idempotency";
import { NextRequest } from "next/server";

// v1.32.25 — blast-radius cap on externally-mirrored medications per user.
// A client that mints a fresh `externalId` for the same source concept on
// every sync sweep (a known iOS unstable-key bug class) never matches the
// idempotency triple, so each sweep would otherwise create a new mirror
// row unbounded. Apple's own medication list makes >30 genuinely distinct
// meds implausible, so this caps the damage a buggy client can do without
// breaking any legitimate use.
const APPLE_HEALTH_MIRROR_CAP = 30;

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "medications");

  // Cache the list shape on userId. The 60 s fresh TTL bounds the
  // cross-midnight staleness window for `todayEventCount` and the
  // next-due fields; the read goes through `cachedSwr`, so a visit
  // minutes after the last one serves the prior list immediately while
  // one background recompute warms a fresh entry (the 10-minute stale
  // window bounds how old that served list can be). Interactive writes
  // via POST/PUT/DELETE hard-evict through
  // `invalidateUserMedications({ evict: true })` before the next read
  // lands; background sync paths mark the bucket stale instead. The RSC
  // wrapper (`src/app/medications/page.tsx`) shares this exact cell.
  const result = await readMedicationsListCached(user);

  annotate({
    action: { name: "medication.list" },
    meta: { count: result.length },
  });

  return apiSuccess(result);
});

/**
 * v1.28 — idempotent response for a re-mirrored medication. The create
 * route returns the EXISTING row (status 200, vs 201 for a fresh create)
 * when the caller re-posts a `(externalSource, externalId)` pair this
 * user already mirrors — the iOS re-sync replays its full HealthKit
 * medication list, and a replay must neither duplicate nor 500. Response
 * shape mirrors the fresh-create envelope (schedules included, category
 * joined, Decimal unwrapped); no audit row and no cache eviction because
 * nothing was written.
 */
async function respondWithExistingMirror(
  medication: Record<string, unknown> & {
    id: string;
    unitsPerDose: unknown;
    schedules: Array<{ unitsPerDose: Prisma.Decimal | null }>;
  },
): Promise<Response> {
  let category = "OTHER";
  try {
    const categories = await getMedicationCategories([medication.id]);
    category = categories[medication.id] ?? "OTHER";
  } catch {
    getEvent()?.addWarning("Medication categories could not be loaded");
  }

  annotate({
    action: {
      name: "medication.create",
      entity_type: "medication",
      entity_id: medication.id,
    },
    meta: { idempotent_replay: true },
  });

  return apiSuccess({
    ...medication,
    unitsPerDose: Number(medication.unitsPerDose),
    // #219 — Decimal → number for the per-schedule column too.
    schedules: serializeScheduleUnitsPerDose(
      medication.schedules,
      Number(medication.unitsPerDose),
    ),
    category,
  });
}

/**
 * The create is wrapped in `withIdempotency` so a client replaying its offline
 * outbox after a lost success response replays the first answer instead of
 * minting a second medication. The `(externalSource, externalId)` dedupe below
 * only ever covered a MIRRORED create; a manually entered medication carries
 * neither field and had nothing to collapse a retry onto.
 */
export const POST = apiHandler(withIdempotency<[NextRequest]>(postMedication));

async function postMedication(request: NextRequest): Promise<Response> {
  // v1.36.x — a delegated write, and the asymmetric one: a delegate can ADD a
  // medication with its whole nested schedule, and can never edit or delete
  // it afterwards — `PUT /api/medications/[id]` and the DELETE beside it stay
  // on `requireAuth()` and refuse under a switch. Adding is help; rewriting
  // the owner's cabinet is not.
  const { user } = await requireRecordAuth("write", "medications");

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = createMedicationSchema.safeParse(body);
  if (!parsed.success) {
    // Surface an unstable concept id as its own wide event: the refusal
    // is the visible half of the phantom-mirror class, and a silent 422
    // in the generic bucket is how it stayed invisible the first time.
    const shape = unstableExternalIdShape(body);
    if (shape) {
      annotate({
        action: { name: "medication.external_id.rejected" },
        meta: unstableExternalIdMeta("medication.create", [shape]),
      });
    }
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

  const {
    name,
    dose,
    category,
    treatmentClass,
    dosesPerUnit,
    unitsPerDose,
    reorderLeadDays,
    deliveryForm,
    trackInjectionSites,
    allowedInjectionSites,
    notificationsEnabled,
    liveActivityEnabled,
    criticalAlarmEnabled,
    atcCode,
    rxNormCode,
    externalSource,
    externalId,
    schedules,
    startsOn,
    endsOn,
    oneShot,
    asNeeded,
  } = parsed.data;

  // v1.28 — idempotent mirror create. A mirrored medication (Apple
  // Health) is keyed by the `(userId, externalSource, externalId)`
  // unique; a re-post of the same concept id (iOS re-sync, retry after a
  // dropped response) returns the EXISTING medication with 200 instead
  // of minting a duplicate or 500-ing on P2002. The pre-query covers the
  // common replay; the P2002 catch around the create below covers the
  // concurrent race.
  if (externalSource !== undefined && externalId !== undefined) {
    const existing = await prisma.medication.findFirst({
      where: { userId: user.id, externalSource, externalId },
      include: { schedules: true },
    });
    if (existing) {
      return respondWithExistingMirror(existing);
    }

    // v1.32.25 — growth guard. This point is only reached when the
    // idempotency lookup MISSED, i.e. this is a genuinely NEW mirror row,
    // not a replay of one the user already holds (a replay returned 200
    // above). An idempotent re-post of an existing mirror is therefore
    // never blocked, even for a user already at the cap. Refuse only the
    // minting of a fresh row once the user already holds the cap of
    // Apple-Health-mirrored medications, so a client feeding a rotating
    // key can no longer fill the list with duplicates. The count runs on
    // the mirror-create-miss path only; native creates (no
    // `externalSource`) never reach this branch and pay nothing.
    const mirroredCount = await prisma.medication.count({
      where: { userId: user.id, externalSource: "APPLE_HEALTH" },
    });
    if (mirroredCount >= APPLE_HEALTH_MIRROR_CAP) {
      annotate({
        action: { name: "medication.mirror.limit_exceeded" },
        meta: { existing: mirroredCount },
      });
      return apiError(
        "This account already mirrors the maximum number of medications from an external source",
        422,
        { errorCode: "medications.mirror.limit_exceeded" },
      );
    }
  }

  // ── v1.5 route invariants for the new scheduling primitives ───────
  //
  // The Zod layer already enforces `rrule` xor `rollingIntervalDays`
  // (scheduleSchema.refine). The route layer enforces the cross-field
  // invariants that span medication + schedules:
  //
  //   1. **One-shot consistency** — when `oneShot === true`:
  //      a. The medication has at most ONE schedule.
  //      b. The single schedule carries neither `rrule` nor
  //         `rollingIntervalDays` (a one-shot dose IS the schedule).
  //      c. `endsOn` is normalised to equal `startsOn` on write so the
  //         worker's date-range cap matches the one-and-only slot.
  //
  //   2. **Recurring default** — when `oneShot !== true` AND the
  //      schedule has no `rrule`, no `rollingIntervalDays`, and no
  //      legacy `daysOfWeek`, the route stamps `rrule = "FREQ=DAILY"`
  //      so the canonical recurrence engine has a clean shape going
  //      forward instead of falling through to the legacy parser.
  //
  //   3. **iOS contract dual-write** — when `timesOfDay` is absent or
  //      empty, the route stamps `[windowStart]` so the new engine
  //      always sees a populated `timesOfDay` while legacy iOS clients
  //      (v0.6.x) keep encoding the `windowStart` / `windowEnd` /
  //      `daysOfWeek` shape. Both shapes coexist through v1.5.x.
  //   4. **As-needed (v1.16.11, #316)** — when `asNeeded === true` the
  //      medication carries ZERO schedules (the Zod refine already
  //      rejects a populated array, mutual exclusion with `oneShot`
  //      included). Every "never due / never reminded / never scored"
  //      surface follows structurally from the empty schedule list.
  const scheduleInputs = schedules ?? [];
  if (oneShot === true) {
    if (scheduleInputs.length > 1) {
      return apiError(
        "A one-shot medication can have at most one schedule",
        422,
      );
    }
    const s = scheduleInputs[0];
    if (s && (s.rrule !== undefined || s.rollingIntervalDays !== undefined)) {
      return apiError(
        "A one-shot medication cannot have a recurrence (rrule or rollingIntervalDays)",
        422,
      );
    }
  }

  // Normalise endsOn for one-shot. Zod gives us `Date | null | undefined`.
  const normalisedEndsOn =
    oneShot === true && startsOn ? startsOn : (endsOn ?? undefined);

  const createMedication = () =>
    prisma.medication.create({
      data: {
        userId: user.id,
        name,
        dose,
        // v1.4.25 W4d — treatmentClass + dosesPerUnit are optional in the
        // wire schema; Prisma fills the default GENERIC when omitted.
        ...(treatmentClass !== undefined && { treatmentClass }),
        ...(dosesPerUnit !== undefined && { dosesPerUnit }),
        // v1.16.10 — units consumed per dose; Prisma defaults to 1 when omitted.
        ...(unitsPerDose !== undefined && { unitsPerDose }),
        // v1.17.0 — optional reorder lead override; null/omitted = inherit
        // the user-level default in the low-stock alert.
        ...(reorderLeadDays !== undefined && { reorderLeadDays }),
        // v1.6.0 — route of administration; Prisma defaults to ORAL when omitted.
        ...(deliveryForm !== undefined && { deliveryForm }),
        // v1.8.5 — injection-site tracking opt-in + per-medication allowed
        // sites; Prisma defaults to false / [] when omitted.
        ...(trackInjectionSites !== undefined && { trackInjectionSites }),
        ...(allowedInjectionSites !== undefined && { allowedInjectionSites }),
        // v1.7.0 — iOS reminder flags; Prisma defaults both to false.
        ...(liveActivityEnabled !== undefined && { liveActivityEnabled }),
        ...(criticalAlarmEnabled !== undefined && { criticalAlarmEnabled }),
        // v1.9.0 — optional drug-classification codes (ATC / RxNorm).
        // Validated for format by Zod; stored verbatim when present.
        ...(atcCode !== undefined && { atcCode }),
        ...(rxNormCode !== undefined && { rxNormCode }),
        // v1.28 — mirrored-medication provenance (Apple Health). Zod
        // enforces the both-or-neither pairing; field-by-field like every
        // other column.
        ...(externalSource !== undefined && { externalSource }),
        ...(externalId !== undefined && { externalId }),
        // v1.5 — wizard's reminders toggle now ships through the create
        // payload (was orphaned in the initial diff). Prisma defaults to
        // true when omitted, matching the legacy form's behaviour.
        ...(notificationsEnabled !== undefined && { notificationsEnabled }),
        // v1.5 scheduling primitives — pass-through when supplied.
        ...(startsOn !== undefined && { startsOn }),
        ...(normalisedEndsOn !== undefined && { endsOn: normalisedEndsOn }),
        ...(oneShot !== undefined && { oneShot }),
        // v1.16.11 — as-needed flag, field-by-field. An asNeeded create
        // carries an empty `scheduleInputs`, so the nested create below
        // persists zero schedule rows.
        ...(asNeeded !== undefined && { asNeeded }),
        schedules: {
          create: scheduleInputs.map((s) => {
            // Invariant 2 — default to FREQ=DAILY when nothing else is set.
            // v1.7.0 — PRN schedules carry no cadence, so never default
            // them to FREQ=DAILY (they would otherwise project + remind).
            const hasLegacyDays = (s.daysOfWeek?.length ?? 0) > 0;
            const isPrn = s.scheduleType === "PRN";
            const defaultedRrule =
              !oneShot &&
              !isPrn &&
              s.rrule === undefined &&
              s.rollingIntervalDays === undefined &&
              !hasLegacyDays
                ? "FREQ=DAILY"
                : s.rrule;

            // Invariant 3 — dual-write `timesOfDay` from windowStart when
            // the legacy-shape iOS client doesn't send the new field.
            const effectiveTimesOfDay =
              s.timesOfDay && s.timesOfDay.length > 0
                ? s.timesOfDay
                : [s.windowStart];

            return {
              windowStart: s.windowStart,
              windowEnd: s.windowEnd,
              label: s.label ?? null,
              dose: s.dose ?? null,
              // #219 — per-schedule inventory units. Field-by-field (no mass
              // assignment); absent leaves the column NULL so the consume
              // hook inherits the medication-level units_per_dose.
              ...(s.unitsPerDose !== undefined && {
                unitsPerDose: s.unitsPerDose,
              }),
              daysOfWeek: serializeScheduleRecurrence({
                daysOfWeek: s.daysOfWeek ?? [],
                intervalWeeks: s.intervalWeeks ?? 1,
              }),
              // v1.5 first-class times-of-day.
              timesOfDay: effectiveTimesOfDay,
              ...(s.reminderGraceMinutes !== undefined && {
                reminderGraceMinutes: s.reminderGraceMinutes,
              }),
              ...(defaultedRrule !== undefined && { rrule: defaultedRrule }),
              ...(s.rollingIntervalDays !== undefined && {
                rollingIntervalDays: s.rollingIntervalDays,
              }),
              // v1.7.0 — schedule type + cyclic weeks, field-by-field.
              ...(s.scheduleType !== undefined && {
                scheduleType: s.scheduleType,
              }),
              ...(s.cyclicOnWeeks !== undefined && {
                cyclicOnWeeks: s.cyclicOnWeeks,
              }),
              ...(s.cyclicOffWeeks !== undefined && {
                cyclicOffWeeks: s.cyclicOffWeeks,
              }),
              // v1.15.18 — per-dose configurable on-time windows. Stored as the
              // validated `{ timeOfDay, start, end }[]` JSON; absent leaves the
              // column NULL (every slot on the default ±1h derivation).
              ...(s.doseWindows !== undefined && {
                doseWindows: s.doseWindows,
              }),
            };
          }),
        },
      },
      include: { schedules: true },
    });

  let medication: Awaited<ReturnType<typeof createMedication>>;
  try {
    medication = await createMedication();
  } catch (err: unknown) {
    // v1.28 — P2002 on the mirror triple: a concurrent create of the
    // same `(userId, externalSource, externalId)` won the race between
    // the pre-query above and this insert. Resolve to the winning row
    // and answer idempotently instead of 500-ing. Any other unique
    // violation (there is none on this table today) rethrows.
    const isP2002 =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2002";
    if (isP2002 && externalSource !== undefined && externalId !== undefined) {
      const winner = await prisma.medication.findFirst({
        where: { userId: user.id, externalSource, externalId },
        include: { schedules: true },
      });
      if (winner) return respondWithExistingMirror(winner);
    }
    throw err;
  }

  const normalizedCategory = await setMedicationCategory(
    medication.id,
    category,
  );

  await auditLog("medication.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { medicationId: medication.id, name },
  });

  annotate({
    action: {
      name: "medication.create",
      entity_type: "medication",
      entity_id: medication.id,
    },
  });

  // v1.4.34 IW-G — bust per-user medications + compliance + achievement
  // caches so the next read reflects the new schedule.
  invalidateUserMedications(user.id, { evict: true });

  return apiSuccess(
    {
      ...medication,
      unitsPerDose: Number(medication.unitsPerDose),
      // #219 — Decimal → number for the per-schedule column too.
      schedules: serializeScheduleUnitsPerDose(
        medication.schedules,
        medication.unitsPerDose,
      ),
      category: normalizedCategory,
    },
    201,
  );
}
