/**
 * Treatment series row → wire DTO, and the series reference a visit carries.
 *
 * Published resolved: the two practitioners as objects, the condition with its
 * label (or redacted), and every count, date and the status computed from the
 * sessions (`./derive.ts`). A client that re-derived any of them would drift
 * from the server the first time the rule changed on one side only.
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import type {
  EncounterKind,
  Practitioner,
  TreatmentSeries,
} from "@/generated/prisma/client";
import type { EncounterDTO, EncounterLinkDTO } from "@/lib/encounters/dto";
import { getEvent } from "@/lib/logging/context";
import {
  toPractitionerDTO,
  type PractitionerDTO,
} from "@/lib/practitioners/dto";
import { dateOnlyKey } from "@/lib/tz/date-only";

import {
  deriveSeriesStatus,
  summarizeSessions,
  type SeriesSessionFact,
  type TreatmentSeriesStatus,
} from "./derive";

export interface TreatmentSeriesSessionsDTO {
  done: number;
  booked: number;
  cancelled: number;
  /** Planned minus done, never below zero; null for an open-ended series. */
  remaining: number | null;
}

export interface TreatmentSeriesDTO {
  id: string;
  title: string | null;
  kind: EncounterKind;
  plannedSessions: number | null;
  /** `YYYY-MM-DD`. */
  startsOn: string;
  validUntil: string | null;
  endedOn: string | null;
  status: TreatmentSeriesStatus;
  sessions: TreatmentSeriesSessionsDTO;
  firstSessionAt: string | null;
  lastSessionAt: string | null;
  nextSessionAt: string | null;
  prescriber: PractitionerDTO | null;
  performer: PractitionerDTO | null;
  /** The condition, redacted when the caller's grant does not cover illness. */
  condition: EncounterLinkDTO | null;
  note: string | null;
  /** The detail read only: every live session, oldest first. */
  visits?: EncounterDTO[];
  createdAt: string;
  updatedAt: string;
}

/** The series a visit is one session of, as the visit carries it. */
export interface EncounterSeriesRefDTO {
  id: string;
  title: string | null;
  /** Its place in the series; null when cancelled or missed. */
  sessionNumber: number | null;
  plannedSessions: number | null;
}

export function decryptSeriesText(
  value: Uint8Array | null,
  field: "title" | "note",
): string | null {
  if (!value || value.byteLength === 0) return null;
  try {
    return decryptFromBytes(value);
  } catch (err) {
    getEvent()?.addWarning(
      `treatment series ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export type TreatmentSeriesWithRelations = TreatmentSeries & {
  prescriber: Practitioner | null;
  performer: Practitioner | null;
  episode: {
    id: string;
    label: string;
    onsetAt: Date;
    deletedAt: Date | null;
  } | null;
};

export function toTreatmentSeriesDTO(
  row: TreatmentSeriesWithRelations,
  sessions: readonly SeriesSessionFact[],
  context: {
    now: Date;
    /** The owner's calendar day. */
    today: string;
    illnessVisible: boolean;
  },
): TreatmentSeriesDTO {
  const summary = summarizeSessions(sessions, context.now);
  const validUntil = row.validUntil ? dateOnlyKey(row.validUntil) : null;
  const endedOn = row.endedOn ? dateOnlyKey(row.endedOn) : null;
  const episode =
    row.episode && row.episode.deletedAt === null ? row.episode : null;
  return {
    id: row.id,
    title: decryptSeriesText(row.titleEncrypted, "title"),
    kind: row.kind,
    plannedSessions: row.plannedSessions,
    startsOn: dateOnlyKey(row.startsOn),
    validUntil,
    endedOn,
    status: deriveSeriesStatus(
      { plannedSessions: row.plannedSessions, validUntil, endedOn },
      summary.done,
      context.today,
    ),
    sessions: {
      done: summary.done,
      booked: summary.booked,
      cancelled: summary.cancelled,
      remaining:
        row.plannedSessions === null
          ? null
          : Math.max(0, row.plannedSessions - summary.done),
    },
    firstSessionAt: summary.firstSessionAt?.toISOString() ?? null,
    lastSessionAt: summary.lastSessionAt?.toISOString() ?? null,
    nextSessionAt: summary.nextSessionAt?.toISOString() ?? null,
    prescriber: row.prescriber ? toPractitionerDTO(row.prescriber) : null,
    performer: row.performer ? toPractitionerDTO(row.performer) : null,
    condition: episode
      ? context.illnessVisible
        ? {
            id: episode.id,
            label: episode.label,
            date: episode.onsetAt.toISOString(),
            redacted: false,
          }
        : { id: episode.id, label: null, date: null, redacted: true }
      : null,
    note: decryptSeriesText(row.noteEncrypted, "note"),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
