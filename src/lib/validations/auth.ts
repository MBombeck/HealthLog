import { z } from "zod/v4";

/** Minimum password length — must match checkPasswordStrength() in @/lib/auth/password.ts */
const PASSWORD_MIN_LENGTH = 12;

export const registerSchema = z.object({
  email: z.email("Invalid email address"),
  username: z
    .string()
    .min(3, "At least 3 characters")
    .max(30, "Maximum 30 characters")
    .regex(/^[a-zA-Z0-9_-]+$/, "Only letters, numbers, _ and -"),
  password: z
    .string()
    .min(
      PASSWORD_MIN_LENGTH,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    ),
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
});

export const loginPasswordSchema = z.object({
  email: z.string().trim().min(1, "Email or username required"),
  password: z.string().min(1),
});

export const profileSchema = z.object({
  email: z.email("Invalid email address").nullable().optional(),
  heightCm: z.number().min(50).max(300).nullable().optional(),
  dateOfBirth: z.string().nullable().optional(), // ISO date string
  gender: z.enum(["MALE", "FEMALE"]).nullable().optional(),
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

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginPasswordInput = z.infer<typeof loginPasswordSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
