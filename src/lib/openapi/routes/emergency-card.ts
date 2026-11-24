/**
 * OpenAPI route table — the emergency card (v1.49): the caller's own card,
 * its offline copy and wallet PDF, and the cookie-only management of its
 * read-only `hlm_` link. The anonymous view behind the link is a page
 * (`/e/{token}`), not an API route, so it is not part of this table.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * schemas come from `src/lib/emergency-card/fields.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  emergencyCardFieldSchema,
  emergencyCardLinkCreateSchema,
  emergencyWalletBodySchema,
} from "@/lib/emergency-card/fields";
import {
  advanceDirectiveStatusSchema,
  emergencyBloodTypeSchema,
  organDonorStatusSchema,
} from "@/lib/validations/emergency-profile";
import { isoDateTime } from "@/lib/validations/datetime";

import {
  dataEnvelope,
  errorEnvelope,
  malformedJsonResponse,
  recordRefusal,
  stdResponses,
} from "./shared";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const emergencyCardView = z
  .object({
    fields: z
      .array(emergencyCardFieldSchema)
      .describe("The items the card was read for, in reading order."),
    name: z
      .string()
      .nullable()
      .describe(
        "The record's full name, else its display name; the card's title line. Never the username. Added in v1.50.",
      ),
    bloodType: emergencyBloodTypeSchema.nullable(),
    allergies: z
      .array(
        z.object({
          substance: z.string(),
          severity: z.enum(["MILD", "MODERATE", "SEVERE"]).nullable(),
          reaction: z.string().nullable(),
        }),
      )
      .nullable(),
    conditions: z.array(z.string()).nullable(),
    medications: z
      .array(z.object({ name: z.string(), dose: z.string().nullable() }))
      .nullable(),
    pregnancy: z
      .object({
        state: z.enum(["PREGNANT", "POSTPARTUM"]),
        gestationalWeeks: z.number().int().nullable(),
        gestationalDays: z.number().int().nullable(),
        dueDate: day.nullable(),
        deliveryDate: day.nullable(),
        postpartumWeek: z.number().int().nullable(),
      })
      .nullable(),
    implants: z.string().nullable(),
    contacts: z.string().nullable(),
    advanceDirective: advanceDirectiveStatusSchema.nullable(),
    organDonor: organDonorStatusSchema.nullable(),
    note: z.string().nullable(),
    dateOfBirth: day.nullable(),
    asOf: day.describe("The owner's calendar day the card was read on."),
  })
  .meta({
    id: "EmergencyCardView",
    description:
      "The emergency card. An item is null when the card was not read for it (see `fields`) or it holds nothing. Render these values; do not recompute them.",
  });

const cardLinkSummary = z
  .object({
    tokenPrefix: z
      .string()
      .describe("The first 8 characters of the link's token."),
    fields: z.array(emergencyCardFieldSchema),
    expiresAt: isoDateTime().nullable(),
    createdAt: isoDateTime(),
    lastAccessAt: isoDateTime().nullable(),
    accessCount: z.number().int(),
    expired: z.boolean(),
  })
  .meta({
    id: "EmergencyCardLinkSummary",
    description:
      "The live emergency card link without its secret: never the token hash and never the URL.",
  });

const linkStatus = z.object({ link: cardLinkSummary.nullable() });

const COOKIE_ONLY = recordRefusal(
  "A Bearer caller (`emergency-card.cookie_only`): the link and the downloads are managed over a browser session, on the caller's own record or on a managed profile the caller is guardian of. Making a link while the operator's external-access switch is off answers `emergency-card.api_disabled`.",
);

const NONE_404 = {
  "404": {
    description: "No link is on (`emergency-card.none`).",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

export const emergencyCardPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/emergency-card": {
    get: {
      tags: ["Records"],
      summary: "The caller's emergency card",
      description:
        "Every item of the caller's own emergency card: blood type, active allergies (severe first), ongoing conditions, current medications, the pregnancy or postpartum state, implants, contacts, the declarations, the note and the birth date. The caller's own record, or the managed profile a guardian switched into; a delegate on an adult's record is refused with 403 at every grant level.",
      responses: {
        "200": {
          description: "The card.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ card: emergencyCardView }),
                "EmergencyCardRead",
              ),
            },
          },
        },
        ...recordRefusal(),
        ...stdResponses,
      },
    },
  },
  "/api/emergency-card/offline": {
    get: {
      tags: ["Records"],
      summary: "Download the emergency card for offline use",
      description:
        "The card as one self-contained HTML file (inline styles, no script, no external request), sent as an attachment.",
      responses: {
        "200": {
          description: "The HTML file.",
          content: { "text/html": { schema: z.string() } },
        },
        ...COOKIE_ONLY,
        ...stdResponses,
      },
    },
  },
  "/api/emergency-card/wallet": {
    post: {
      tags: ["Records"],
      summary: "Download the emergency card as a wallet card PDF",
      description:
        "One A4 page with both sides at credit-card size and a fold line. With `token` (the raw token of the caller's own live link, held only right after it was made) the back carries the link's QR code; a token that is not the caller's live link answers 422 `emergency-card.wallet.token`.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: emergencyWalletBodySchema.meta({
              id: "EmergencyWalletRequest",
            }),
          },
        },
      },
      responses: {
        "200": {
          description: "The PDF.",
          content: { "application/pdf": { schema: z.string() } },
        },
        ...COOKIE_ONLY,
        ...malformedJsonResponse,
        ...stdResponses,
      },
    },
  },
  "/api/emergency-card/link": {
    get: {
      tags: ["Records"],
      summary: "Emergency card link status",
      description:
        "The caller's live link without its secret: prefix, the items it shows, its expiry and how often it was opened.",
      responses: {
        "200": {
          description: "The status; `link` is null while no link is on.",
          content: {
            "application/json": {
              schema: dataEnvelope(linkStatus, "EmergencyCardLinkStatus"),
            },
          },
        },
        ...COOKIE_ONLY,
        ...stdResponses,
      },
    },
    post: {
      tags: ["Records"],
      summary: "Make the emergency card link",
      description:
        "Mints an `hlm_` token (192-bit), stores only its HMAC, freezes the ticked items and the optional expiry, and returns the URL EXACTLY ONCE. The link serves `/e/{token}`: a read-only page with the ticked items only, every access audited on the owner's trail. One live link per record: a second answers 409 `emergency-card.exists`. Needs a fresh proof (401 `auth.reproof.required`). Rate-limited per account (10/h).",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: emergencyCardLinkCreateSchema.meta({
              id: "EmergencyCardLinkCreate",
            }),
          },
        },
      },
      responses: {
        "201": {
          description: "The new link, returned exactly once.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ url: z.string(), link: cardLinkSummary }),
                "EmergencyCardLinkMinted",
              ),
            },
          },
        },
        "409": {
          description: "A link is already on (`emergency-card.exists`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...COOKIE_ONLY,
        ...malformedJsonResponse,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Revoke the emergency card link",
      description: "Revokes the link; a scanned card answers 404 from then on.",
      responses: {
        "200": {
          description: "Revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.literal(true) }),
                "EmergencyCardLinkRevoked",
              ),
            },
          },
        },
        ...NONE_404,
        ...COOKIE_ONLY,
        ...stdResponses,
      },
    },
  },
};
