/**
 * v1.37.0 — the bodies the managed-profile family accepts.
 *
 * Here rather than beside each route because the OpenAPI table publishes them,
 * and a schema written twice is a contract that drifts on the third change.
 * The route modules import these; nothing imports the route modules.
 *
 * Every one is `.strict()`. A managed profile is a person's health record
 * created by somebody else, so a field the sender did not mean to send is
 * refused rather than ignored — and the client types name exactly these fields
 * for the same reason (`src/lib/queries/use-managed-profiles.ts`).
 */
import { z } from "zod/v4";

import { isValidTimezone } from "@/lib/tz/format";

/**
 * The record's sex, as `User.gender` already stores it.
 *
 * The column is the one every other surface writes — `PATCH /api/auth/me`, the
 * onboarding baseline, and the guardian's own `PATCH
 * /api/record-settings/profile` — so this family reuses its name and its three
 * values rather than minting a second word for one column. `null` is a real
 * answer ("not recorded"), not an absent field: a record created for a child
 * whose guardian would rather not record it says so, and the cycle module
 * derives OFF from it exactly as it does for an account that never answered.
 */
const managedProfileGenderSchema = z.enum(["MALE", "FEMALE", "OTHER"]);

/** The fields both bodies below share, with their bounds stated once. */
const managedProfileFields = {
  displayName: z.string().trim().min(1).max(80),
  dateOfBirth: z.iso.date().nullable(),
  locale: z.enum(["de", "en", "es", "fr", "it", "pl", "ko"]),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidTimezone, "Invalid IANA timezone"),
  gender: managedProfileGenderSchema.nullable(),
} as const;

/** The body `POST /api/managed-profiles` accepts. */
export const createManagedProfileSchema = z
  .object({
    displayName: managedProfileFields.displayName,
    dateOfBirth: managedProfileFields.dateOfBirth.optional(),
    locale: managedProfileFields.locale,
    timezone: managedProfileFields.timezone,
    gender: managedProfileFields.gender.optional(),
  })
  .strict();

/**
 * The body `PATCH /api/managed-profiles/{id}` accepts.
 *
 * Every field optional and at least one required. A managed record is edited
 * long after it was created — a name that was a placeholder, a timezone that
 * moved with the household, a date of birth somebody finally has — and a
 * PUT-shaped body would make changing the name mean re-sending the other four,
 * with a stale copy of each. So absence means "leave it", and `null` on the two
 * nullable fields means "clear it": the two are different answers and the
 * schema keeps them different.
 *
 * The refinement is not decoration. An empty strict object parses, and without
 * it an empty body would write nothing, audit a change, and answer 200 —
 * a no-op that looks like an edit in the record's own activity trail.
 */
export const updateManagedProfileSchema = z
  .object({
    displayName: managedProfileFields.displayName.optional(),
    dateOfBirth: managedProfileFields.dateOfBirth.optional(),
    locale: managedProfileFields.locale.optional(),
    timezone: managedProfileFields.timezone.optional(),
    gender: managedProfileFields.gender.optional(),
  })
  .strict()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    { message: "Name at least one field to change" },
  );

/** The body `POST /api/managed-profiles/{id}/guardians` accepts. */
export const inviteManagedProfileGuardianSchema = z
  .object({
    identifier: z.string().trim().min(1).max(255),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
