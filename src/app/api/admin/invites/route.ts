/**
 * GET  /api/admin/invites — list all registration invites.
 * POST /api/admin/invites — mint a new invite token.
 *
 * v1.15.20 — closed-registration invite flow. The raw `hlv_<hex>` token
 * appears EXACTLY ONCE: in the POST response, alongside the composed
 * registration URL. Only the HMAC-SHA256 hash is persisted (the
 * `ApiToken` scheme), so neither the GET list nor a database leak can
 * reproduce a usable invite.
 *
 * Both verbs are `requireAdmin()` — cookie-only by construction; a
 * Bearer token can never mint or enumerate invites.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { hashToken } from "@/lib/auth/hmac";
import { buildInviteUrl, generateInviteToken } from "@/lib/auth/invite-token";
import { inviteCreateSchema } from "@/lib/validations/invite";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.invites.list" } });

  const invites = await prisma.inviteToken.findMany({
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      usedAt: true,
      revokedAt: true,
      uses: true,
      maxUses: true,
      creator: { select: { id: true, username: true } },
      consumer: { select: { id: true, username: true } },
      // v1.16.0 — full per-signup history. `consumer` only carries the
      // LAST account; multi-use invites list every admitted signup here.
      redemptions: {
        select: {
          id: true,
          redeemedAt: true,
          user: { select: { id: true, username: true, email: true } },
        },
        orderBy: { redeemedAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return apiSuccess(invites);
});

export const POST = apiHandler(async (req: Request) => {
  const { user } = await requireAdmin();

  const parsed = await parseJsonBody(req, inviteCreateSchema, {
    maxBytes: 16 * 1024,
    input: (body) => body ?? {},
  });
  if (!parsed.ok) return parsed.error;

  const { expiresInDays, maxUses } = parsed.data;
  const rawToken = generateInviteToken();
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const invite = await prisma.inviteToken.create({
    data: {
      tokenHash: hashToken(rawToken),
      createdBy: user.id,
      expiresAt,
      maxUses,
    },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      uses: true,
      maxUses: true,
    },
  });

  // The audit row carries metadata only — never the raw token.
  await auditLog("admin.invite.created", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { inviteId: invite.id, expiresInDays, maxUses },
  });

  annotate({
    action: { name: "admin.invite.created" },
    meta: { expiresInDays, maxUses },
  });

  return apiSuccess(
    {
      ...invite,
      // Shown exactly once. Neither value is persisted in plaintext.
      token: rawToken,
      url: buildInviteUrl(rawToken, req.url),
    },
    201,
  );
});
