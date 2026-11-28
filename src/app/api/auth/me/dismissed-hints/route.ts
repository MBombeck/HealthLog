/**
 * The one-time hints the caller has put away.
 *
 *  PATCH /api/auth/me/dismissed-hints — body `{ dismiss?: string[],
 *  restore?: string[] }`, ids from `src/lib/hints/dismissible-hints.ts`.
 *
 * Stored on the account, so a closed hint stays closed on every device and
 * after the browser forgets its storage. Restoring a family restores its
 * members too ("show the checklist again"). The current list is published on
 * `/api/auth/me` as `dismissedHints`, and the answer is the stored list after
 * the change.
 *
 * The per-user-scalar pattern of `show-nav-counts` next door: 60/min rate
 * limit, a 4 KB body cap, Zod safeParse with a 422, an audit row, an explicit
 * write. Idempotent.
 *
 * Resolved on the caller (`requireActorAuth`), the same account
 * `/api/auth/me` reads the list from. A guardian inside a managed profile
 * closes the hint on their own list, which is the one their screen shows;
 * written to the profile's row it would land where nobody reads it.
 */
import { apiHandler, requireActorAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { nextDismissedHints } from "@/lib/hints/dismissible-hints";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { dismissedHintsPatchSchema } from "@/lib/validations/user-prefs";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireActorAuth();

  const rl = await checkRateLimit(
    `dismissed-hints:patch:${user.id}`,
    PATCH_RATE_LIMIT,
    PATCH_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const parsed = await parseJsonBody(req, dismissedHintsPatchSchema, {
    maxBytes: 4096,
    action: "auth.me.dismissed-hints.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  // The row lock holds a second tab's change until this one is written, so
  // two closes at once both land.
  const next = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ dismissed_hints: string[] }>>`
      SELECT "dismissed_hints" FROM "users" WHERE "id" = ${user.id} FOR UPDATE`;
    const list = nextDismissedHints(rows[0]?.dismissed_hints ?? [], {
      dismiss: parsed.data.dismiss,
      restore: parsed.data.restore,
    });
    await tx.user.update({
      where: { id: user.id },
      data: { dismissedHints: list },
    });
    return list;
  });

  await auditLog("user.dismissed-hints.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      dismiss: parsed.data.dismiss ?? [],
      restore: parsed.data.restore ?? [],
    },
  });

  annotate({
    action: { name: "auth.me.dismissed-hints.patch" },
    meta: {
      dismissed: parsed.data.dismiss?.length ?? 0,
      restored: parsed.data.restore?.length ?? 0,
      stored: next.length,
    },
  });

  return apiSuccess({ dismissedHints: next });
});
