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
  emergencyWalletAppleCreateSchema,
  emergencyWalletBodySchema,
} from "@/lib/emergency-card/fields";
import {
  WALLET_CREATE_PATH,
  WALLET_DOWNLOAD_PATH,
  WALLET_STATES,
  WALLET_UNAVAILABLE_REASONS,
} from "@/lib/emergency-card/wallet-pass/constants";
import {
  advanceDirectiveStatusSchema,
  emergencyBloodTypeSchema,
  organDonorStatusSchema,
} from "@/lib/validations/emergency-profile";
import { isoDateTime } from "@/lib/validations/datetime";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
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

const editTarget = z
  .string()
  .nullable()
  .describe(
    "An in-app path, or null when the surface that owns the line is switched off.",
  );

const emergencyCardTargets = z
  .object({
    fields: z
      .record(emergencyCardFieldSchema, editTarget)
      .describe("Where each item is edited."),
    conditions: z
      .array(editTarget)
      .describe(
        "One per `card.conditions` line, in order: the illness episode, or the medical history for the written note.",
      ),
    medications: z
      .array(editTarget)
      .describe("One per `card.medications` line, in order: the medication."),
  })
  .meta({
    id: "EmergencyCardTargets",
    description:
      "Where the owner edits each line of the card: the surface that owns it. Added in v1.50. Only the owner's read carries it; the read-only link never does.",
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

const walletPassSummary = z
  .object({
    serialNumber: z
      .string()
      .describe("The pass's serial number, as PassKit knows it."),
    state: z
      .enum(["live", "voided", "expired"])
      .describe(
        "`voided`: withdrawn, its link answers 404 and the download is the withdrawn version. `expired`: past `expiresAt`; Wallet greys it out itself.",
      ),
    fields: z
      .array(emergencyCardFieldSchema)
      .describe("The items frozen on the pass at creation."),
    createdAt: isoDateTime(),
    contentChangedAt: isoDateTime().describe(
      "When the pass's content last changed. A client that stored an older value downloads the pass again and replaces it.",
    ),
    expiresAt: isoDateTime().nullable(),
    voidedAt: isoDateTime().nullable(),
    voidReason: z
      .enum([
        "owner",
        "credential_reset",
        "handover",
        "guardian_lost",
        "account_deletion",
      ])
      .nullable()
      .describe(
        "Why the pass was withdrawn: on the card page, after a password change or reset, at a managed profile's handover, when a guardian lost the right to it, or at a deletion request. Null while it is live. Decode unknown values leniently.",
      ),
    lastFetchedAt: isoDateTime()
      .nullable()
      .describe("The last download by a device, Wallet or the app."),
    downloadPath: z.literal(WALLET_DOWNLOAD_PATH),
  })
  .meta({
    id: "EmergencyWalletPassSummary",
    description:
      "The record's Apple Wallet pass without its secrets: never the link, never the authentication token.",
  });

/** `emergencyCard.wallet.apple` on `/api/auth/me`, and the status route. */
export const emergencyWalletAppleSchema = z
  .object({
    available: z
      .boolean()
      .describe("The server can make a pass for the record on screen now."),
    reason: z
      .enum(["ok", ...WALLET_UNAVAILABLE_REASONS])
      .describe(
        "`signer_off`: neither the project's signing service nor the operator's own Pass Type ID is set up. `relay_not_ready`: the relay is not on, not ok, or does not sign passes now. `no_https_origin`: the instance is not reached over https. `api_disabled`: the operator's external-access switch is off. `not_allowed`: a delegate on an adult's record. Decode unknown values leniently.",
      ),
    state: z
      .enum(WALLET_STATES)
      .describe(
        "`reason` resolved for rendering; render from this. `available`: offer the pass. `relay_off`: the pass would be signed over the push relay, which this server has not switched on; act by `relayAction`. Never sent when the server signs with its own `WALLET_APPLE_*` certificate. `relay_not_ready`: the relay is on but does not sign passes yet (it does within a minute of being switched on, or the relay is degraded); show the action disabled and read again. `not_configured`: no signer at all, nothing to offer. `no_https_origin`, `api_disabled`, `not_allowed`: as in `reason`. Decode unknown values as unavailable.",
      ),
    relayAction: z
      .enum(["enable", "ask_admin"])
      .nullable()
      .describe(
        "Set only with `state: relay_off`. `enable`: the caller is an admin and can switch the relay on in place (`POST /api/admin/push-relay/decision` while the relay question is open, else `PUT /api/admin/push-relay`; both cookie-only, so the app opens `createPath`, where the web card offers it). `ask_admin`: tell the caller that the server's admin has to turn on notifications over the push relay; no button that does nothing. The caller, not the record, decides: a guardian on a ward's record reads their own.",
      ),
    relayHintDismissed: z
      .boolean()
      .describe(
        "The caller said no to the relay prompt (`POST /api/emergency-card/wallet/apple/relay-hint`). Do not prompt unasked; keep the action, which still explains on a tap.",
      ),
    signer: z.enum(["relay", "local"]).nullable(),
    passTypeIdentifier: z.string().nullable(),
    canCreate: z
      .boolean()
      .describe(
        "The caller can make the pass here (a browser session). The app opens `createPath` on the instance instead.",
      ),
    createPath: z.literal(WALLET_CREATE_PATH),
    consentTextVersion: z
      .string()
      .nullable()
      .describe(
        "The signing-service notice the owner accepts on creation; null when the operator signs with their own Pass Type ID.",
      ),
    pass: walletPassSummary.nullable(),
  })
  .meta({
    id: "EmergencyWalletApple",
    description:
      "v1.50. The emergency card in Apple Wallet, resolved by the server for the record on screen. Render it; do not recompute it.",
  });

const walletErrors = (codes: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(codes).map(([status, description]) => [
      status,
      {
        description,
        content: { "application/json": { schema: errorEnvelope } },
      },
    ]),
  );

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
                z.object({
                  card: emergencyCardView,
                  targets: emergencyCardTargets,
                }),
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
  "/api/emergency-card/wallet/apple": {
    get: {
      tags: ["Records"],
      summary: "Apple Wallet pass status",
      description:
        "v1.50. Whether a pass can be made for the record on screen, who would sign it, and the pass it has. Cookie or a full-access token; the same object as `emergencyCard.wallet.apple` on `GET /api/auth/me`.",
      responses: {
        "200": {
          description: "The status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ apple: emergencyWalletAppleSchema }),
                "EmergencyWalletAppleStatus",
              ),
            },
          },
        },
        ...recordRefusal(),
        ...stdResponses,
      },
    },
    post: {
      tags: ["Records"],
      summary: "Make the Apple Wallet pass",
      description:
        "v1.50. Makes the pass and its own `hlm_` link with the ticked items and the optional expiry frozen on it. The response carries where to download it, never the link. Cookie only, with a fresh proof (401 `auth.reproof.required`). The operator's external-access switch off answers 403 `emergency-card.api_disabled`; 10 per account and hour (429 `emergency-card.rateLimited`). Honours `Idempotency-Key`.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: emergencyWalletAppleCreateSchema.meta({
              id: "EmergencyWalletAppleCreate",
            }),
          },
        },
      },
      responses: {
        "201": {
          description: "The new pass.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  pass: walletPassSummary,
                  downloadPath: z.literal(WALLET_DOWNLOAD_PATH),
                }),
                "EmergencyWalletAppleCreated",
              ),
            },
          },
        },
        "409": {
          ...idempotentWrite()["409"],
          description:
            "A pass already exists (`emergency-card.wallet.exists`), Wallet is not available here (`emergency-card.wallet.unavailable`, `meta.reason` as in `EmergencyWalletApple.reason`), or a request with this `Idempotency-Key` is still in progress (`X-Idempotent-Replay: false`; retry shortly).",
        },
        ...walletErrors({
          "422":
            "The body is invalid, or `consentTextVersion` is not the current signing notice (`emergency-card.wallet.consent`).",
        }),
        ...COOKIE_ONLY,
        ...malformedJsonResponse,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Withdraw the Apple Wallet pass",
      description:
        "v1.50. The pass's link answers 404 from now on and the pass downloads in its withdrawn version. The printed card's link is not touched. Cookie only.",
      responses: {
        "200": {
          description: "Withdrawn.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.literal(true) }),
                "EmergencyWalletAppleRevoked",
              ),
            },
          },
        },
        ...walletErrors({
          "404": "No live pass (`emergency-card.wallet.none`).",
        }),
        ...COOKIE_ONLY,
        ...stdResponses,
      },
    },
  },
  "/api/emergency-card/wallet/apple/relay-hint": {
    post: {
      tags: ["Records"],
      summary: "Dismiss the Wallet relay prompt",
      description:
        'v1.50. The caller says no to "Wallet needs the push relay" (`EmergencyWalletApple.state: relay_off`): `relayHintDismissed` becomes true for the caller, on every record they open, and the prompt is not shown unasked again. The action stays. Idempotent. Cookie or a full-access token.',
      responses: {
        "200": {
          description: "Dismissed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ dismissed: z.literal(true) }),
                "EmergencyWalletRelayHintDismissed",
              ),
            },
          },
        },
        ...recordRefusal(),
        ...stdResponses,
      },
    },
  },
  "/api/emergency-card/wallet/apple/pass": {
    get: {
      tags: ["Records"],
      summary: "Download the Apple Wallet pass",
      description:
        "v1.50. The current version of the record's pass, built and signed for this request. A withdrawn pass is served in its withdrawn version so an installed one can be replaced; `HL-Wallet-State` names the version. Cookie or a full-access token. 30 downloads per pass and hour.",
      responses: {
        "200": {
          description: "The signed pass.",
          headers: z.object({
            "HL-Wallet-State": z.enum(["live", "voided", "expired"]),
            "Last-Modified": z.string(),
          }),
          content: { "application/vnd.apple.pkpass": { schema: z.string() } },
        },
        ...walletErrors({
          "404": "The record has no pass (`emergency-card.wallet.none`).",
          "429":
            "Too many downloads of this pass (`emergency-card.rateLimited`).",
          "503":
            "The signer cannot sign right now (`emergency-card.wallet.signer_unavailable`). Retry after `Retry-After` seconds and keep the installed pass.",
        }),
        ...recordRefusal(),
        ...stdResponses,
      },
    },
  },
};
