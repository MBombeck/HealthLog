/**
 * Top-level medication-intake aggregator + writer.
 *
 *   GET  /api/medications/intake?scope=today
 *     → array of today's intake events for the user (across medications).
 *
 *   GET  /api/medications/intake?scope=compliance&days=N
 *     → per-day { date, scheduled, taken } for the last N days.
 *
 *   POST /api/medications/intake
 *     Body: { intakeId, status: "taken" | "skipped" | "snoozed", takenAt?, snoozedUntil? }
 *     Updates the named MedicationIntakeEvent and returns the updated row.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { userDayKey, DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  readMedicationCompliance,
  hasMedicationComplianceCoverage,
  recomputeMedicationComplianceForEvent,
  enqueueUserMedicationComplianceBackfill,
  type ComplianceBucket as RollupComplianceBucket,
} from "@/lib/rollups/medication-compliance-rollups";
import { projectTodayIntakesAndRecompute } from "@/lib/medications/scheduling/project-today-intakes";

const querySchema = z.object({
  scope: z.enum(["today", "compliance"]),
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const updateSchema = z.object({
  intakeId: z.string().min(1),
  status: z.enum(["taken", "skipped", "snoozed"]),
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  snoozedUntil: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
});

function startOfDayInTz(date: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422 + audit breadcrumb keyed
    // `medications.intake.list.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.list.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; iOS-sent
    // query strings can flow into Zod issue messages.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "medications.intake.list.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { scope, days } = parsed.data;

  // v1.4.25 W7b — anchor "today" and per-day compliance buckets to the
  // user's display timezone so a 23:30 reading in Pacific/Auckland lands
  // in today's bucket rather than yesterday's Berlin one.
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;

  if (scope === "today") {
    const todayStart = startOfDayInTz(new Date(), userTz);
    const todayEnd = new Date(todayStart.getTime() + 86_400_000);

    // v1.4.39 W-SERVER-FIX — project pending intake rows for every
    // active schedule whose window opens today, then idempotently
    // backfill any missing rows. Pre-fix the endpoint returned `[]`
    // for daily meds (`schedule.daysOfWeek = null` in the DB) until
    // the reminder worker entered the RED phase at the end of the
    // dose window — leaving the iOS Dashboard tile + the "Erfassen"
    // sheet empty for the whole morning. Shared helper mirrors the
    // dashboard-summary call site so the two routes converge on the
    // same row set.
    const { projected, backfilled } = await projectTodayIntakesAndRecompute({
      userId: user.id,
      userTz,
      todayStart,
      todayEnd,
    });

    const events = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        // v1.7.0 sync — exclude tombstoned rows from the today list.
        deletedAt: null,
        scheduledFor: { gte: todayStart, lt: todayEnd },
      },
      orderBy: { scheduledFor: "asc" },
      include: { medication: { select: { id: true, snoozedUntil: true } } },
    });

    annotate({
      action: { name: "medications.intake.today" },
      meta: {
        count: events.length,
        projected,
        backfilled,
      },
    });

    return apiSuccess(
      events.map((e) => ({
        id: e.id,
        medicationId: e.medicationId,
        scheduledAt: e.scheduledFor.toISOString(),
        takenAt: e.takenAt?.toISOString() ?? null,
        status: e.skipped
          ? "skipped"
          : e.takenAt
            ? "taken"
            : e.medication.snoozedUntil &&
                e.medication.snoozedUntil > new Date()
              ? "snoozed"
              : "pending",
        snoozedUntil: e.medication.snoozedUntil?.toISOString() ?? null,
      })),
    );
  }

  // v1.4.34 IW-G — compliance: per-day scheduled vs taken for the last
  // N days. Cached at a 15-minute TTL because daily compliance buckets
  // are slow-moving (intake events trickle in, yesterday's row doesn't
  // move). Cache key carries the userTz so a user who changes timezone
  // doesn't read another tz's bucketing.
  //
  // v1.4.39 W-MED — read path now consumes the persistent
  // `medication_compliance_rollups` tier. A coverage probe falls back
  // to the legacy live aggregator when the user has intake events but
  // zero rollup rows; the fallback fires a boot-backfill enqueue in the
  // background so the next request hits the rollup tier.
  const result = await cached(
    caches.medicationsIntake as ServerCache<ComplianceBucket[]>,
    `${user.id}|compliance|${days}|${userTz}`,
    () => readComplianceBucketsWithFallback(user.id, days, userTz),
    annotate,
  );

  annotate({
    action: { name: "medications.intake.compliance" },
    meta: { days, count: result.length },
  });

  return apiSuccess(result);
});

/**
 * v1.4.39 W-MED — read from the persistent rollup tier when covered,
 * fall through to the legacy live aggregator on coverage miss. The
 * fallback fires the boot backfill in the background so subsequent
 * requests hit the rollup path; the current request still returns a
 * correct response built from the raw events.
 */
async function readComplianceBucketsWithFallback(
  userId: string,
  days: number,
  userTz: string,
): Promise<ComplianceBucket[]> {
  const covered = await hasMedicationComplianceCoverage(userId, days, userTz);
  if (covered) {
    const buckets = await readMedicationCompliance(userId, days, userTz);
    annotate({
      meta: {
        medication_compliance_path: "rollup",
        medication_compliance_days: days,
      },
    });
    return buckets satisfies RollupComplianceBucket[];
  }

  // Coverage miss — the legacy aggregator stays correct over an empty
  // rollup window. Fire a user-scoped backfill in the background so
  // the next request lands on the rollup tier; the current request
  // still returns the live-derived buckets.
  //
  // QA F-SEC-M-01 (v1.4.39): pre-fix this fired the cluster-wide
  // `enqueueBootTimeMedicationComplianceBackfill` on every coverage-
  // miss request, opening a soft-DoS amplifier (every authenticated
  // user could drive a multi-tenant `LEFT JOIN` scan on each hit).
  // The user-scoped helper enqueues exactly the caller's account.
  void enqueueUserMedicationComplianceBackfill(userId);
  annotate({
    meta: {
      medication_compliance_path: "live-fallback",
      medication_compliance_days: days,
    },
  });
  return buildComplianceBuckets(userId, days, userTz);
}

interface ComplianceBucket {
  date: string;
  scheduled: number;
  taken: number;
}

/**
 * v1.4.34 IW-G — pulled out of the GET handler so `cached()` can wrap
 * the per-user compliance aggregation. Pure function over the user's
 * intake events + the requested window; deterministic given a fixed
 * "now" wall-clock (we anchor on `Date.now()` once at call time so a
 * 15-minute cached row stays internally consistent).
 */
async function buildComplianceBuckets(
  userId: string,
  days: number,
  userTz: string,
): Promise<ComplianceBucket[]> {
  const nowMs = Date.now();
  const start = new Date(nowMs - days * 86_400_000);
  const events = await prisma.medicationIntakeEvent.findMany({
    // v1.7.0 sync — exclude tombstoned rows from the compliance buckets.
    where: { userId, deletedAt: null, scheduledFor: { gte: start } },
    select: { scheduledFor: true, takenAt: true, skipped: true },
  });

  const buckets = new Map<string, { scheduled: number; taken: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(nowMs - i * 86_400_000);
    buckets.set(userDayKey(d, userTz), { scheduled: 0, taken: 0 });
  }
  for (const e of events) {
    const key = userDayKey(e.scheduledFor, userTz);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.scheduled += 1;
    if (e.takenAt && !e.skipped) bucket.taken += 1;
  }

  return [...buckets.entries()]
    .map(([date, v]) => ({ date, scheduled: v.scheduled, taken: v.taken }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error } = await safeJson(request);
  if (error) return error;

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — intake-event update hot path; multi-issue 422 +
    // audit breadcrumb keyed `medications.intake.update.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.update.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "medications.intake.update.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { intakeId, status, takenAt, snoozedUntil } = parsed.data;

  // v1.7.0 sync — a tombstoned intake 404s on a status toggle; the
  // `deletedAt: null` filter refuses to mutate a soft-deleted row.
  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: { id: intakeId, deletedAt: null },
  });
  if (!existing || existing.userId !== user.id) {
    return apiError("Intake event not found", 404);
  }

  const userTzForHook = user.timezone ?? DEFAULT_TIMEZONE;

  let updated;
  if (status === "taken") {
    [updated] = await prisma.$transaction([
      prisma.medicationIntakeEvent.update({
        where: { id: intakeId },
        // v1.7.0 sync — bump the reconciliation counter on every
        // server-side mutation so the delta feed echoes a monotonic value.
        data: {
          takenAt: takenAt ?? new Date(),
          skipped: false,
          syncVersion: { increment: 1 },
        },
      }),
      prisma.medication.update({
        where: { id: existing.medicationId },
        data: { snoozedUntil: null },
      }),
    ]);
  } else if (status === "skipped") {
    updated = await prisma.medicationIntakeEvent.update({
      where: { id: intakeId },
      // v1.7.0 sync — bump the reconciliation counter on the skip toggle.
      data: { takenAt: null, skipped: true, syncVersion: { increment: 1 } },
    });
  } else {
    // snoozed: snoozedUntil lives on the Medication row.
    const until = snoozedUntil ?? new Date(Date.now() + 30 * 60_000); // default +30min
    await prisma.medication.update({
      where: { id: existing.medicationId },
      data: { snoozedUntil: until },
    });
    updated = await prisma.medicationIntakeEvent.findUnique({
      where: { id: intakeId },
    });
  }

  await auditLog("medications.intake.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { intakeId, status },
  });

  annotate({
    action: { name: "medications.intake.update" },
    meta: { intakeId, status },
  });

  // v1.4.34 IW-G — bust the medications + compliance + achievement
  // caches for this user so the next read reflects the dose change.
  invalidateUserMedications(user.id);

  // v1.4.39 W-MED — refresh the persistent compliance rollup row for
  // the affected day so the next read after the cache miss returns
  // the up-to-date `(scheduled, taken, skipped)` tuple. Best-effort:
  // a populator failure annotates ops without blocking the response.
  await recomputeMedicationComplianceForEvent({
    userId: user.id,
    medicationId: existing.medicationId,
    scheduledFor: existing.scheduledFor,
    tz: userTzForHook,
  });

  return apiSuccess(updated);
});
