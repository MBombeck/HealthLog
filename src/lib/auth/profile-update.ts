/**
 * Shared profile-update logic. The web client hits `/api/auth/profile` PUT
 * and the iOS client hits `/api/user/profile` PATCH — both funnel through
 * `applyProfileUpdate` so we don't fork the validation/audit path.
 */
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { profileSchema } from "@/lib/validations/auth";
import { isValidTimezone } from "@/lib/tz/format";
import { encrypt } from "@/lib/crypto";
import {
  invalidateUserMedications,
  invalidateUserProfile,
} from "@/lib/cache/invalidate";
import { sanitiseZodIssues, type SanitisedZodIssue } from "@/lib/api-response";
import { z } from "zod/v4";

const extendedProfileSchema = profileSchema.extend({
  displayName: z.string().min(1).max(80).nullable().optional(),
  locale: z
    .enum(["de", "en"], {
      error: "Locale must be de or en.",
    })
    .nullable()
    .optional(),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidTimezone, "Invalid IANA timezone")
    .optional(),
  moodReminderEnabled: z.boolean().optional(),
  // Hour-cycle display preference. AUTO follows the locale convention,
  // H12 forces AM/PM, H24 forces 24-hour.
  timeFormat: z
    .enum(["AUTO", "H12", "H24"], {
      error: "Time format must be AUTO, H12 or H24.",
    })
    .optional(),
  // Date-order display preference. AUTO follows the locale convention,
  // DMY pins day-month-year, MDY month-day-year, YMD ISO yyyy-MM-dd.
  dateFormat: z
    .enum(["AUTO", "DMY", "MDY", "YMD"], {
      error: "Date format must be AUTO, DMY, MDY or YMD.",
    })
    .optional(),
});

type ExtendedProfileInput = z.infer<typeof extendedProfileSchema>;

/**
 * The only profile fields a demo instance may write: the three the setup
 * flow's baseline step collects.
 *
 * `PUT /api/auth/profile` sits on the proxy's `DEMO_MUTATION_ALLOWLIST` so
 * that step can complete. That list is an EDGE control — it admits a path and
 * a method, and it cannot see that the handler behind the path also writes
 * this account's contact email, its display name, its full name and its
 * insurer fields. On an ordinary instance those are the caller's own record;
 * on the demo, which is ONE published account every visitor signs into, each
 * of them is the record the next visitor arrives at, until a reseed.
 *
 * So the narrowing is here and not in the client. The web form sends only
 * these three plus a display name, but a form is not a control: the whole
 * reason the allowlist exists is that the caller is not trusted.
 */
export const DEMO_WRITABLE_PROFILE_FIELDS = [
  "heightCm",
  "dateOfBirth",
  "gender",
] as const;

/**
 * The profile schema has no cross-field `.refine()` — every field is an
 * independent scalar column. That means a rejected `gender` has no
 * bearing on whether `heightCm` is safe to write, so a single bad field
 * no longer has to take every sibling change down with it (the report:
 * "editing height and gender together lost both").
 *
 * Re-validates each key present in `body` against its own field schema
 * (`extendedProfileSchema.shape[key]`), independent of the others.
 * Fields that pass land in `valid`; fields that fail land in `issues`
 * with `path` set to the field name (a field-level `safeParse` reports
 * an empty path, since it never saw the parent object). Unknown keys
 * are silently dropped, matching `z.object`'s own default behaviour.
 */
function splitValidProfileFields(body: Record<string, unknown>): {
  valid: Partial<ExtendedProfileInput>;
  issues: SanitisedZodIssue[];
} {
  const shape = extendedProfileSchema.shape as Record<string, z.ZodTypeAny>;
  const valid: Record<string, unknown> = {};
  const issues: SanitisedZodIssue[] = [];
  for (const key of Object.keys(body)) {
    const fieldSchema = shape[key];
    if (!fieldSchema) continue;
    const result = fieldSchema.safeParse(body[key]);
    if (result.success) {
      valid[key] = result.data;
    } else {
      for (const issue of result.error.issues) {
        issues.push({ path: key, code: issue.code, message: issue.message });
      }
    }
  }
  return { valid: valid as Partial<ExtendedProfileInput>, issues };
}

export interface ApplyProfileResult {
  ok: true;
  user: {
    id: string;
    username: string;
    displayName: string | null;
    email: string | null;
    role: string;
    heightCm: number | null;
    dateOfBirth: Date | null;
    gender: string | null;
    timezone: string;
    locale: string | null;
    timeFormat: "AUTO" | "H12" | "H24";
    dateFormat: "AUTO" | "DMY" | "MDY" | "YMD";
    moodReminderEnabled: boolean;
    // v1.7.0 — patient-identity fields. `insuranceNumber` is returned in
    // plaintext (decrypted on read by the route) so the client can render
    // the value back into the form; the route is responsible for the read
    // decryption. Here we only echo the two plaintext columns and a
    // boolean presence flag for the encrypted KVNR.
    fullName: string | null;
    insurerName: string | null;
    insurerIkNumber: string | null;
    hasInsuranceNumber: boolean;
  };
  /**
   * Present only when the caller sent at least one invalid field
   * alongside at least one valid one. The fields named here were NOT
   * written — everything absent from this list landed. Empty/undefined
   * means every touched field saved cleanly. The web client resolves
   * `path` against its own field labels to name the rejected field(s);
   * the message stays machine-readable, never shown verbatim.
   */
  rejectedFields?: SanitisedZodIssue[];
}

export interface ApplyProfileError {
  ok: false;
  status: number;
  /**
   * A sentence safe for a person to read — never a raw Zod message (no
   * enum literals, no validator prose). Native/non-i18n callers that
   * ignore `errorCode` still get something a person can act on.
   */
  message: string;
  /**
   * Stable code the web client resolves through `apiErrors.<errorCode>`
   * for a localized sentence (see `localizedApiError`). Absent for
   * non-validation failures (e.g. the 409 email-conflict below) that
   * already carry a safe, specific message.
   */
  errorCode?: string;
  /**
   * Full per-field detail, relocated (not deleted) from the top-level
   * `message`. Matches the `details.issues` multi-issue envelope the
   * iOS contract already expects from other write routes.
   */
  issues?: SanitisedZodIssue[];
}

/**
 * Validate and persist profile updates for `userId`. Returns either an
 * `ApplyProfileResult` on success or `ApplyProfileError` with a status
 * code so callers can shape the wire response themselves.
 *
 * The profile schema has no cross-field dependency, so an invalid field
 * never has to block its valid siblings: a full-object parse is tried
 * first (the common case), and only on failure does the update fall
 * back to `splitValidProfileFields` to salvage whatever validated. If
 * NOTHING in the payload validates, nothing is written — an honest
 * all-or-nothing rejection naming the field that blocked it, rather
 * than a raw validator string.
 */
export async function applyProfileUpdate(
  userId: string,
  body: unknown,
  ipAddress?: string | null,
): Promise<ApplyProfileResult | ApplyProfileError> {
  const parsed = extendedProfileSchema.safeParse(body);

  let data: Partial<ExtendedProfileInput>;
  let rejectedFields: SanitisedZodIssue[] = [];

  if (parsed.success) {
    data = parsed.data;
  } else {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return {
        ok: false,
        status: 422,
        message: "Nothing was saved. The profile update was not an object.",
        errorCode: "profile.update.invalidBody",
        issues: sanitiseZodIssues(parsed.error.issues),
      };
    }

    const split = splitValidProfileFields(body as Record<string, unknown>);
    data = split.valid;
    rejectedFields = split.issues;

    if (Object.keys(data).length === 0) {
      // Every touched field failed — there is nothing to salvage.
      // Name the field that blocked it so the person fixes one thing
      // instead of re-entering everything.
      const first = rejectedFields[0];
      return {
        ok: false,
        status: 422,
        message: first
          ? `Nothing was saved. Fix the "${first.path}" field and try again.`
          : "Nothing was saved. The submitted profile data was invalid.",
        errorCode: "profile.update.nothingSaved",
        issues: rejectedFields,
      };
    }
  }

  // Ahead of the conflict check below, deliberately: that check answers 409
  // when another account holds the address, which on a public demo is an
  // existence oracle over the instance's accounts. Dropping the field first
  // closes the write and the question in one move.
  if (process.env.DEMO_MODE === "true") {
    const writable = DEMO_WRITABLE_PROFILE_FIELDS as readonly string[];
    data = Object.fromEntries(
      Object.entries(data).filter(([key]) => writable.includes(key)),
    ) as Partial<ExtendedProfileInput>;
  }

  const normalizedEmail = data.email ? data.email.trim().toLowerCase() : null;

  if (data.email !== undefined && normalizedEmail) {
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existing && existing.id !== userId) {
      return {
        ok: false,
        status: 409,
        message: "Email already in use",
        errorCode: "profile.update.emailInUse",
      };
    }
  }

  const updates: Record<string, unknown> = {};
  if (data.email !== undefined) updates.email = normalizedEmail;
  if (data.heightCm !== undefined) updates.heightCm = data.heightCm ?? null;
  if (data.dateOfBirth !== undefined) {
    updates.dateOfBirth = data.dateOfBirth ? new Date(data.dateOfBirth) : null;
  }
  if (data.gender !== undefined) updates.gender = data.gender;
  if (data.displayName !== undefined) {
    updates.displayName =
      data.displayName === null || data.displayName === ""
        ? null
        : data.displayName.trim();
  }
  if (data.locale !== undefined) updates.locale = data.locale;
  if (data.timezone !== undefined) updates.timezone = data.timezone;
  if (data.timeFormat !== undefined) updates.timeFormat = data.timeFormat;
  if (data.dateFormat !== undefined) updates.dateFormat = data.dateFormat;
  if (data.moodReminderEnabled !== undefined) {
    updates.moodReminderEnabled = data.moodReminderEnabled;
  }
  // v1.7.0 — patient-identity fields. Plaintext for fullName/insurerName;
  // KVNR is encrypted at rest. An empty string collapses to null so the
  // export cover + FHIR Patient omit the line entirely.
  if (data.fullName !== undefined) {
    updates.fullName =
      data.fullName === null || data.fullName === "" ? null : data.fullName;
  }
  if (data.insurerName !== undefined) {
    updates.insurerName =
      data.insurerName === null || data.insurerName === ""
        ? null
        : data.insurerName;
  }
  // v1.8.6 — IKNR plaintext (matches insurerName). The Zod transform
  // already mapped empty → null, so a null here means "clear it".
  if (data.insurerIkNumber !== undefined) {
    updates.insurerIkNumber = data.insurerIkNumber ?? null;
  }
  if (data.insuranceNumber !== undefined) {
    updates.insuranceNumberEncrypted =
      data.insuranceNumber === null || data.insuranceNumber === ""
        ? null
        : encrypt(data.insuranceNumber);
  }

  // v1.4.18 — capture the prior locale so we can emit a separate
  // `settings.locale.update` audit row when the locale actually
  // changes. The hidden "polyglot" achievement watches that action,
  // and we don't want to fire it on profile updates that happen to
  // touch other fields.
  const priorLocale =
    data.locale !== undefined
      ? ((
          await prisma.user.findUnique({
            where: { id: userId },
            select: { locale: true },
          })
        )?.locale ?? null)
      : null;

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: updates,
  });

  // Anthropometrics feed the cached targets grid (BMI band, BP-by-age
  // range, body-fat band), the derived-score baseline profile (age /
  // sex / height) and the analytics snapshot. Only those three fields
  // matter here — a display-name or email edit must not cold-rebuild
  // the analytics caches.
  if (
    data.heightCm !== undefined ||
    data.dateOfBirth !== undefined ||
    data.gender !== undefined
  ) {
    invalidateUserProfile(userId);
  }

  // v1.16.9 — the medication payloads (list next-due, today counts, the
  // compliance day buckets) are computed in the user's timezone, but the
  // list cache key carries only the userId. A timezone change must evict
  // the bucket or the next read serves the previous zone's day grid.
  if (data.timezone !== undefined) {
    invalidateUserMedications(userId, { evict: true });
  }

  await auditLog("profile.update", {
    userId: updatedUser.id,
    ipAddress: ipAddress ?? null,
  });

  if (data.locale !== undefined && priorLocale !== data.locale) {
    await auditLog("settings.locale.update", {
      userId: updatedUser.id,
      ipAddress: ipAddress ?? null,
      details: { from: priorLocale, to: data.locale ?? null },
    });
  }

  return {
    ok: true,
    user: {
      id: updatedUser.id,
      username: updatedUser.username,
      displayName: updatedUser.displayName,
      email: updatedUser.email,
      role: updatedUser.role,
      heightCm: updatedUser.heightCm,
      dateOfBirth: updatedUser.dateOfBirth,
      gender: updatedUser.gender,
      timezone: updatedUser.timezone,
      locale: updatedUser.locale,
      timeFormat: updatedUser.timeFormat ?? "AUTO",
      dateFormat: updatedUser.dateFormat ?? "AUTO",
      moodReminderEnabled: updatedUser.moodReminderEnabled,
      fullName: updatedUser.fullName,
      insurerName: updatedUser.insurerName,
      insurerIkNumber: updatedUser.insurerIkNumber,
      hasInsuranceNumber: updatedUser.insuranceNumberEncrypted != null,
    },
    ...(rejectedFields.length > 0 ? { rejectedFields } : {}),
  };
}
