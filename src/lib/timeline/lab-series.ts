/**
 * Lab markers as lines on the timeline (#1299).
 *
 * A measurement line is a mean per bucket; a lab marker is a handful of
 * readings a year, and a mean of them would invent a value nobody measured.
 * So a lab line is its readings, one point each, on the day of the draw. The
 * day is the record's local day of `takenAt`, the same cut the labs lane and
 * the day view make, so a point opens the day that lists it.
 *
 * Only markers linked to a `Biomarker` are offered: every write links one,
 * the backfill links the rest, and the labs list itself shows an unlinked
 * group as not yet linked. A marker is read through `resolveLabFields`, the
 * resolver every lab surface shares, so its name, unit, panel and the window
 * each reading is judged against are the labs page's own.
 *
 * Units. A reading stored since v1.40 is in its marker's unit by
 * construction. Older ones were linked by the backfill under the unit of the
 * group's newest reading, and a marker's unit can be edited after its
 * readings were written, so a row's own `unit` can still differ from the
 * marker's. Such a row is converted through the unit-conversion registry
 * when the pair is known (its printed window with it) and otherwise left out
 * and counted in `excluded`: it is never drawn on a scale it is not in.
 */
import {
  classifyAgainstEffectiveRange,
  resolveEffectiveReferenceRange,
} from "@/lib/labs/reference-range";
import { resolveLabFields, type LabFieldRow } from "@/lib/labs/serialise";
import { sameLabUnit } from "@/lib/labs/unit-normalise";
import {
  convertLabRange,
  convertLabValue,
} from "@/lib/labs/unit-conversion/convert";
import {
  timelineLabKey,
  type TimelineLabMarker,
  type TimelineLabPoint,
  type TimelineLabSeries,
} from "@/lib/day/contract";
import { prisma } from "@/lib/db";
import { listTargetsBySource } from "@/lib/links/link-service";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

import { laneVisible, type TimelineAccess } from "./lanes";

/** The marker columns a lab line needs. */
export interface LabLineMarker {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  analyteKey: string | null;
}

/** One numeric reading of a marker, with the report it came from. */
export interface LabLineRow extends LabFieldRow {
  id: string;
  value: number;
  sourceValue: number | null;
  takenAt: Date;
  report: { id: string; title: string | null } | null;
}

/** A reading in the marker's unit, or null when its unit does not convert. */
function inMarkerUnit(
  row: LabLineRow,
  marker: LabLineMarker,
): Omit<TimelineLabPoint, "id" | "date" | "report"> | null {
  if (sameLabUnit(row.unit, marker.unit)) {
    const fields = resolveLabFields(row, marker);
    return {
      value: row.value,
      sourceValue: row.sourceValue,
      rangeStatus: classifyAgainstEffectiveRange(
        row.value,
        fields.effectiveRange,
      ),
      referenceLow: fields.referenceLow,
      referenceHigh: fields.referenceHigh,
    };
  }
  const converted = convertLabValue({
    analyteKey: marker.analyteKey,
    value: row.value,
    from: row.unit,
    to: marker.unit,
  });
  if (!converted.ok) return null;
  // The printed window is in the row's unit; it moves with the value or is
  // dropped (the marker's own band then judges the reading).
  const printed = convertLabRange({
    analyteKey: marker.analyteKey,
    low: row.sourceReferenceLow,
    high: row.sourceReferenceHigh,
    from: row.unit,
    to: marker.unit,
  });
  const effective = resolveEffectiveReferenceRange(
    marker.lowerBound,
    marker.upperBound,
    {
      sourceReferenceLow: printed.ok ? printed.low : null,
      sourceReferenceHigh: printed.ok ? printed.high : null,
      sourceReferenceText: null,
      sourceUnit: row.unit,
    },
  );
  return {
    value: converted.value,
    // The figure as stored sets the precision the converted one is shown with.
    sourceValue: row.value,
    rangeStatus: classifyAgainstEffectiveRange(converted.value, effective),
    referenceLow: effective.low,
    referenceHigh: effective.high,
  };
}

/**
 * One marker's line over `[from, to]` from its numeric readings (any order):
 * a point per reading inside the window, oldest first, the readings whose
 * unit does not convert counted, and the band to draw behind them.
 */
export function shapeLabSeries(
  marker: LabLineMarker,
  rows: readonly LabLineRow[],
  window: { from: string; to: string; tz: string },
): TimelineLabSeries {
  const drawn: Array<{ point: TimelineLabPoint; at: number }> = [];
  let excluded = 0;
  for (const row of rows) {
    const date = userDayKey(row.takenAt, window.tz);
    if (date < window.from || date > window.to) continue;
    const reading = inMarkerUnit(row, marker);
    if (!reading) {
      excluded += 1;
      continue;
    }
    drawn.push({
      point: {
        id: row.id,
        date,
        ...reading,
        report: row.report
          ? {
              id: row.report.id,
              title: row.report.title,
              href: `/documents?doc=${row.report.id}`,
            }
          : null,
      },
      at: row.takenAt.getTime(),
    });
  }
  const points = drawn
    .sort((a, b) => a.at - b.at || (a.point.id < b.point.id ? -1 : 1))
    .map((d) => d.point);
  const newest = points.at(-1);
  const band =
    marker.lowerBound !== null || marker.upperBound !== null
      ? { low: marker.lowerBound, high: marker.upperBound }
      : newest &&
          (newest.referenceLow !== null || newest.referenceHigh !== null)
        ? { low: newest.referenceLow, high: newest.referenceHigh }
        : null;
  return {
    key: timelineLabKey(marker.id),
    biomarkerId: marker.id,
    name: marker.name,
    panel: marker.panel,
    unit: marker.unit,
    band,
    points,
    excluded,
  };
}

const MARKER_SELECT = {
  id: true,
  name: true,
  unit: true,
  lowerBound: true,
  upperBound: true,
  panel: true,
  analyteKey: true,
} as const;

/**
 * The lines of the markers `ids` names, in that order, over `[from, to]`.
 * Every read is narrowed to the record: an id of another record's marker
 * finds nothing and is left out, as is a marker deleted since it was chosen.
 * The report behind a reading is read only when the caller may see
 * documents.
 */
export async function loadLabSeries(args: {
  recordId: string;
  ids: readonly string[];
  from: string;
  to: string;
  tz: string;
  access: TimelineAccess;
}): Promise<TimelineLabSeries[]> {
  const { recordId, ids, from, to, tz, access } = args;
  if (ids.length === 0 || !laneVisible("labs", access)) return [];
  const markers = await prisma.biomarker.findMany({
    where: { userId: recordId, id: { in: [...ids] } },
    select: MARKER_SELECT,
  });
  if (markers.length === 0) return [];
  const rows = await prisma.labResult.findMany({
    where: {
      userId: recordId,
      biomarkerId: { in: markers.map((m) => m.id) },
      deletedAt: null,
      value: { not: null },
      takenAt: {
        gte: startOfLocalDayKey(from, tz),
        lt: startOfLocalDayKey(shiftDateKey(to, 1), tz),
      },
    },
    select: {
      id: true,
      biomarkerId: true,
      analyte: true,
      panel: true,
      value: true,
      unit: true,
      sourceValue: true,
      sourceUnit: true,
      referenceLow: true,
      referenceHigh: true,
      sourceReferenceLow: true,
      sourceReferenceHigh: true,
      sourceReferenceText: true,
      takenAt: true,
    },
    orderBy: [{ takenAt: "asc" }, { id: "asc" }],
  });
  // A reading read from two documents names the first one linked. The link
  // service drops a deleted document and narrows every read to the record.
  const reportOf = new Map<string, { id: string; title: string | null }>();
  if (rows.length > 0 && laneVisible("documents", access)) {
    const linked = await listTargetsBySource(prisma, {
      userId: recordId,
      sourceKind: "labResult",
      sourceIds: rows.map((r) => r.id),
      targetKind: "document",
    });
    for (const [labResultId, [first]] of linked) {
      if (!first) continue;
      // A document with neither title nor file name is labelled by its id.
      reportOf.set(labResultId, {
        id: first.id,
        title: first.label === first.id ? null : first.label,
      });
    }
  }
  const byMarker = new Map<string, LabLineRow[]>();
  for (const row of rows) {
    if (row.biomarkerId === null || row.value === null) continue;
    const list = byMarker.get(row.biomarkerId) ?? [];
    list.push({
      ...row,
      value: row.value,
      report: reportOf.get(row.id) ?? null,
    });
    byMarker.set(row.biomarkerId, list);
  }
  const found = new Map(markers.map((m) => [m.id, m]));
  return ids.flatMap((id) => {
    const marker = found.get(id);
    return marker
      ? [shapeLabSeries(marker, byMarker.get(id) ?? [], { from, to, tz })]
      : [];
  });
}

/**
 * Every marker the record has a numeric reading for, whatever the window,
 * by name. A marker with only qualitative readings ("negative") has nothing
 * to draw and is not offered.
 */
export async function loadAvailableLabMarkers(args: {
  recordId: string;
  access: TimelineAccess;
}): Promise<TimelineLabMarker[]> {
  const { recordId, access } = args;
  if (!laneVisible("labs", access)) return [];
  const groups = await prisma.labResult.groupBy({
    by: ["biomarkerId"],
    where: {
      userId: recordId,
      deletedAt: null,
      value: { not: null },
      biomarkerId: { not: null },
    },
  });
  const ids = groups
    .map((g) => g.biomarkerId)
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return [];
  const markers = await prisma.biomarker.findMany({
    where: { userId: recordId, id: { in: ids } },
    select: { id: true, name: true, panel: true, unit: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return markers.map((m) => ({
    key: timelineLabKey(m.id),
    biomarkerId: m.id,
    name: m.name,
    panel: m.panel,
    unit: m.unit,
  }));
}
