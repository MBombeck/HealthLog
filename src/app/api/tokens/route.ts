/**
 * `/api/tokens` — list and (via `[id]`) revoke a user's API tokens.
 *
 * The generic mint that used to live here (`POST`, minting
 * `["medication:ingest"]`) was removed alongside the fail-closed scope
 * default. That token could never do its advertised job — the external ingest
 * surface gates on the per-medication `medication:<id>:ingest` grant, which
 * this endpoint never issued — while the old fail-open default let it reach
 * every other authenticated route. The working credential is minted by the
 * per-medication API-endpoint toggle
 * (`/api/medications/[id]/api-endpoint`), which issues both grants.
 *
 * Listing and revoking stay so existing tokens remain visible and revocable.
 *
 * The list is NOT gated on the instance-wide API switch, and the revoke is.
 * The asymmetry is deliberate, and rests on what the switch actually does:
 * `AppSettings.apiGlobal` gates the surfaces a token is FOR — external
 * medication ingest, the MCP bridge — and not the token's ability to
 * authenticate. Nothing on the `requireAuth` path consults it. So a token
 * minted before an operator flipped the switch is still a live credential
 * while it is off, and refusing the list hid exactly the credentials their
 * owner most needed to see. Answering "which credentials exist on your own
 * account" is never the unsafe half of this surface: it discloses no token
 * material, and it is how a person finds the row to kill.
 *
 * The revoke keeps the gate as the surface stands. Whether the switch should
 * also stop an owner killing a live token is a question about what the switch
 * means, not a property of the read, so it is left where it was.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "tokens.list" } });

  const tokens = await prisma.apiToken.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      name: true,
      permissions: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
      revoked: true,
      // A measurement token's Apple Health write-back (#1272); false for
      // every other token.
      mirrorToAppleHealth: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return apiSuccess(tokens);
});
