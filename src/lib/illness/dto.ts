/**
 * Illness row → wire-DTO mappers (v1.18.1).
 *
 * The canonical `IllnessEpisodeDTO` and `IllnessDayLogDTO` shapes the iOS
 * client mirrors (server-authoritative — iOS renders, never recomputes).
 * Free-text notes live in `noteEncrypted` (Bytes) and are decrypted
 * fail-soft on read (a key-rotation gap on one row reads `null`, never
 * 500s the whole page). Symptom links flatten to `[{ key, severity }]`
 * using the catalog key; `severity` carries the persisted per-link 0–3
 * Jackson/WURSS intensity (NULL = a plain presence link).
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";
import type {
  IllnessEpisode,
  IllnessDayLog,
  Laterality,
  IllnessSymptom,
  IllnessSymptomLink,
} from "@/generated/prisma/client";

export interface IllnessSymptomDTO {
  key: string;
  severity: number | null;
}

export interface IllnessEpisodeDTO {
  id: string;
  label: string;
  type: string;
  lifecycle: string;
  onsetAt: string;
  resolvedAt: string | null;
  parentConditionId: string | null;
  note: string | null;
  /**
   * Where on the body, decrypted (v1.39.2). Null when not stated. Additive:
   * a client that does not know the field ignores it, and an edit that does
   * not send it keeps it.
   */
  bodySite: string | null;
  /** The side of `bodySite`, or null when not stated. */
  laterality: Laterality | null;
  createdAt: string;
  updatedAt: string;
}

export interface IllnessDayLogDTO {
  id: string;
  episodeId: string;
  date: string;
  functionalImpact: number | null;
  feverC: number | null;
  symptoms: IllnessSymptomDTO[];
  note: string | null;
  updatedAt: string;
}

/** Decrypt a Bytes note fail-soft (null on missing / undecryptable). */
function decryptNote(
  noteEncrypted: Uint8Array | null,
  field: "note" | "body site" = "note",
): string | null {
  if (!noteEncrypted || noteEncrypted.byteLength === 0) return null;
  try {
    return decryptFromBytes(noteEncrypted);
  } catch (err) {
    // Undecryptable note (key gap / corruption): fail soft to null but log it
    // (F-CRYPTO-2) so a systemic key gap surfaces instead of reading as blank.
    getEvent()?.addWarning(
      `illness ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export function toIllnessEpisodeDTO(row: IllnessEpisode): IllnessEpisodeDTO {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    lifecycle: row.lifecycle,
    onsetAt: row.onsetAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    parentConditionId: row.parentConditionId,
    note: decryptNote(row.noteEncrypted),
    bodySite: decryptNote(row.bodySiteEncrypted, "body site"),
    laterality: row.laterality,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type DayLogWithLinks = IllnessDayLog & {
  symptomLinks?: (IllnessSymptomLink & {
    symptom: Pick<IllnessSymptom, "key">;
  })[];
};

/** Prisma `include` that flattens the symptom links for the DTO mapper. */
export const dayLogSymptomInclude = {
  symptomLinks: { include: { symptom: { select: { key: true } } } },
} as const;

export function toIllnessDayLogDTO(row: DayLogWithLinks): IllnessDayLogDTO {
  return {
    id: row.id,
    episodeId: row.episodeId,
    date: row.date,
    functionalImpact: row.functionalImpact,
    feverC: row.feverC,
    symptoms: (row.symptomLinks ?? []).map((l) => ({
      key: l.symptom.key,
      severity: l.severity ?? null,
    })),
    note: decryptNote(row.noteEncrypted),
    updatedAt: row.updatedAt.toISOString(),
  };
}
