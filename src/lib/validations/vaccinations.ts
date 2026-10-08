/**
 * Vaccination request/response validation.
 *
 * Source of truth for the `/api/vaccinations*` wire contract; the OpenAPI
 * registry reuses these schemas so the spec stays single-source. `userId` is
 * NEVER a body field — it is narrowed from the session or Bearer in every
 * route and fed to the Prisma `where`.
 *
 * Nothing is mandatory except the date and ONE identity arm. A dose saves with
 * a day and either a catalogue pick or the person's own wording, and nothing
 * else: no dose number, no batch code, no arm, no practice, no document. A
 * required catalogue pick would make a 1987 Pass line unloggable, which is the
 * whole population this feature exists for.
 *
 * Two places where the API is deliberately stricter than the column:
 *
 *   - `occurredAt` refuses a future instant. A vaccination is logged after the
 *     fact; a planned booster is a reminder, not a record. The visit schema
 *     next door allows the future because a booked appointment genuinely is
 *     one; a dose that has not been given is not a dose.
 *   - `antigenSlug` must resolve in the catalogue this release ships. Storage
 *     stays tolerant so a backup written by an older version restores whole
 *     and its slug degrades to the free-text arm on screen; a write is the one
 *     moment the catalogue is authoritative, because the picker produced it.
 */
import { z } from "zod/v4";

import {
  ANTIGEN_SLUGS,
  VACCINE_CATALOG_SLUGS,
} from "@/lib/vaccinations/vaccine-catalog";

const KNOWN_SLUGS: ReadonlySet<string> = new Set(VACCINE_CATALOG_SLUGS);

/**
 * A day a dose can plausibly carry.
 *
 * Bounded on both sides: not before 1900, and not in the future beyond the
 * clock skew a client's own "today" can plausibly show. The skew allowance is
 * a day rather than minutes because the value is a DAY — a client in a
 * timezone ahead of the server sends its own local date, and refusing that
 * would make the form unusable east of here.
 */
const DAY_SKEW_MS = 24 * 60 * 60 * 1000;

const doseInstant = z.iso.datetime({ offset: true }).refine(
  (value) => {
    const at = new Date(value).getTime();
    if (Number.isNaN(at)) return false;
    if (at < Date.UTC(1900, 0, 1)) return false;
    return at <= Date.now() + DAY_SKEW_MS;
  },
  {
    message:
      "must be a day a dose was actually given (not before 1900, not in the future — a planned booster is a reminder, not a record)",
  },
);

/* ── enum (mirrors the Prisma enum) ───────────────────────────────── */

export const vaccinationSiteEnum = z.enum([
  "LEFT_ARM",
  "RIGHT_ARM",
  "LEFT_THIGH",
  "RIGHT_THIGH",
  "ORAL",
  "NASAL",
  "OTHER",
]);

export type VaccinationSiteInput = z.infer<typeof vaccinationSiteEnum>;

const id = z.string().min(1).max(40);

/**
 * A slug the catalogue this release ships actually has.
 *
 * The message names the field rather than listing thirty-five slugs: the
 * picker is the source of a legitimate value, so a slug arriving here that is
 * not in the set is a client defect or a hand-written request, and neither is
 * helped by an enumeration.
 */
const antigenSlug = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => KNOWN_SLUGS.has(value), {
    message: "must be a slug the vaccine catalogue offers",
  });

/** Bounded at the link service's own cap, so an over-long list is a 422. */
const linkIds = z.array(id).max(100).optional();

/* ── vaccination CRUD ─────────────────────────────────────────────── */

/**
 * The either-arm rule, applied to whichever schema needs it.
 *
 * Written as a helper because create and update both need it and they need it
 * to REPORT the same way: the issue is raised against both fields, so a client
 * highlighting one field per issue highlights the pick and the free-text box
 * rather than leaving the person guessing which of the two the server meant.
 */
const IDENTITY_MESSAGE =
  "name the vaccine: pick one from the catalogue or your own vaccines, or type what the record says";

export const vaccinationCreateSchema = z
  .object({
    occurredAt: doseInstant,
    antigenSlug: antigenSlug.nullable().optional(),
    /** The Pass's own wording, verbatim. May be a trade name — user data. */
    vaccineName: z.string().min(1).max(200).nullable().optional(),
    doseNumber: z.number().int().min(1).max(20).nullable().optional(),
    seriesDoses: z.number().int().min(1).max(10).nullable().optional(),
    /** Chargenbezeichnung. A batch code, not a secret. */
    lotNumber: z.string().min(1).max(64).nullable().optional(),
    site: vaccinationSiteEnum.nullable().optional(),
    practitionerId: id.nullable().optional(),
    encounterId: id.nullable().optional(),
    /**
     * v1.42 (#1005) — one of the record's own vaccine definitions, the third
     * identity arm. Re-narrowed to the resolved record in the route.
     */
    customVaccineId: id.nullable().optional(),
    /** Becomes `noteEncrypted`. Impfreaktionen live here. */
    note: z.string().max(2000).nullable().optional(),
    documentIds: linkIds,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.antigenSlug || body.vaccineName || body.customVaccineId) return;
    for (const path of ["antigenSlug", "vaccineName"] as const) {
      ctx.addIssue({ code: "custom", path: [path], message: IDENTITY_MESSAGE });
    }
  });

export type VaccinationCreate = z.infer<typeof vaccinationCreateSchema>;

/**
 * Edit a dose. Every field optional; an omitted field is left untouched.
 *
 * A body naming nothing is a 422 rather than a silent success: a PATCH that
 * changed nothing and answered 200 is indistinguishable from one that worked.
 *
 * `occurredAt` is editable — a transcription typo is the common case, and the
 * date is the field most likely to carry one. The identity rule is checked
 * against the merged row in the route rather than here, because a PATCH that
 * names only `lotNumber` says nothing about the identity and must not be
 * refused for it.
 */
export const vaccinationUpdateSchema = z
  .object({
    occurredAt: doseInstant.optional(),
    antigenSlug: antigenSlug.nullable().optional(),
    vaccineName: z.string().min(1).max(200).nullable().optional(),
    doseNumber: z.number().int().min(1).max(20).nullable().optional(),
    seriesDoses: z.number().int().min(1).max(10).nullable().optional(),
    lotNumber: z.string().min(1).max(64).nullable().optional(),
    site: vaccinationSiteEnum.nullable().optional(),
    practitionerId: id.nullable().optional(),
    encounterId: id.nullable().optional(),
    customVaccineId: id.nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    documentIds: linkIds,
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "name at least one field to change",
  })
  .refine(
    (body) =>
      // Only when the edit clears EVERY arm in one call. Clearing one while
      // another stays is legal and the route checks the merged row.
      !(
        body.antigenSlug === null &&
        body.vaccineName === null &&
        body.customVaccineId === null
      ),
    { path: ["antigenSlug"], message: IDENTITY_MESSAGE },
  );

export type VaccinationUpdate = z.infer<typeof vaccinationUpdateSchema>;

/**
 * List query.
 *
 * An Impfpass is a lifetime document but a small one, so the list is full and
 * bounded rather than paged: the default `take` already covers a long life,
 * and a client that wants less says so.
 */
export const vaccinationListQuerySchema = z
  .object({
    antigenSlug: z.string().min(1).max(64).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict()
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    path: ["to"],
    message: "to must be on or after from",
  });

export type VaccinationListQuery = z.infer<typeof vaccinationListQuerySchema>;

/* ── the record's own vaccines (v1.42, #1005) ─────────────────────── */

/**
 * The antigens a definition protects against: only from the catalogue's
 * closed antigen list, because the series derivation and the booster match
 * both key on those slugs. A disease the list does not carry is a free-text
 * dose, not a definition.
 */
export const customVaccineComponentsSchema = z
  .array(z.enum(ANTIGEN_SLUGS))
  .min(1)
  .max(ANTIGEN_SLUGS.length)
  .refine((list) => new Set(list).size === list.length, {
    message: "name each antigen once",
  });

/** The definition's name: what the person calls the product. */
const customVaccineName = z.string().trim().min(1).max(100);

export const customVaccineCreateSchema = z
  .object({
    name: customVaccineName,
    components: customVaccineComponentsSchema,
    typicalSeriesDoses: z.number().int().min(1).max(10).nullable().optional(),
    /** Months; a decade booster is 120, bounded like the booster confirm. */
    boosterIntervalMonths: z
      .number()
      .int()
      .min(1)
      .max(600)
      .nullable()
      .optional(),
  })
  .strict();

export type CustomVaccineCreate = z.infer<typeof customVaccineCreateSchema>;

/** Edit a definition; an omitted field is left untouched, an empty body 422s. */
export const customVaccineUpdateSchema = customVaccineCreateSchema
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "name at least one field to change",
  });

export type CustomVaccineUpdate = z.infer<typeof customVaccineUpdateSchema>;

/* ── links ────────────────────────────────────────────────────────── */

/**
 * The one link family a dose has.
 *
 * A single-member enum rather than a bare constant, so the wire shape matches
 * the encounter link route's and a second family — if this venture ever loses
 * the argument against one — is an added member rather than a changed shape.
 */
export const vaccinationLinkTargetEnum = z.enum(["document"]);

export const vaccinationLinkSchema = z
  .object({
    targetKind: vaccinationLinkTargetEnum,
    targetIds: z.array(id).min(1).max(100),
  })
  .strict();

export type VaccinationLinkInput = z.infer<typeof vaccinationLinkSchema>;

/* ── booster mint (rung 2) ────────────────────────────────────────── */

/**
 * The confirm body for a booster reminder.
 *
 * Every value is the user's — accepted or edited from the catalogue's
 * prefill. `intervalMonths` is bounded generously (a decade booster is 120)
 * and the label is composed client-side so its locale is the person's own. No
 * `vaccinationAntigen` field: the server reads the antigen from the dose's
 * catalogue entry, never from the request, so a client cannot key a reminder
 * onto an antigen the dose does not contain.
 */
export const vaccinationBoosterSchema = z
  .object({
    intervalMonths: z.number().int().min(1).max(600),
    label: z.string().trim().min(1).max(120),
    notifyHour: z.number().int().min(0).max(23).optional(),
  })
  .strict();

export type VaccinationBoosterInput = z.infer<typeof vaccinationBoosterSchema>;

/* ── upload suggestion ────────────────────────────────────────────── */

/**
 * The single input to the upload suggestion: the document's anchor date. No
 * ids — the candidate doses come from the caller's own record, narrowed from
 * the session.
 */
export const vaccinationSuggestQuerySchema = z
  .object({
    anchor: z.iso.datetime({ offset: true }),
  })
  .strict();

export type VaccinationSuggestQuery = z.infer<
  typeof vaccinationSuggestQuerySchema
>;
