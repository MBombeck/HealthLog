import { z } from "zod/v4";
import { isValidKvnr, normaliseKvnr } from "@/lib/validations/kvnr";
import { webauthnKeyNameSchema } from "@/lib/validations/mfa";
import { clientTransportSchema } from "@/lib/validations/client-transport";

/** Minimum password length — must match checkPasswordStrength() in @/lib/auth/password.ts */
const PASSWORD_MIN_LENGTH = 12;

/**
 * v1.42 (#959) — the prefix a managed profile's generated username carries
 * (`managed-<hex>`, `src/lib/managed-profiles/create.ts`). An account a person
 * names themselves may not start with it: a self-chosen `managed-…` would read
 * as a profile nobody signs into, in every list that shows usernames, and a
 * profile being claimed has to leave the generated name behind rather than
 * keep it.
 */
export const MANAGED_USERNAME_PREFIX = "managed-";

/** A username a person chooses: registration and claiming a profile. */
export const accountUsernameSchema = z
  .string()
  .min(3, "At least 3 characters")
  .max(30, "Maximum 30 characters")
  .regex(/^[a-zA-Z0-9_-]+$/, "Only letters, numbers, _ and -")
  .refine(
    (value) => !value.toLowerCase().startsWith(MANAGED_USERNAME_PREFIX),
    `A username cannot start with "${MANAGED_USERNAME_PREFIX}"`,
  );

/** A first password: registration and claiming a profile. */
export const newAccountPasswordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  );

export const registerSchema = z.object({
  email: z.email("Invalid email address"),
  username: accountUsernameSchema,
  password: newAccountPasswordSchema,
  /**
   * v1.4.25 W7 — browser-detected timezone. The signup form pulls
   * `Intl.DateTimeFormat().resolvedOptions().timeZone` and sends it
   * along; the server validates against the runtime IANA list and
   * falls back to the admin-configured server default
   * (`AppSettings.defaultUserTimezone`) when the value is invalid
   * or missing. Optional so legacy clients that predate v1.4.25
   * keep working.
   */
  timezone: z.string().max(64).optional(),
  /**
   * v1.15.20 — registration invite token (`hlv_<64hex>`, 68 chars).
   * Only consulted when the operator has disabled open registration:
   * a valid, unexpired invite still admits the signup. Ignored when
   * registration is open.
   */
  inviteToken: z.string().max(80).optional(),
});

export const loginPasswordSchema = z.object({
  email: z.string().trim().min(1, "Email or username required"),
  password: z.string().min(1),
  clientTransport: clientTransportSchema.optional(),
});

/** `POST /api/auth/passkey/login-options`: an optional body, web client only. */
export const passkeyLoginOptionsSchema = z
  .object({ clientTransport: clientTransportSchema.optional() })
  .meta({
    id: "PasskeyLoginOptionsRequest",
    description:
      "Optional. The web client sends its page transport so a sign-in that could not keep its cookie is refused before a challenge is issued. Any other caller may send no body at all.",
  });

export const profileSchema = z.object({
  email: z.email("Invalid email address").nullable().optional(),
  heightCm: z.number().min(50).max(300).nullable().optional(),
  dateOfBirth: z.string().nullable().optional(), // ISO date string
  // Three stored values, and the same clearing contract every other
  // profile field honours: null OR an empty string clears it. A client
  // that renders "no answer" as "" was otherwise 422'd on a field the
  // person never touched, and because the whole profile PATCH is one
  // transaction that rejection took every sibling change with it. The
  // message names the field and the accepted values — a person should
  // never read the validator's own prose off a form.
  gender: z.preprocess(
    (v) => (v === "" ? null : v),
    z
      .enum(["MALE", "FEMALE", "OTHER"], {
        error:
          "Gender must be MALE, FEMALE or OTHER. Send null or an empty string to clear it.",
      })
      .nullable()
      .optional(),
  ),
  // v1.7.0 — optional patient-identity fields for the health-record
  // export cover + FHIR Patient resource. All optional, never required.
  fullName: z.string().trim().max(120).nullable().optional(),
  insurerName: z.string().trim().max(120).nullable().optional(),
  // German KVNR. Empty string / null clears it; a non-empty value must
  // pass the mod-10 check-digit validation. Normalised (whitespace
  // stripped + uppercased) before the refine runs.
  insuranceNumber: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      if (v === null || v === undefined) return v;
      const cleaned = normaliseKvnr(v);
      return cleaned.length === 0 ? null : cleaned;
    })
    .refine((v) => v === null || v === undefined || isValidKvnr(v), {
      message: "Invalid insurance number (KVNR)",
    }),
  // v1.8.6 — German insurer institution number (IKNR). Optional;
  // empty string / null clears it. A non-empty value is trimmed and
  // must be exactly 9 digits (no checksum — the IKNR carries a mod-10
  // check digit but we deliberately do not enforce it here, mirroring
  // the iOS client contract). Surfaced on the FHIR `Coverage` payor.
  insurerIkNumber: z
    .string()
    .max(32)
    .nullable()
    .optional()
    .transform((v) => {
      if (v === null || v === undefined) return v;
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    })
    .refine((v) => v === null || v === undefined || /^[0-9]{9}$/.test(v), {
      message: "Invalid insurer IK number (expected 9 digits)",
    }),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(
        PASSWORD_MIN_LENGTH,
        `New password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      ),
    confirmPassword: z.string().min(1, "Password confirmation is required"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/**
 * Rename a registered passkey — a PRIMARY sign-in credential, not the
 * second-factor security key `mfaWebauthnRenameSchema` covers. The two carry
 * the same label constraint and are served by different routes; they share the
 * constraint rather than the schema so neither surface can drift the other.
 */
export const passkeyRenameSchema = z.object({ name: webauthnKeyNameSchema });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginPasswordInput = z.infer<typeof loginPasswordSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
