/**
 * v1.25 — "what changed since your last panel" read.
 *
 *   GET /api/insights/labs-changes
 *
 * Groups the user's live numeric lab results by panel date, pairs the two
 * most-recent panels, and reports the per-analyte delta + reference-band
 * standing (`summariseLabChanges`). Absent when there are fewer than two
 * panels, no analyte is shared, or the newest panel is older than the
 * recency window — the card's "since your last panel" wording is a claim
 * about recent news, and it stops being made rather than being made about a
 * years-old draw. Neutral framing only — a delta is not a diagnosis.
 *
 * Mirrors `/api/insights/derived`: `apiHandler`, `requireAuth`, the `labs`
 * module gate, the shared analytics-read budget. `userId` is narrowed from the
 * session; soft-deleted rows (`deletedAt`) are filtered out.
 */
import { apiError, apiSuccess } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { summariseLabChanges } from "@/lib/insights/labs-changes";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");

  // Lab deltas belong to labs: with the labs module off the card hides like
  // every other labs surface. Not an AI read, so the `insights` module (the
  // AI analysis opt-out) does not gate it.
  const m = await requireModuleEnabled(user.id, "labs");
  if (!m.enabled) return m.response;

  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  const rows = await prisma.labResult.findMany({
    where: { userId: user.id, deletedAt: null, value: { not: null } },
    select: {
      analyte: true,
      biomarkerId: true,
      unit: true,
      value: true,
      sourceValue: true,
      referenceLow: true,
      referenceHigh: true,
      sourceReferenceLow: true,
      sourceReferenceHigh: true,
      sourceReferenceText: true,
      sourceUnit: true,
      takenAt: true,
    },
    orderBy: { takenAt: "desc" },
  });

  const summary = summariseLabChanges(
    rows.map((r) => ({
      analyte: r.analyte,
      biomarkerId: r.biomarkerId,
      unit: r.unit,
      value: r.value as number,
      sourceValue: r.sourceValue,
      referenceLow: r.referenceLow,
      referenceHigh: r.referenceHigh,
      sourceReferenceLow: r.sourceReferenceLow,
      sourceReferenceHigh: r.sourceReferenceHigh,
      sourceReferenceText: r.sourceReferenceText,
      sourceUnit: r.sourceUnit,
      takenAt: r.takenAt,
    })),
  );

  annotate({
    action: { name: "insights.labs-changes.read" },
    meta: {
      present: summary.present,
      changes: summary.changes.length,
      // Distinguishes "no comparable panels" from "the comparison aged out",
      // so an absent card is diagnosable without reaching for the database.
      lab_rows: rows.length,
    },
  });

  return apiSuccess({ ...summary, generatedAt: new Date().toISOString() });
});
