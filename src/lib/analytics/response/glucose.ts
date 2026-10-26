/**
 * The glucose blocks of the default analytics body: the per-context
 * summaries and the clinical panel over the same trailing window.
 */
import { prisma } from "@/lib/db";
import { summarize, wireSummary, type DataPoint } from "@/lib/analytics/trends";
import {
  computeGlucoseClinicalMetrics,
  GLUCOSE_PANEL_WINDOW_DAYS,
  type GlucoseClinicalMetrics,
} from "@/lib/analytics/glucose-metrics";
import { groupByGlucoseContext } from "@/lib/glucose";

export async function readGlucoseBlocks(userId: string) {
  // Per-context glucose summaries (canonical mg/dL).
  //
  // Bound to the trailing 30 days. The dashboard tile
  // path only reads the trailing window; pre-bound this query
  // walked every persisted BG row a multi-year user has written.
  const glucoseSince = new Date(
    Date.now() - GLUCOSE_PANEL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const glucoseRows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "BLOOD_GLUCOSE",
      measuredAt: { gte: glucoseSince },
      deletedAt: null,
    },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true, glucoseContext: true },
  });
  // #943 — grouped through the shared bucket resolver, so readings with no
  // meal-time tag land in `UNSPECIFIED` instead of being dropped on the floor.
  const glucoseByContext: Record<string, ReturnType<typeof summarize>> = {};
  for (const [bucket, ctxRows] of groupByGlucoseContext(
    glucoseRows,
    (r) => r.glucoseContext,
  )) {
    glucoseByContext[bucket] = wireSummary(
      summarize(
        ctxRows.map((r): DataPoint => ({ date: r.measuredAt, value: r.value })),
      ),
    );
  }

  // Server-authoritative glucose clinical panel. The TIR / GMI /
  // eA1C / CV% headline and the advanced J-index + LBGI/HBGI tier are computed
  // ONCE here over the declared 30-day window (matching `glucoseSince`) so the
  // insights panel, the coach snapshot, and the doctor report all render the
  // same numbers instead of each re-deriving. The learning gate keeps a thin
  // spot-data window from being asserted as a clinical AGP. Always present in
  // the payload (even with zero readings) so the client renders the calm
  // "still learning" state from a populated object rather than a missing key.
  const glucoseClinical: GlucoseClinicalMetrics = computeGlucoseClinicalMetrics(
    glucoseRows.map((r) => ({ measuredAt: r.measuredAt, mgdl: r.value })),
    { windowDays: GLUCOSE_PANEL_WINDOW_DAYS, now: new Date() },
  );
  return { glucoseByContext, glucoseClinical };
}
