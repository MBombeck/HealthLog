import { z } from "zod/v4";

import { GARMIN_KEY_VALIDITY_DAYS } from "@/lib/garmin/key-expiry";
import { isCalendarDateKey } from "@/lib/tz/date-only";

const validityDays = z
  .union(GARMIN_KEY_VALIDITY_DAYS.map((d) => z.literal(d)))
  .nullable()
  .optional();

/**
 * `POST /api/garmin/connect`. The key is what Garmin Connect shows once when
 * it is created (Settings, Personal API). It is trimmed before use: a copy
 * button's trailing newline would otherwise reach Garmin and answer as a
 * refused key. `region` picks the one Garmin service the key is sent to:
 * Garmin Connect, or Garmin's separate service for accounts in China; the
 * key never goes to the other. `validityDays` is the validity picked at
 * creation; Garmin does not report it, so it is the only way to warn ahead
 * of the end until the key's last day gives it away.
 */
export const garminConnectSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(16, "The Garmin key is too short")
    .max(1024, "The Garmin key is too long")
    .regex(/^\S+$/, "The Garmin key cannot contain spaces"),
  region: z.enum(["global", "china"]).optional().default("global"),
  validityDays,
});

export type GarminConnectInput = z.infer<typeof garminConnectSchema>;

/**
 * `PATCH /api/garmin/key-expiry`: correct the validity of the stored key
 * without pasting it again. `createdOn` is the day the key was created in
 * Garmin Connect (the validity counts from there); omitted, it counts from
 * the day the key was connected here. `validityDays: null` forgets the
 * estimate.
 */
export const garminKeyExpirySchema = z.object({
  validityDays,
  createdOn: z
    .string()
    .refine(isCalendarDateKey, "createdOn must be a calendar date (YYYY-MM-DD)")
    .optional(),
});
