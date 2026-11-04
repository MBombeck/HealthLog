/**
 * One lab marker's line outside the timeline (#1342).
 *
 * `GET /api/biomarkers/{id}/series` answers what `labSeries` on
 * `/api/timeline` answers for that one marker, under the labs module rather
 * than the opt-in timeline. Nothing is re-implemented here: the window is
 * the timeline's own (`resolveTimelineWindow`), the line is `loadLabSeries`,
 * so the points, the unit handling, the band and the `excluded` count are
 * the timeline's to the byte. The only difference is where `all` starts:
 * at the marker's first numeric reading, since this line shows nothing else.
 */
import type { TimelineLabSeries, TimelineZoom } from "@/lib/day/contract";
import { prisma } from "@/lib/db";
import type { TimelineAccess } from "@/lib/timeline/lanes";
import { loadLabSeries } from "@/lib/timeline/lab-series";
import { resolveTimelineWindow } from "@/lib/timeline/load-timeline";
import { userDayKey } from "@/lib/tz/format";

export interface BiomarkerSeries {
  zoom: TimelineZoom;
  range: { from: string; to: string; dataFrom: string | null };
  series: TimelineLabSeries;
}

/**
 * The line of `biomarkerId` in the record, or null when the record has no
 * such marker (or the caller may not see labs).
 */
export async function loadBiomarkerSeries(args: {
  recordId: string;
  biomarkerId: string;
  query: { zoom: TimelineZoom; from?: string; to?: string };
  access: TimelineAccess;
  tz: string;
  now?: Date;
}): Promise<BiomarkerSeries | null> {
  const { recordId, biomarkerId, query, access, tz } = args;
  const first = await prisma.labResult.findFirst({
    where: {
      userId: recordId,
      biomarkerId,
      deletedAt: null,
      value: { not: null },
    },
    orderBy: { takenAt: "asc" },
    select: { takenAt: true },
  });
  const dataFrom = first ? userDayKey(first.takenAt, tz) : null;
  const today = userDayKey(args.now ?? new Date(), tz);
  const { from, to } = resolveTimelineWindow(query, today, dataFrom);
  const [series] = await loadLabSeries({
    recordId,
    ids: [biomarkerId],
    from,
    to,
    tz,
    access,
  });
  if (!series) return null;
  return { zoom: query.zoom, range: { from, to, dataFrom }, series };
}
