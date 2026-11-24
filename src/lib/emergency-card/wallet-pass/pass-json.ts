/**
 * The `pass.json` an emergency-card pass may have (v1.50): a closed schema of
 * exactly the keys the builder writes, and the field limits of both styles.
 *
 * The builder's output is parsed against it before anything is bundled, so a
 * key that is not here (`locations`, `relevantDates`, `nfc`, `userInfo`,
 * `appLaunchURL`, a second barcode) can never reach a pass by accident, and a
 * layout change that would overflow a style throws in a test instead of
 * being cut by Wallet on a phone.
 *
 * One `pass.json` carries two styles: `posterGeneric` (iOS 27, a full-bleed
 * artwork with a material strip at the bottom) and `generic` (every older
 * system and the Watch), which Wallet falls back to when it does not know
 * the poster style.
 */
import { z } from "zod/v4";

const fieldKey = z.string().regex(/^[a-z][a-z0-9_]*$/);
const iso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "W3C date, UTC");

export const passFieldSchema = z
  .object({
    key: fieldKey,
    label: z.string().min(1).optional(),
    value: z.string().min(1),
    attributedValue: z.string().optional(),
    dateStyle: z.literal("PKDateStyleMedium").optional(),
    ignoresTimeZone: z.literal(true).optional(),
    dataDetectorTypes: z
      .array(z.literal("PKDataDetectorTypePhoneNumber"))
      .optional(),
  })
  .strict();

export type PassField = z.infer<typeof passFieldSchema>;

const fields = z.array(passFieldSchema);

/** Field limits per style and area (Apple, and one footer field on posters). */
export const FIELD_LIMITS = {
  poster: { headerFields: 1, primaryFields: 4, footerFields: 1 },
  generic: { headerFields: 3, primaryFields: 1, secondaryAndAuxiliary: 4 },
} as const;

const rgb = z.string().regex(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);

export const walletPassJsonSchema = z
  .object({
    formatVersion: z.literal(1),
    passTypeIdentifier: z.string().regex(/^pass\.[A-Za-z0-9.-]+$/),
    teamIdentifier: z.string().regex(/^[A-Z0-9]{10}$/),
    serialNumber: z.uuid(),
    authenticationToken: z.string().regex(/^[0-9a-f]{64}$/),
    webServiceURL: z
      .url({ protocol: /^https$/ })
      .endsWith("/api/wallet/apple/"),
    organizationName: z.string().min(1),
    description: z.string().min(1),
    logoText: z.string().min(1),
    sharingProhibited: z.literal(true),
    expirationDate: iso.optional(),
    voided: z.boolean(),
    backgroundColor: rgb,
    foregroundColor: rgb,
    labelColor: rgb,
    footerBackgroundColor: rgb,
    barcodes: z
      .array(
        z
          .object({
            format: z.literal("PKBarcodeFormatQR"),
            message: z.url({ protocol: /^https$/ }),
            messageEncoding: z.literal("iso-8859-1"),
            altText: z.string().min(1),
          })
          .strict(),
      )
      .length(1)
      .optional(),
    featuredActions: z
      .array(
        z
          .object({
            identifier: z.literal("ice"),
            type: z.literal("call"),
            url: z.string().regex(/^tel:\+?\d{6,15}$/),
          })
          .strict(),
      )
      .max(1)
      .optional(),
    posterGeneric: z
      .object({
        headerFields: fields.max(FIELD_LIMITS.poster.headerFields),
        primaryFields: fields.min(1).max(FIELD_LIMITS.poster.primaryFields),
        footerFields: fields.max(FIELD_LIMITS.poster.footerFields),
        additionalInfoFields: fields,
      })
      .strict(),
    generic: z
      .object({
        headerFields: fields.max(FIELD_LIMITS.generic.headerFields),
        primaryFields: fields.min(1).max(FIELD_LIMITS.generic.primaryFields),
        secondaryFields: fields,
        auxiliaryFields: fields,
        backFields: fields,
      })
      .strict()
      .refine(
        (g) =>
          g.secondaryFields.length + g.auxiliaryFields.length <=
          FIELD_LIMITS.generic.secondaryAndAuxiliary,
        "generic: at most four secondary and auxiliary fields together",
      ),
  })
  .strict();

export type WalletPassJson = z.infer<typeof walletPassJsonSchema>;

/** Parse the builder's output; throws with every issue on a bad pass. */
export function assertWalletPassJson(value: unknown): WalletPassJson {
  const parsed = walletPassJsonSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `pass.json does not hold: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}
