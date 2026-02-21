import { z } from "zod/v4";

export const registerSchema = z.object({
  email: z.email("Ungültige E-Mail-Adresse"),
  username: z
    .string()
    .min(3, "Mindestens 3 Zeichen")
    .max(30, "Maximal 30 Zeichen")
    .regex(/^[a-zA-Z0-9_-]+$/, "Nur Buchstaben, Zahlen, _ und -"),
  password: z.string().min(1, "Passwort ist erforderlich"),
});

export const loginPasswordSchema = z.object({
  email: z.string().trim().min(1, "E-Mail oder Benutzername erforderlich"),
  password: z.string().min(1),
});

export const profileSchema = z.object({
  email: z.email("Ungültige E-Mail-Adresse").nullable().optional(),
  heightCm: z.number().min(50).max(300).nullable().optional(),
  dateOfBirth: z.string().nullable().optional(), // ISO date string
  gender: z.enum(["MALE", "FEMALE"]).nullable().optional(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Aktuelles Passwort ist erforderlich"),
    newPassword: z.string().min(1, "Neues Passwort ist erforderlich"),
    confirmPassword: z.string().min(1, "Passwort-Bestätigung ist erforderlich"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Neue Passwörter stimmen nicht überein",
    path: ["confirmPassword"],
  });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginPasswordInput = z.infer<typeof loginPasswordSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
