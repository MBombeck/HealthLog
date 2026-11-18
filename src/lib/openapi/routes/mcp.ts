/**
 * OpenAPI route table — MCP connector credentials.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * body comes from `src/lib/validations/mcp.ts` so the wire contract stays
 * single-source; the response DTOs mirror the handlers under
 * `src/app/api/mcp/*`.
 *
 * Two credential families reach the `/mcp` endpoint and both are managed here,
 * because a user revoking access needs one place that lists everything that can
 * read their record over MCP:
 *
 *   - A **connection** is what the OAuth bridge (`/api/mcp/oauth/*`) creates
 *     for a remote connector. It outlives the 60-minute access tokens it
 *     issues, so revoking the connection ends the whole refresh chain.
 *   - A **connector token** is the manual / stdio path: a `hlk_` Bearer minted
 *     here, scoped `health:read` (optionally plus `health:write`), never the
 *     `["*"]` wildcard.
 *
 * The OAuth routes themselves are deliberately absent: they answer RFC-format
 * error bodies rather than the standard envelope, and they are described by the
 * OAuth metadata documents, not by this contract.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { createMcpTokenSchema } from "@/lib/validations/mcp";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";
import { isoDateTime } from "@/lib/validations/datetime";

/**
 * The operator kill switch. `isApiGloballyEnabled()` gates every route in this
 * module, so an instance with the API turned off refuses connector management
 * as well as connector traffic — a valid session does not get past it.
 */
const apiDisabledResponse = {
  "403": {
    description:
      "The operator has disabled the API instance-wide. Every route in this module refuses while that setting is off, for a cookie session as well as for a Bearer token; it is not a per-user permission and retrying will not help.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const mcpConnection = z
  .object({
    id: z.string(),
    clientName: z
      .string()
      .describe(
        "Name the OAuth client registered itself under. Client-supplied at registration time — display it as such, do not treat it as verified.",
      ),
    scope: z
      .string()
      .describe("Space-separated scope string granted to this connection."),
    createdAt: isoDateTime(),
    lastUsedAt: isoDateTime()
      .nullable()
      .describe("Null when the connection has never been exercised."),
  })
  .meta({
    id: "McpConnection",
    description:
      "A live remote-connector authorization created through the MCP OAuth bridge. Carries no token material: the access tokens it issued are not addressable here, they are ended by revoking the connection.",
  });

const mcpConnectorToken = z
  .object({
    id: z.string(),
    name: z.string(),
    permissions: z
      .array(z.string())
      .describe(
        'The granted scopes — `["health:read"]` or `["health:read", "health:write"]`. A `health:write` token is audience-bound to `/mcp`: the resource-server guard refuses it on every REST write, so it only admits the confirmed in-process write tools.',
      ),
    lastUsedAt: isoDateTime().nullable(),
    expiresAt: isoDateTime().nullable(),
    createdAt: isoDateTime(),
    revoked: z
      .boolean()
      .describe(
        "Revoked tokens stay in this list rather than disappearing from it, so a client must filter if it wants live credentials only.",
      ),
  })
  .meta({
    id: "McpConnectorToken",
    description:
      "A manually-minted MCP connector token. The token VALUE is not part of this shape — it exists in one response only, the 201 that mints it.",
  });

const createMcpTokenRequest = createMcpTokenSchema.meta({
  id: "CreateMcpTokenRequest",
  description:
    "Mint a connector Bearer. `scope` is a closed two-value choice, not a permission list: `read` (the default) grants `health:read`, `read_write` adds `health:write`. The permission array is built field by field from that choice, so no request shape can widen the grant. `expiresInDays` defaults to 90.",
});

const createMcpTokenResponse = z
  .object({
    token: z
      .string()
      .describe(
        "The raw `hlk_` Bearer, RETURNED EXACTLY ONCE. It is stored only as an HMAC-SHA256 hash, so there is no way to retrieve it later; a client that does not capture it here has to mint a replacement. Treat it as a secret in logs, crash reports and analytics.",
      ),
    name: z.string(),
    expiresAt: isoDateTime(),
  })
  .meta({
    id: "CreateMcpTokenResponse",
    description:
      "The one response in the API that carries a usable Bearer token value for an MCP connector.",
  });

export const mcpPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/mcp/connections": {
    get: {
      tags: ["MCP"],
      summary: "List the caller's live MCP connector connections",
      description:
        "Returns the caller's non-revoked OAuth-bridge connections, newest first. `data` is the array itself, not nested under a named key. Auth via cookie or Bearer.",
      responses: {
        ...apiDisabledResponse,
        "200": {
          description: "Live connections.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(mcpConnection),
                "McpConnectionListEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mcp/connections/{id}": {
    delete: {
      tags: ["MCP"],
      summary: "Revoke an MCP connector connection",
      description:
        "Stamps the connection revoked so every future refresh fails, and revokes every access token it ever issued. Ownership is enforced inside the revoke, so a connection id alone cannot reach somebody else's connection — an id the caller does not own is indistinguishable from one that does not exist. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Connection id from the list endpoint.",
        },
      ],
      responses: {
        ...apiDisabledResponse,
        "200": {
          description: "The connection was revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.literal(true) }),
                "McpConnectionRevokeEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No live connection with this id for this caller — also the answer for an already-revoked one, so a repeat revoke is 404 rather than an idempotent 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mcp/tokens": {
    get: {
      tags: ["MCP"],
      summary: "List the caller's MCP connector tokens",
      description:
        "Returns the caller's manually-minted `health:read` tokens, newest first, revoked ones included. Access tokens issued by the OAuth bridge are excluded — they are transient 60-minute rows that would flood the list, and they are surfaced and revoked as connections instead. `data` is the array itself, not nested under a named key. Auth via cookie or Bearer.",
      responses: {
        ...apiDisabledResponse,
        "200": {
          description: "Connector tokens.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(mcpConnectorToken),
                "McpConnectorTokenListEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["MCP"],
      summary: "Mint an MCP connector token",
      description:
        "Mints a `health:read` (optionally read+write) Bearer for the manual / stdio path and audits the mint. THE RESPONSE CARRIES THE RAW TOKEN — this is the only place it ever exists, and it cannot be retrieved again. Body capped at 16 KiB. Auth via cookie or Bearer. A browser session needs a fresh proof as well as a live one: a sign-in or `POST /api/auth/reproof` within the last five minutes (with a second factor, on an account that has one). Without it the answer is 401 `auth.reproof.required`, with `meta.methods` naming the proofs the account can give. A Bearer caller on an account that holds a second factor or a passkey sends an `X-Step-Up` elevation minted from a second-factor or passkey proof (`POST /api/auth/step-up`); without one the answer is 401 `auth.stepup.required` and no token is minted. The elevation is spent right before the mint. A Bearer caller on an account holding neither (an SSO-only account, typically) has nothing to prove in the app and mints on its token.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMcpTokenRequest } },
      },
      responses: {
        ...apiDisabledResponse,
        "201": {
          description:
            "Token minted. The `token` field is the only copy of the secret.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                createMcpTokenResponse,
                "CreateMcpTokenEnvelope",
              ),
            },
          },
        },
        "400": {
          description: "Body is not parseable JSON.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 16 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "Content-Type is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "Validation failed. The envelope carries every offending issue, not just the first.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/mcp/tokens/{id}": {
    delete: {
      tags: ["MCP"],
      summary: "Revoke an MCP connector token",
      description:
        "Marks the token revoked and audits it. The lookup requires the token to be the caller's own AND to carry `health:read`, so this endpoint can never revoke a differently-scoped credential by id alone — a native-client or ingest token is a 404 here. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Token id from the list endpoint.",
        },
      ],
      responses: {
        ...apiDisabledResponse,
        "200": {
          description: "The token was revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.literal(true) }),
                "McpConnectorTokenRevokeEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No `health:read` token with this id for this caller. An already-revoked token is still found, so a repeat revoke answers 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
