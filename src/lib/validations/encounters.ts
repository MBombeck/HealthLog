/**
 * Visit (encounter) request/response validation.
 *
 * Source of truth for the `/api/encounters*` wire contract; the OpenAPI
 * registry reuses these schemas so the spec stays single-source. `userId` is
 * NEVER a body field — it is narrowed from the session or Bearer in every
 * route and fed to the Prisma `where`.
 *
 * Nothing here is mandatory except the date. A visit saves with an instant and
 * nothing else: no practitioner, no kind, no reason, no link. That is a
 * deliberate product constraint and not an oversight — a required field on a
 * form somebody fills after a doctor's appointment is the bureaucracy this
 * whole feature exists to avoid.
 *
 * The one exception to "no future instants" that the rest of the record keeps:
 * `occurredAt` may be in the future, because a booked appointment IS a visit
 * with a future date. It is bounded on both sides regardless, so a typo cannot
 * park a row a century out.
 */
import { z } from "zod/v4";

/** Ten years out. Long enough for any real appointment, short enough that a
 *  mistyped year lands as a 422 rather than as a row nobody sees again. */
const MAX_FUTURE_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * An instant a visit can plausibly carry.
 *
 * Deliberately NOT `isPlausibleEntryInstant`, which refuses anything beyond a
 * five-minute clock skew. That bound is right for a measurement, which can only
 * describe something that already happened, and wrong here.
 */
const visitInstant = z.iso.datetime({ offset: true }).refine(
  (value) => {
    const at = new Date(value).getTime();
    if (Number.isNaN(at)) return false;
    if (at < Date.UTC(1900, 0, 1)) return false;
    return at <= Date.now() + MAX_FUTURE_MS;
  },
  {
    message:
      "must be a plausible visit instant (not before 1900, not more than ten years ahead)",
  },
);

/* ── enums (mirror the Prisma enums) ─────────────────────────────── */

export const encounterStatusEnum = z.enum([
  "PLANNED",
  "DONE",
  "CANCELLED",
  "NO_SHOW",
]);

export const encounterKindEnum = z.enum([
  "ROUTINE",
  "ACUTE",
  "SPECIALIST",
  "PREVENTIVE",
  "EMERGENCY",
  "HOSPITAL",
  "THERAPY",
  "OTHER",
  "PROCEDURE",
]);

/** The side a procedure's body site is on. Absent or null: not stated. */
export const lateralityEnum = z.enum(["LEFT", "RIGHT", "BOTH"]);

export type EncounterStatusInput = z.infer<typeof encounterStatusEnum>;
export type EncounterKindInput = z.infer<typeof encounterKindEnum>;
export type LateralityInput = z.infer<typeof lateralityEnum>;

/**
 * Where on the body, in the person's own words. Becomes `bodySiteEncrypted`.
 * Bounded like a label rather than like prose: "left knee, medial meniscus" is
 * the long end of what belongs here, and the reason field holds the rest.
 */
const bodySite = z.string().max(200).nullable().optional();

const id = z.string().min(1).max(40);

/**
 * The three optional pre-link arrays.
 *
 * Bounded at the link service's own cap so an over-long list is a 422 with a
 * field path rather than a thrown error from two layers down.
 */
const linkIds = z.array(id).max(100).optional();

/* ── encounter CRUD ───────────────────────────────────────────────── */

export const encounterCreateSchema = z
  .object({
    occurredAt: visitInstant,
    status: encounterStatusEnum.optional().default("DONE"),
    kind: encounterKindEnum.optional().default("OTHER"),
    practitionerId: id.nullable().optional(),
    /** Becomes `reasonEncrypted`. */
    reason: z.string().max(2000).nullable().optional(),
    /** Becomes `outcomeEncrypted`. */
    outcome: z.string().max(4000).nullable().optional(),
    bodySite,
    laterality: lateralityEnum.nullable().optional(),
    /** The checkup this visit closes, when it was filed from a due one. */
    reminderId: id.nullable().optional(),
    documentIds: linkIds,
    labResultIds: linkIds,
    episodeIds: linkIds,
  })
  .strict();

export type EncounterCreate = z.infer<typeof encounterCreateSchema>;

/**
 * Edit a visit. Every field optional; an omitted field is left untouched.
 *
 * A body naming nothing is a 422 rather than a silent success: a PATCH that
 * changed nothing and answered 200 is indistinguishable from one that worked,
 * which is how a client bug survives a release.
 */
export const encounterUpdateSchema = z
  .object({
    occurredAt: visitInstant.optional(),
    status: encounterStatusEnum.optional(),
    kind: encounterKindEnum.optional(),
    practitionerId: id.nullable().optional(),
    reason: z.string().max(2000).nullable().optional(),
    outcome: z.string().max(4000).nullable().optional(),
    bodySite,
    laterality: lateralityEnum.nullable().optional(),
    reminderId: id.nullable().optional(),
    documentIds: linkIds,
    labResultIds: linkIds,
    episodeIds: linkIds,
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "name at least one field to change",
  });

export type EncounterUpdate = z.infer<typeof encounterUpdateSchema>;

/**
 * List query.
 *
 * Windowed and bounded. The response splits past from upcoming server-side, so
 * there is no `order` parameter: the client renders two lists rather than
 * sorting one.
 */
export const encounterListQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    status: encounterStatusEnum.optional(),
    practitionerId: id.optional(),
    /**
     * Only visits filed against this condition episode.
     *
     * The condition side of the link, and the only direction it is offered in:
     * an episode spans weeks and a visit is a point, so matching from the visit
     * side would produce false positives at a rate that trains a person to
     * ignore every suggestion in the product.
     */
    episodeId: id.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    path: ["to"],
    message: "to must be on or after from",
  });

export type EncounterListQuery = z.infer<typeof encounterListQuerySchema>;

/**
 * The suggestion query.
 *
 * One input, and it is a date rather than an id: the answer is derived from the
 * caller's own visits and the anchor only says where to look. Bounded by the
 * same instant rule the visit itself carries, so an anchor a client mis-parsed
 * into the year 12000 is a 422 rather than a full-table scan.
 */
export const encounterSuggestQuerySchema = z
  .object({
    anchor: visitInstant,
  })
  .strict();

export type EncounterSuggestQuery = z.infer<typeof encounterSuggestQuerySchema>;

/**
 * The procedure history query.
 *
 * `q` is matched after the decrypt, over the body site, the side and the
 * reason, every word required (see `src/lib/encounters/procedures.ts`). It is
 * named `q` and not `bodySite` because it also searches the reason: a knee
 * operation recorded before the site field existed says "knee" only there.
 */
export const procedureListQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    laterality: lateralityEnum.optional(),
  })
  .strict();

export type ProcedureListQuery = z.infer<typeof procedureListQuerySchema>;

/* ── links ────────────────────────────────────────────────────────── */

export const encounterLinkTargetEnum = z.enum([
  "document",
  "labResult",
  "conditionEpisode",
]);

export const encounterLinkSchema = z
  .object({
    targetKind: encounterLinkTargetEnum,
    targetIds: z.array(id).min(1).max(100),
  })
  .strict();

export type EncounterLinkInput = z.infer<typeof encounterLinkSchema>;
