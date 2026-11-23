/**
 * The items an emergency card can show (v1.49). Mirrors the Prisma enum
 * `EmergencyCardField` one for one; the order is the card's reading order,
 * the one a first responder needs first at the top.
 */
import { z } from "zod/v4";

export const EMERGENCY_CARD_FIELDS = [
  "BLOOD_TYPE",
  "ALLERGIES",
  "CONDITIONS",
  "MEDICATIONS",
  "PREGNANCY",
  "IMPLANTS",
  "CONTACTS",
  "ADVANCE_DIRECTIVE",
  "ORGAN_DONOR",
  "NOTE",
  "DATE_OF_BIRTH",
] as const;

export type EmergencyCardField = (typeof EMERGENCY_CARD_FIELDS)[number];

/**
 * What the link form ticks before the owner changes anything: what a first
 * responder acts on. The birth date, the note and the declarations are left
 * for the owner to add on purpose.
 */
export const DEFAULT_LINK_FIELDS: readonly EmergencyCardField[] = [
  "BLOOD_TYPE",
  "ALLERGIES",
  "CONDITIONS",
  "MEDICATIONS",
  "PREGNANCY",
  "IMPLANTS",
  "CONTACTS",
];

/** Longest expiry a link may be given, in days. */
export const EMERGENCY_LINK_MAX_DAYS = 3660;

export const emergencyCardFieldSchema = z.enum(EMERGENCY_CARD_FIELDS);

/** `POST /api/emergency-card/link`. */
export const emergencyCardLinkCreateSchema = z
  .object({
    fields: z.array(emergencyCardFieldSchema).min(1).max(20),
    /** Days until the link stops working; omitted or null lasts until revoked. */
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(EMERGENCY_LINK_MAX_DAYS)
      .nullable()
      .optional(),
  })
  .strict();

/** The ticked items in the card's reading order, each once. */
export function normaliseFields(
  fields: readonly EmergencyCardField[],
): EmergencyCardField[] {
  const picked = new Set(fields);
  return EMERGENCY_CARD_FIELDS.filter((f) => picked.has(f));
}

/** `POST /api/emergency-card/wallet`: the live link's raw token, if in hand. */
export const emergencyWalletBodySchema = z
  .object({ token: z.string().max(80).optional() })
  .strict();
