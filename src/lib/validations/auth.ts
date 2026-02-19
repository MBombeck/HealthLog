import { z } from "zod/v4";

export const registerSchema = z.object({
  username: z
    .string()
    .min(3, "Mindestens 3 Zeichen")
    .max(30, "Maximal 30 Zeichen")
    .regex(/^[a-zA-Z0-9_-]+$/, "Nur Buchstaben, Zahlen, _ und -"),
  password: z.string().optional(),
});

export const loginPasswordSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const profileSchema = z.object({
  heightCm: z.number().min(50).max(300).nullable().optional(),
  dateOfBirth: z.string().nullable().optional(), // ISO date string
  gender: z.enum(["MALE", "FEMALE"]).nullable().optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginPasswordInput = z.infer<typeof loginPasswordSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
