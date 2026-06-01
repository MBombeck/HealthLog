/**
 * v1.5.5 — owner-scoped avatar GET.
 *
 *  GET /api/user/avatar/{userId}
 *
 * Serves the avatar bytes the user uploaded through POST
 * /api/user/avatar. Owner-scoped — `requireAuth()` resolves the
 * caller's id and the `userId` path param must match. Public-by-
 * default would expose an authenticated user's avatar to anyone who
 * guessed (or scraped) the cuid; HealthLog is single-tenant per
 * user, so cross-user reads are a privacy hole even if the bytes
 * themselves look innocuous.
 *
 * 200 returns the raw image bytes with the persisted `Content-Type`
 * (`image/jpeg` / `image/png` / `image/webp`) and a `Cache-Control`
 * that lets the client cache aggressively — the /me payload appends
 * `?v={updatedAtMs}` so a re-upload flips the URL and the next
 * paint round-trips.
 *
 * 404 fires when the user row has no avatar; the client paints the
 * username-initials fallback.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = apiHandler(async (_request: Request, ctx: Context) => {
  const { user } = await requireAuth();
  const { id } = await ctx.params;

  // Owner-scope. A cookie session and a Bearer token both arrive
  // through `requireAuth()`; the id-match below covers both. There
  // is no admin-elevation path here (admin avatars are not a
  // server-side ops concern).
  if (id !== user.id) {
    annotate({
      action: { name: "user.avatar.get.forbidden" },
    });
    return apiError("Forbidden", 403);
  }

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      avatarBytes: true,
      avatarContentType: true,
      avatarUpdatedAt: true,
    },
  });

  if (!row?.avatarBytes || !row.avatarContentType) {
    return apiError("Avatar not found", 404);
  }

  annotate({
    action: { name: "user.avatar.get" },
    meta: {
      contentType: row.avatarContentType,
      size: row.avatarBytes.length,
    },
  });

  // The /me payload carries `?v={updatedAtMs}` on the URL so the
  // browser cache invalidates on every re-upload. The bytes
  // themselves are stable for the lifetime of that URL.
  return new NextResponse(row.avatarBytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": row.avatarContentType,
      "Content-Length": String(row.avatarBytes.length),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});
