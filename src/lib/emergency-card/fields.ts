/**
 * The items an emergency card can show (v1.49). Mirrors the Prisma enum
 * `EmergencyCardField` one for one; the order is the card's reading order:
 * who the card is about, then what a first responder needs first.
 */
import { z } from "zod/v4";

export const EMERGENCY_CARD_FIELDS = [
  "NAME",
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
 * responder acts on. The name, the birth date, the note and the declarations
 * are left for the owner to add on purpose: a lost printed card should not
 * name its owner unless they chose that.
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

/**
 * What an Apple Wallet pass ticks first (v1.50): the link's items and the
 * name, which is the pass's title. The owner can untick it.
 */
export const DEFAULT_WALLET_FIELDS: readonly EmergencyCardField[] = [
  "NAME",
  ...DEFAULT_LINK_FIELDS,
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

/** `POST /api/emergency-card/wallet/apple`: make the record's Wallet pass. */
export const emergencyWalletAppleCreateSchema = z
  .object({
    fields: z.array(emergencyCardFieldSchema).min(1).max(20),
    /** Days until the pass's link stops working; omitted or null lasts until withdrawn. */
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(EMERGENCY_LINK_MAX_DAYS)
      .nullable()
      .optional(),
    /**
     * The version of the signing-service sentence the owner accepted. Must
     * be the server's current one when the project's service signs; any
     * value when the operator signs with their own Pass Type ID.
     */
    consentTextVersion: z.string().max(20),
  })
  .strict();
