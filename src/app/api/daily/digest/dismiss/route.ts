/**
 * POST /api/daily/digest/dismiss
 *
 * "Dismiss / mark seen" for observational Today rail items and versioned
 * informational notices. Actionable kinds (`dose_window`, `sync_issue`,
 * `preventive_care`, `coach_checkin`) are never reachable here:
 * `dismissPriorityItemSchema` rejects any `itemKey` without an approved
 * observational or notice prefix before a lookup runs.
 *
 * Persisted server-side (`DismissedPriorityItem`, composite-unique on
 * `userId` + `itemKey`) so the dismissal survives reload / a second device —
 * an upsert, so a repeat dismiss of the same instance is a no-op rather than
 * a conflict. `userId` is narrowed from `requireAuth()` only; the body never
 * carries one. Cookie OR Bearer, mirroring the digest GET route's own auth
 * policy. Like the digest GET it carries no module gate: the rail is data,
 * and the `insights` module is the AI analysis opt-out.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { isScoreNoticeItemKey } from "@/lib/daily/priority-item";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { dismissPriorityItemSchema } from "@/lib/validations/daily";

export const dynamic = "force-dynamic";

// A cheap, owner-scoped upsert; the limit only caps a runaway client loop.
const DISMISS_RATE_LIMIT = 40;
const DISMISS_WINDOW_MS = 60_000;

export const POST = apiHandler(async (req: NextRequest) => {
  const { user } = await requireAuth();
  const rl = await checkRateLimit(
    `daily-digest-dismiss:${user.id}`,
    DISMISS_RATE_LIMIT,
    DISMISS_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const parsed = await parseJsonBody(req, dismissPriorityItemSchema, {
    maxBytes: 1024,
  });
  if (!parsed.ok) return parsed.error;

  const { itemKey } = parsed.data;

  await prisma.dismissedPriorityItem.upsert({
    where: { userId_itemKey: { userId: user.id, itemKey } },
    update: {},
    create: { userId: user.id, itemKey },
  });
  // Every score notice, not just the method one: the report resolves each
  // notice's `dismissed` flag at compute time, so a dismissal the cache
  // outlives comes straight back on the next read.
  if (isScoreNoticeItemKey(itemKey)) {
    invalidateUserHealthScore(user.id);
  }

  annotate({
    action: { name: "daily.digest.item.dismissed" },
    meta: { daily_digest_item_kind: itemKey.split(":")[0] },
  });

  return apiSuccess({ dismissed: true });
});
