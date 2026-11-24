/**
 * The treatment-series form's draft, and the body it becomes.
 *
 * Only the title and the start day are needed: a series saves with those and
 * nothing else. Pure, so the sheet and its tests agree on the rules.
 */
import { todayKeyIn } from "@/components/timeline/timeline-dates";
import type { Practitioner } from "@/hooks/use-practitioners";
import type {
  TreatmentSeries,
  TreatmentSeriesWriteBody,
} from "@/hooks/use-treatment-series";

export interface TreatmentSeriesDraft {
  title: string;
  kind: string;
  /** The count as typed; empty for an open-ended series. */
  plannedSessions: string;
  startsOn: string;
  validUntil: string;
  prescriber: Practitioner | null;
  performer: Practitioner | null;
  episodeId: string | null;
  /** The condition's label as the series' own read named it, for its chip. */
  conditionLabel: string | null;
  note: string;
}

/** Today on this device's calendar, `YYYY-MM-DD`. */
export function todayKey(now = new Date()): string {
  return todayKeyIn(undefined, now);
}

export function emptySeriesDraft(): TreatmentSeriesDraft {
  return {
    title: "",
    kind: "THERAPY",
    plannedSessions: "",
    startsOn: todayKey(),
    validUntil: "",
    prescriber: null,
    performer: null,
    episodeId: null,
    conditionLabel: null,
    note: "",
  };
}

export function draftFromSeries(row: TreatmentSeries): TreatmentSeriesDraft {
  return {
    title: row.title ?? "",
    kind: row.kind,
    plannedSessions:
      row.plannedSessions !== null ? String(row.plannedSessions) : "",
    startsOn: row.startsOn,
    validUntil: row.validUntil ?? "",
    prescriber: row.prescriber,
    performer: row.performer,
    episodeId: row.condition?.id ?? null,
    conditionLabel: row.condition?.label ?? null,
    note: row.note ?? "",
  };
}

/** A whole number from 1 to 500, or null for an empty field. */
function parsePlanned(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : undefined;
}

/** The body a draft becomes, or null while it cannot be saved. */
export function seriesDraftToBody(
  draft: TreatmentSeriesDraft,
): TreatmentSeriesWriteBody | null {
  const title = draft.title.trim();
  const planned = parsePlanned(draft.plannedSessions);
  if (!title || !draft.startsOn || planned === undefined) return null;
  if (draft.validUntil && draft.validUntil < draft.startsOn) return null;
  return {
    title,
    kind: draft.kind,
    plannedSessions: planned,
    startsOn: draft.startsOn,
    validUntil: draft.validUntil || null,
    prescriberId: draft.prescriber?.id ?? null,
    performerId: draft.performer?.id ?? null,
    episodeId: draft.episodeId,
    note: draft.note.trim() || null,
  };
}
