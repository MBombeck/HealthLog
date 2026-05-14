/**
 * GET /api/dashboard/glp1 — v1.4.25 W6
 *
 * Powers the dashboard's `<Glp1Tile>`. Returns the user's active GLP-1
 * medications (treatmentClass = "GLP1"), each enriched with a tiny
 * weight series + the dates the user logged an injection. Returns
 * `null` data when the user has no active GLP-1 medication — the tile
 * then suppresses itself per Marc's empty-state hide rule.
 *
 * Bridge layer: the heavy lifting (current dose / last + next injection
 * / titration history / inventory math) is delegated to
 * `buildGlp1SnapshotBlock` so the Coach's GLP-1-aware reply path and
 * this dashboard tile read from the exact same shape. The extras we
 * add on top here are purely UI-facing:
 *   - weightSeries[]   — daily aggregates since the first dose change
 *                         (or 90 days back, whichever is later) for
 *                         the mini-chart on the tile
 *   - weightDeltaKg    — convenience caption value (current − start);
 *                         the tile renders "−4.2 kg seit Beginn" off
 *                         this number, with `null` when either side
 *                         is missing
 *   - injectionDates[] — `YYYY-MM-DD` keys for every recorded intake
 *                         event so the chart can paint the vertical
 *                         injection-day markers Marc wants
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { buildGlp1SnapshotBlock } from "@/lib/ai/coach/glp1-snapshot";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";

const WEIGHT_LOOKBACK_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket raw weight measurements into one daily average so the mini-
 * chart doesn't render the noisy raw stream. Same `YYYY-MM-DD` keying
 * the dashboard chart layer uses (UTC-noon anchor — DST-safe).
 */
function bucketDaily(
  rows: Array<{ measuredAt: Date; value: number }>,
): Array<{ date: string; weight: number }> {
  const sums = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    const key = isoDate(row.measuredAt);
    const slot = sums.get(key) ?? { sum: 0, count: 0 };
    slot.sum += row.value;
    slot.count += 1;
    sums.set(key, slot);
  }
  return Array.from(sums.entries())
    .map(([date, { sum, count }]) => ({
      date,
      weight: Math.round((sum / count) * 100) / 100,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const userTz = user.timezone ?? DEFAULT_TIMEZONE;
  const now = new Date();

  const snapshot = await buildGlp1SnapshotBlock(user.id, now);
  // No active GLP-1 medication → the tile suppresses itself. We still
  // return 200 + `data: null` so the client doesn't have to special-
  // case the 404 path.
  if (!snapshot) {
    annotate({
      action: { name: "dashboard.glp1" },
      meta: { active: 0 },
    });
    return apiSuccess(null);
  }

  // Anchor the weight series to the earliest meaningful date: the user
  // wants to see the trend SINCE THEY STARTED the GLP-1, not just the
  // last 90 days. We pick the earlier of:
  //   - the first dose-change `effectiveFrom` across all GLP-1 meds
  //   - 90 days back from today (so brand-new accounts still get a
  //     reasonable window when they only just logged their first dose)
  let anchor = new Date(now.getTime() - WEIGHT_LOOKBACK_DAYS * MS_PER_DAY);
  for (const med of snapshot.medications) {
    if (med.doseHistory.length === 0) continue;
    const firstDose = med.doseHistory[0].effectiveFrom;
    const firstDoseMs = Date.parse(`${firstDose}T00:00:00Z`);
    if (Number.isFinite(firstDoseMs) && firstDoseMs < anchor.getTime()) {
      anchor = new Date(firstDoseMs);
    }
  }

  const [weights, intakeRows] = await Promise.all([
    prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: "WEIGHT",
        measuredAt: { gte: anchor },
      },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true, value: true },
    }),
    prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        takenAt: { not: null, gte: anchor },
        medication: { treatmentClass: "GLP1" },
      },
      orderBy: { takenAt: "asc" },
      select: {
        medicationId: true,
        takenAt: true,
        medication: { select: { name: true } },
      },
    }),
  ]);

  const weightSeries = bucketDaily(weights);

  // Per-med injection date set — used by the chart's vertical markers.
  // Multiple injection events on the same day collapse to a single
  // marker so the chart doesn't paint stacked overlapping lines.
  const injectionDatesByMed = new Map<string, Set<string>>();
  for (const ev of intakeRows) {
    if (!ev.takenAt) continue;
    const set = injectionDatesByMed.get(ev.medicationId) ?? new Set<string>();
    set.add(isoDate(ev.takenAt));
    injectionDatesByMed.set(ev.medicationId, set);
  }

  // We also need to know the medication id per snapshot entry. The
  // snapshot exposes name + genericName but not the id; re-fetch the
  // id list ordered by `createdAt: desc` (matches the snapshot
  // ordering) and zip the two lists. Cheap re-query — already in cache
  // from the snapshot's first hit.
  const idsForOrder = await prisma.medication.findMany({
    where: { userId: user.id, treatmentClass: "GLP1", active: true },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true },
  });

  // Build the enriched per-med payload. `startWeight` = the first daily
  // bucket on/after the med's first dose-change date; `currentWeight`
  // = the most recent daily bucket. Both `null` when no weight data
  // exists in the window — the tile suppresses the delta caption then.
  const medications = snapshot.medications.map((med, idx) => {
    const medId = idsForOrder[idx]?.id ?? null;

    let startWeight: number | null = null;
    let currentWeight: number | null = null;
    let medSeries: Array<{ date: string; weight: number }> = [];

    if (weightSeries.length > 0) {
      const firstDoseDate =
        med.doseHistory.length > 0 ? med.doseHistory[0].effectiveFrom : null;
      // Filter the series to "since the user started this medication".
      // If we don't have a dose-change row (legacy data) we fall back
      // to the whole 90-day window so the chart isn't empty.
      medSeries = firstDoseDate
        ? weightSeries.filter((p) => p.date >= firstDoseDate)
        : weightSeries.slice();
      startWeight = medSeries[0]?.weight ?? null;
      currentWeight = medSeries[medSeries.length - 1]?.weight ?? null;
    }

    const weightDeltaKg =
      startWeight !== null && currentWeight !== null
        ? Math.round((currentWeight - startWeight) * 100) / 100
        : null;

    const injectionDates = medId
      ? Array.from(injectionDatesByMed.get(medId) ?? []).sort()
      : [];

    return {
      ...med,
      medicationId: medId,
      startWeight,
      currentWeight,
      weightDeltaKg,
      weightSeries: medSeries,
      injectionDates,
    };
  });

  annotate({
    action: { name: "dashboard.glp1" },
    meta: {
      active: medications.length,
      tz: userTz,
    },
  });

  return apiSuccess({
    active: snapshot.active,
    medications,
  });
});
