/**
 * Whether the navigation shows its counts (#1113).
 *
 *  PATCH /api/auth/me/show-nav-counts — body `{ showNavCounts: boolean }`.
 *
 * The sidebar and the More sheet show the doses due on Medications and the
 * check-ups due on Checkups. On by default. While it is off the client shows
 * no count and does not ask `GET /api/nav/counts`. The current value is
 * published on `/api/auth/me` as `showNavCounts`.
 *
 * The per-user-scalar pattern of `medicine-registry` next door: 60/min rate
 * limit, a 1 KB body cap, Zod safeParse with a 422, an audit row, a
 * field-by-field write, and the resolved next state as the answer.
 * Idempotent.
 *
 * Resolved on the caller (`requireActorAuth`), the same account
 * `/api/auth/me` publishes the value from, so a guardian inside a managed
 * profile changes their own navigation rather than the profile's row.
 */
import { apiHandler, requireActorAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { showNavCountsPatchSchema } from "@/lib/validations/user-prefs";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireActorAuth();

  const rl = await checkRateLimit(
    `show-nav-counts:patch:${user.id}`,
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

  const parsed = await parseJsonBody(req, showNavCountsPatchSchema, {
    maxBytes: 1024,
    action: "auth.me.show-nav-counts.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const next = parsed.data.showNavCounts;
  const previous = user.showNavCounts;

  await prisma.user.update({
    where: { id: user.id },
    data: { showNavCounts: next },
  });

  await auditLog("user.show-nav-counts.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { previous, next },
  });

  annotate({
    action: { name: "auth.me.show-nav-counts.patch" },
    meta: { showNavCounts: next },
  });

  return apiSuccess({ showNavCounts: next });
});
