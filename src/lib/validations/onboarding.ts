/**
 * Request schema for the completion write.
 *
 * It lives outside the route file for the same reason
 * `src/lib/validations/about-me.ts` does: a route module may only export
 * handlers plus the Next.js route config, so the OpenAPI registry cannot
 * import a schema declared inside one. Keeping the shape here lets the
 * published contract and the runtime parser be the same object rather than
 * two hand-kept copies.
 *
 * Prisma-free by construction, so the generator script can pull it in
 * without dragging the server graph along.
 */
import { z } from "zod/v4";

/**
 * `POST /api/onboarding/complete` — the completion stamp.
 *
 * Every field is optional: the endpoint's job is the completion stamp, and
 * the profile fields are whatever the caller happened to collect. A field
 * that parses but is falsy (an empty `displayName`, `heightCm: 0`) is not
 * written — the route only assigns truthy values. The web flow sends an
 * empty body and writes its profile through `PUT /api/auth/profile`.
 */
export const onboardingCompleteSchema = z.object({
  /**
   * v1.39 (C2) — the managed record the answers were given FOR. Sent by the
   * confirm screen after "someone I look after" created the profile: the
   * module map and the dashboard order derived from the caller's answers are
   * applied to that record, and the caller's own record is stamped complete
   * without deriving. The caller must be a guardian of it, and the answer to
   * Q1 must be "someone-else"; anything else is refused rather than applied
   * to the wrong record.
   */
  managedRecordId: z.string().trim().min(1).max(64).optional(),
  displayName: z.string().trim().min(1).max(50).optional(),
  heightCm: z.number().min(50).max(300).optional(),
  dateOfBirth: z.string().optional(),
  // The same three values the profile schema stores. A narrower enum here
  // rejected the whole onboarding submission over a field the account is
  // allowed to hold, and left the value unrecordable until the person found
  // the setting again afterwards.
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
});

export type OnboardingCompleteInput = z.infer<typeof onboardingCompleteSchema>;
