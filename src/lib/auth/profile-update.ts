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
import { z } from "zod/v4";

const extendedProfileSchema = profileSchema.extend({
  displayName: z.string().min(1).max(80).nullable().optional(),
  locale: z.enum(["de", "en"]).nullable().optional(),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidTimezone, "Invalid IANA timezone")
    .optional(),
  moodReminderEnabled: z.boolean().optional(),
});

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
    moodReminderEnabled: boolean;
    // v1.7.0 — patient-identity fields. `insuranceNumber` is returned in
    // plaintext (decrypted on read by the route) so the client can render
    // the value back into the form; the route is responsible for the read
    // decryption. Here we only echo the two plaintext columns and a
    // boolean presence flag for the encrypted KVNR.
    fullName: string | null;
    insurerName: string | null;
    hasInsuranceNumber: boolean;
  };
}

export interface ApplyProfileError {
  ok: false;
  status: number;
  message: string;
}

/**
 * Validate and persist profile updates for `userId`. Returns either an
 * `ApplyProfileResult` on success or `ApplyProfileError` with a status
 * code so callers can shape the wire response themselves.
 */
export async function applyProfileUpdate(
  userId: string,
  body: unknown,
  ipAddress?: string | null,
): Promise<ApplyProfileResult | ApplyProfileError> {
  const parsed = extendedProfileSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 422,
      message: parsed.error.issues[0]?.message ?? "Validation error",
    };
  }

  const data = parsed.data;
  const normalizedEmail = data.email ? data.email.trim().toLowerCase() : null;

  if (data.email !== undefined && normalizedEmail) {
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existing && existing.id !== userId) {
      return { ok: false, status: 409, message: "Email already in use" };
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
      moodReminderEnabled: updatedUser.moodReminderEnabled,
      fullName: updatedUser.fullName,
      insurerName: updatedUser.insurerName,
      hasInsuranceNumber: updatedUser.insuranceNumberEncrypted != null,
    },
  };
}
