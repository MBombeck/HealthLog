/**
 * The full compliance computation for one medication, shared by
 * `GET /api/medications/[id]/compliance` (detail page, full payload incl.
 * the 90-day heatmap) and `GET /api/medications/compliance` (the batched
 * card read). Lifted out of the per-id route so the server cache can wrap
 * one canonical builder from both entry points: ONE bounded intake-event
 * read (only the columns the math consumes, floored at the 366-day fetch
 * window) feeds ONE shared band-expansion pass
 * (`buildMedicationComplianceBundle`) that serves the 7-/30-day blocks,
 * the cadence-scaled display rows AND the 90-day heatmap.
 */
import { prisma } from "@/lib/db";
import {
  buildComplianceMedicationContext,
  buildMedicationComplianceBundle,
  expectsDoses,
  lastNonSkippedTakenAt,
  type ComplianceDisplay,
  type ComplianceResult,
  type DailyComplianceEntry,
} from "@/lib/analytics/compliance";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import { userDayKey } from "@/lib/tz/format";
import { isRecordOnly } from "@/lib/medications/intake-tracking";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lower bound for the intake-event read. The widest window any served
 * block needs is the 365-day display rung; one extra day absorbs the
 * inclusive-boundary edge so the ledger's own 365-day clamp never sits
 * on a half-fetched day.
 */
const EVENT_FETCH_WINDOW_DAYS = 366;

/** The cached response body (the exact public wire shape). */
export interface CompliancePayload {
  /**
   * False only when adherence is not meaningful for this medication.
   * Today that means a scheduled (non-PRN) medication with no local schedule,
   * such as an Apple Health mirror whose cadence remains source-owned, and
   * (v1.39.1, #1033) a medication whose intake tracking is switched off.
   */
  applicable: boolean;
  notApplicableReason: "NO_LOCAL_SCHEDULE" | "INTAKE_NOT_TRACKED" | null;
  compliance7: ComplianceResult;
  compliance30: ComplianceResult;
  dailyCompliance: Record<string, DailyComplianceEntry>;
  complianceDisplay: ComplianceDisplay | null;
}

/**
 * Legacy-compatible placeholder for a medication whose adherence percentage
 * is explicitly not applicable.
 *
 * Released iOS 1.0.3 requires `compliance7` and `compliance30` to decode as
 * non-null `ComplianceWindowResult` objects. Keep those fields structurally
 * present while `applicable=false` remains the authoritative semantic signal
 * for clients that understand the newer contract. All-zero values avoid
 * reviving the old vacuous 100% result.
 */
const NOT_APPLICABLE_LEGACY_COMPLIANCE: ComplianceResult = {
  totalExpected: 0,
  taken: 0,
  skipped: 0,
  missed: 0,
  rate: 0,
  streak: 0,
};

/** The medication slice the payload builder consumes. */
export interface ComplianceMedicationInput {
  id: string;
  createdAt: Date;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  asNeeded: boolean;
  /** v1.39.1 (#1033) — intake tracking off: no adherence, heatmap empty. */
  trackIntake: boolean;
  schedules: Parameters<typeof buildMedicationComplianceBundle>[1];
  /** v1.16.3 — archived schedule eras for era-aware compliance. */
  scheduleRevisions?: Parameters<
    typeof buildComplianceMedicationContext
  >[0]["scheduleRevisions"];
  /** v1.25 H-MED1 — pause eras so paused days drop out of the denominator. */
  pauseEras?: Parameters<
    typeof buildComplianceMedicationContext
  >[0]["pauseEras"];
}

/**
 * One canonical cache key per `(user, medication, timezone)` cell. The
 * key carries the timezone the payload was bucketed in: day keys, the
 * heatmap, and the overdue cut all derive from `userTz`, so a timezone
 * change must miss the old entry instead of serving day buckets computed
 * for the previous zone until the TTL lapses. The `${userId}|` prefix is
 * what `invalidateUserMedications` sweeps.
 */
export function complianceCacheKey(
  userId: string,
  medicationId: string,
  userTz: string,
): string {
  return `${userId}|${medicationId}|compliance|${userTz}`;
}

/**
 * v1.15.18 — fold one dose-history ledger row into a per-day heatmap entry.
 *
 * Slot rows contribute to `expected` / `expectedCount` (the day's due-slot
 * count): a taken slot adds to `taken` and its timing bucket; a missed slot
 * stays uncounted in `taken`; a skipped slot lands in `skipped`; an upcoming
 * slot is still due but not yet acted on. An ad-hoc row with a taken time is
 * a real off-schedule take — it counts as `taken` AND adds its own `expected`
 * slot (so the heatmap's `missed = expected − taken − skipped` math stays
 * non-negative) and reads on-time (a logged dose colours green). An ad-hoc row
 * without a taken time is an orphaned skip or auto-miss on an instant that is
 * no slot of the schedule: it records no dose, so it never counts as taken. A
 * skip still reads as skipped; an orphaned auto-miss has no slot to have
 * missed and counts nothing, as it does in the rate.
 */
function bucketLedgerRow(
  entry: DailyComplianceEntry,
  row: DoseHistoryRow,
): void {
  switch (row.status) {
    case "taken_on_time":
      entry.expected++;
      entry.expectedCount++;
      entry.taken++;
      entry.onTime++;
      break;
    case "taken_late":
      entry.expected++;
      entry.expectedCount++;
      entry.taken++;
      entry.late++;
      break;
    case "missed":
      entry.expected++;
      entry.expectedCount++;
      break;
    case "skipped":
      entry.expected++;
      entry.expectedCount++;
      entry.skipped++;
      break;
    case "upcoming":
      // A future / still-takeable slot is due but not yet acted on. It counts
      // toward the day's expected/due grid but not toward taken or missed.
      entry.expected++;
      entry.expectedCount++;
      break;
    case "ad_hoc":
      if (row.intake?.takenAt) {
        // An off-schedule take: a real taken dose with no scheduled slot.
        // Count it as taken + its own expected slot so the heatmap missed
        // math holds.
        entry.expected++;
        entry.expectedCount++;
        entry.taken++;
        entry.onTime++;
      } else if (row.intake?.skipped) {
        entry.expected++;
        entry.expectedCount++;
        entry.skipped++;
      }
      break;
  }
}

export async function buildCompliancePayload(
  medication: ComplianceMedicationInput,
  userId: string,
  userTz: string,
): Promise<CompliancePayload> {
  // A scheduled medication with ZERO local schedules has no local expected
  // dose grid. This is a real shape for Apple Health mirrors: the source owns
  // the cadence while HealthLog stores the mirrored medication itself. The
  // legacy arithmetic intentionally answers 100 % when there are zero
  // expected doses, which is mathematically consistent but misleading when
  // rendered as adherence. Mark this shape explicitly not-applicable BEFORE
  // reading intake history or invoking the arithmetic.
  //
  // v1.39.1 (#1033) — a medication with intake tracking off keeps its
  // schedule as a record and expects nothing from it. Same not-applicable
  // shape, its own reason, so an aware client can say why.
  if (isRecordOnly(medication)) {
    return {
      applicable: false,
      notApplicableReason: "INTAKE_NOT_TRACKED",
      compliance7: NOT_APPLICABLE_LEGACY_COMPLIANCE,
      compliance30: NOT_APPLICABLE_LEGACY_COMPLIANCE,
      dailyCompliance: {},
      complianceDisplay: null,
    };
  }

  // Keep PRN behaviour unchanged. The batched endpoint already excludes PRN
  // medications, and a direct per-id read retains its existing payload.
  if (!medication.asNeeded && !expectsDoses(medication)) {
    return {
      applicable: false,
      notApplicableReason: "NO_LOCAL_SCHEDULE",
      compliance7: NOT_APPLICABLE_LEGACY_COMPLIANCE,
      compliance30: NOT_APPLICABLE_LEGACY_COMPLIANCE,
      dailyCompliance: {},
      complianceDisplay: null,
    };
  }

  // v1.15.9 — pin a single `now` and thread it into every cadence
  // computation so no block can straddle a day boundary on a slow request.
  const now = new Date();

  // Not clamped to the medication's creation: a dose recorded for a slot
  // before the creation still claims that slot in the ledger (#1028).
  const fetchFrom = new Date(now.getTime() - EVENT_FETCH_WINDOW_DAYS * DAY_MS);
  const events = await prisma.medicationIntakeEvent.findMany({
    // v1.7.0 sync — exclude tombstoned rows from the compliance read.
    // Bounded to the 366-day fetch window: every served block is a suffix
    // of the 365-day ledger window, so older rows can never change the
    // response.
    where: {
      medicationId: medication.id,
      userId,
      deletedAt: null,
      scheduledFor: { gte: fetchFrom },
    },
    orderBy: { scheduledFor: "desc" },
    select: {
      takenAt: true,
      skipped: true,
      scheduledFor: true,
      // v1.15.9 — a forgotten dose the auto-miss cron flipped counts as a
      // miss, not a neutral skip.
      autoMissed: true,
      // v1.15.20 — pinned takes bind by anchor in the unified ledger so the
      // % agrees with the history view on a "zugeordnet" dose (taken-late).
      attributionSource: true,
    },
  });

  // v1.7.0 SB-SCHED-2 — thread the medication context so the denominator
  // routes through the canonical engine (RRULE / rolling / one-shot / PRN /
  // cyclic). `lastIntakeAt` is the latest non-skipped takenAt inside the
  // fetch window (rolling cadences re-anchor on it).
  const lastIntakeAt = lastNonSkippedTakenAt(events);
  const medicationContext = buildComplianceMedicationContext(
    medication,
    lastIntakeAt,
    userTz,
  );

  // ONE shared expansion pass for every served block (the v1.15.20
  // performance fix): bands + ledger + timeline are minted once over the
  // widest window and each sub-window is a tally over the same rows.
  const bundle = buildMedicationComplianceBundle(
    events,
    medication.schedules,
    medicationContext,
    now,
  );

  // v1.15.18 — the heatmap / line-chart daily map is bucketed from the ONE
  // unified dose-history ledger (the same bands the % + the history view
  // read), so the per-day timing split (on-time / late) and the per-day
  // missed marks can never disagree with the headline rate. The 90-day
  // window is carved out of the shared ledger by `row.at`. The ledger
  // already drops pre-existence slots no recorded dose claims, so the floor
  // is the plain 90-day window, the same one the history view reads (#1028).
  const heatmapFrom = new Date(now.getTime() - 90 * DAY_MS);

  const dailyCompliance: Record<string, DailyComplianceEntry> = {};
  const byDay = new Map<string, DailyComplianceEntry>();
  const ensureDay = (key: string): DailyComplianceEntry => {
    let entry = byDay.get(key);
    if (!entry) {
      entry = {
        expected: 0,
        expectedCount: 0,
        due: false,
        taken: 0,
        skipped: 0,
        onTime: 0,
        late: 0,
        veryLate: 0,
        early: 0,
      };
      byDay.set(key, entry);
    }
    return entry;
  };

  // Bucket each ledger row into its user-tz day. A slot row buckets on its
  // anchor; an ad-hoc row on its real take time.
  for (const row of bundle.ledgerRows) {
    if (row.at.getTime() < heatmapFrom.getTime()) continue;
    const key = userDayKey(row.at, userTz);
    const entry = ensureDay(key);
    bucketLedgerRow(entry, row);
  }

  for (const [key, entry] of byDay) {
    entry.due = entry.expectedCount > 0;
    dailyCompliance[key] = entry;
  }

  return {
    applicable: true,
    notApplicableReason: null,
    compliance7: bundle.compliance7,
    compliance30: bundle.compliance30,
    dailyCompliance,
    complianceDisplay: bundle.complianceDisplay,
  };
}
