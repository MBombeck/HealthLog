/**
 * Imaging exams (#1672): the wire contract shared by the routes, the OpenAPI
 * table and the client.
 *
 * One entry per exam. The modality, the day and the side are structured; the
 * body part, the facility, the requesting doctor and the conclusion are the
 * person's own words and are sealed at rest. The files are vault documents
 * filed against the exam, never a second store.
 *
 * `userId` is never a body field. Nothing is mandatory but the modality and
 * the day: an exam saves with those two and fills in later.
 */
import { z } from "zod/v4";

import { isoDateTime } from "@/lib/validations/datetime";

/** Mirrors the Prisma enum `ImagingModality`; append-only. */
export const IMAGING_MODALITIES = [
  "MRI",
  "CT",
  "X_RAY",
  "ULTRASOUND",
  "MAMMOGRAPHY",
  "OTHER",
] as const;
export type ImagingModality = (typeof IMAGING_MODALITIES)[number];

/** Mirrors the Prisma enum `ImagingSide`. */
export const IMAGING_SIDES = ["LEFT", "RIGHT", "BOTH"] as const;
export type ImagingSide = (typeof IMAGING_SIDES)[number];

/** Field bounds, shared with the form so it refuses what the server would. */
export const IMAGING_TEXT_MAX = {
  bodyPart: 80,
  facility: 120,
  requestingDoctor: 120,
  conclusion: 2000,
} as const;

/** The link service's own cap. */
export const IMAGING_MAX_DOCUMENTS = 100;

const DAY_SKEW_MS = 24 * 60 * 60 * 1000;

/** A day an exam can have taken place: from 1900, not in the future. */
const examDay = isoDateTime().refine(
  (value) => {
    const at = new Date(value).getTime();
    if (Number.isNaN(at)) return false;
    if (at < Date.UTC(1900, 0, 1)) return false;
    return at <= Date.now() + DAY_SKEW_MS;
  },
  {
    message:
      "must be the day the exam took place (from 1900, not in the future)",
  },
);

/** Free text: trimmed, an empty string clears the field. */
function text(max: number) {
  return z
    .string()
    .max(max)
    .transform((value) => value.trim())
    .nullable()
    .optional();
}

const documentIds = z
  .array(z.string().min(1).max(40))
  .max(IMAGING_MAX_DOCUMENTS)
  .optional();

const fields = {
  bodyPart: text(IMAGING_TEXT_MAX.bodyPart),
  side: z.enum(IMAGING_SIDES).nullable().optional(),
  facility: text(IMAGING_TEXT_MAX.facility),
  requestingDoctor: text(IMAGING_TEXT_MAX.requestingDoctor),
  conclusion: text(IMAGING_TEXT_MAX.conclusion),
  /** Present: replaces the filed documents (empty array clears). Absent: left alone. */
  documentIds,
};

export const imagingExamCreateSchema = z.object({
  modality: z.enum(IMAGING_MODALITIES),
  performedAt: examDay,
  ...fields,
});

export const imagingExamUpdateSchema = z.object({
  modality: z.enum(IMAGING_MODALITIES).optional(),
  performedAt: examDay.optional(),
  ...fields,
});

export type ImagingExamCreateInput = z.infer<typeof imagingExamCreateSchema>;
export type ImagingExamUpdateInput = z.infer<typeof imagingExamUpdateSchema>;

/** One filed document. `label` and `date` are null when the grant cannot see the vault. */
export interface ImagingExamDocumentDTO {
  id: string;
  label: string | null;
  date: string | null;
  mimeType: string | null;
  redacted: boolean;
}

export interface ImagingExamDTO {
  id: string;
  modality: ImagingModality;
  /** The exam day, ISO-8601 at UTC midnight. */
  performedAt: string;
  side: ImagingSide | null;
  bodyPart: string | null;
  facility: string | null;
  requestingDoctor: string | null;
  conclusion: string | null;
  documents: ImagingExamDocumentDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface ImagingExamListDTO {
  exams: ImagingExamDTO[];
}
