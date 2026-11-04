import { z } from "zod/v4";

import { GARMIN_KEY_VALIDITY_DAYS } from "@/lib/garmin/key-expiry";

/**
 * `POST /api/garmin/connect`. The key is what Garmin Connect shows once when
 * it is created (Settings, Personal API). It is trimmed before use: a copy
 * button's trailing newline would otherwise reach Garmin and answer as a
 * refused key. `validityDays` is the validity picked at creation; Garmin
 * does not report it, so it is the only way to warn ahead of the end until
 * the key's last day gives it away.
 */
export const garminConnectSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(16, "The Garmin key is too short")
    .max(1024, "The Garmin key is too long")
    .regex(/^\S+$/, "The Garmin key cannot contain spaces"),
  validityDays: z
    .union(GARMIN_KEY_VALIDITY_DAYS.map((d) => z.literal(d)))
    .nullable()
    .optional(),
});

export type GarminConnectInput = z.infer<typeof garminConnectSchema>;
