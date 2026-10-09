/**
 * v1.42 (#959) — the bodies the managed-profile handover accepts.
 *
 * Four requests, all `.strict()`: a Guardian minting the link, the anonymous
 * preview and claim on the far side of it, and the new owner's decision about
 * each former Guardian afterwards. The OpenAPI table publishes these exact
 * schemas, so they live here once rather than beside each route.
 */
import { z } from "zod/v4";

import { HANDOVER_ACCESS_LEVELS } from "@/lib/managed-profiles/handover-access";
import {
  accountUsernameSchema,
  newAccountPasswordSchema,
} from "@/lib/validations/auth";

/** What a Guardian's access becomes after the handover. */
export const handoverAccessSchema = z.enum(HANDOVER_ACCESS_LEVELS);

/**
 * A grant id as the server minted it (cuid). Bounded so a body cannot carry a
 * megabyte of identifiers into a lookup.
 */
const grantIdSchema = z.string().min(1).max(64);

/**
 * At most one entry per Guardian, and a profile has a handful. The cap is a
 * body-size floor rather than a product rule.
 */
const MAX_GUARDIAN_ENTRIES = 50;

/** `POST /api/managed-profiles/{id}/handover`. */
export const createHandoverSchema = z
  .object({
    // How long the link stays valid, in days: seven unless the Guardian
    // chooses one or fourteen.
    expiresInDays: z
      .union([z.literal(1), z.literal(7), z.literal(14)])
      .default(7),
    proposals: z
      .array(
        z
          .object({ grantId: grantIdSchema, proposal: handoverAccessSchema })
          .strict(),
      )
      .max(MAX_GUARDIAN_ENTRIES)
      .default([])
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.grantId)).size ===
          entries.length,
        { message: "Name each guardian once" },
      ),
  })
  .strict();

/**
 * The token field of the two anonymous requests. Shape-bounded here only to
 * keep the body small; the `hlp_` shape itself is checked by the service so
 * that a malformed token and an unknown one answer identically.
 */
const claimTokenSchema = z.string().min(1).max(80);

/** `POST /api/auth/claim/preview`. */
export const claimPreviewSchema = z
  .object({ token: claimTokenSchema })
  .strict();

/** `POST /api/auth/claim`. */
export const claimSchema = z
  .object({
    token: claimTokenSchema,
    username: accountUsernameSchema,
    email: z.email("Invalid email address").max(254),
    password: newAccountPasswordSchema.max(1024),
  })
  .strict();

/** `POST /api/account/handover-decision`. */
export const handoverDecisionSchema = z
  .object({
    decisions: z
      .array(
        z
          .object({ grantId: grantIdSchema, access: handoverAccessSchema })
          .strict(),
      )
      .max(MAX_GUARDIAN_ENTRIES)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.grantId)).size ===
          entries.length,
        { message: "Name each guardian once" },
      ),
  })
  .strict();
