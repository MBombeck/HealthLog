/**
 * v1.4.49 M-DOUBLE-REMINDER — per-user notification preferences endpoint.
 *
 *  GET    /api/auth/me/notification-prefs  — current resolved prefs.
 *  PATCH  /api/auth/me/notification-prefs  — body `{ medication?: { clientManaged?: boolean },
 *                                            mood?: { reminderHour?: 0..23 } }`.
 *                                            Deep-merges the supplied
 *                                            shape over the persisted
 *                                            row so future categories
 *                                            slot in next to
 *                                            `medication` without
 *                                            overwriting siblings.
 *
 * Auth is shared via `requireAuth()` so cookie sessions + Bearer
 * tokens both work (the iOS app uses Bearer). Default shape lives in
 * `parseNotificationPrefs` — a null DB row resolves to
 * `{ medication: { clientManaged: false } }`, preserving the legacy
 * server-side reminder behaviour for any user the iOS client has not
 * yet opted in.
 *
 * Idempotent. The endpoint always returns the fully-resolved next
 * state so the client can hard-set the optimistic update without an
 * extra round-trip. Rate-limit is intentionally generous (60/min) —
 * matches the disable-coach route which is the closest analogue.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma, toJson } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  takeBaseToken,
  guardedUserUpdate,
  invalidBaseTokenError,
} from "@/lib/optimistic-lock";
import {
  notificationPrefsSchema,
  parseNotificationPrefs,
  resolveNotificationPrefs,
} from "@/lib/validations/notification-prefs";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.notification-prefs.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    // v1.32.22 (M1) — `updatedAt` rides the response as the optimistic-
    // concurrency token so a client can echo it on its next PATCH.
    select: { notificationPrefs: true, updatedAt: true },
  });
  return apiSuccess({
    ...parseNotificationPrefs(row?.notificationPrefs ?? null),
    updatedAt: row?.updatedAt?.toISOString(),
  });
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `notification-prefs:patch:${user.id}`,
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body", 400, {
      errorCode: "notification-prefs.body.invalid_json",
    });
  }

  // v1.32.22 (M1) — pull the optimistic-concurrency base token off the body
  // BEFORE the Zod parse so it never pollutes `changedCategories`
  // (`Object.keys(parsed.data)`) or the schema. The race that matters: iOS
  // sets `medication.clientManaged = true`, a web card PATCH based on a
  // pre-iOS read deep-merges the whole blob WITHOUT it, silently reverting the
  // flag (the double-reminder class). With the token, that stale write 409s.
  const taken = takeBaseToken(body ?? {});
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;

  const parsed = notificationPrefsSchema.safeParse(taken.rest ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.notification-prefs.patch.invalid_shape" },
      meta: { issues: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  // Deep-merge the partial input over the current row so a PATCH that
  // only touches `medication` does not overwrite future sibling
  // categories (mood, personal_records, ...). The full resolved shape
  // is persisted so the column layout stays stable across schema
  // additions.
  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: { notificationPrefs: true },
  });
  const previous = parseNotificationPrefs(current?.notificationPrefs ?? null);
  const merged = resolveNotificationPrefs(
    current?.notificationPrefs ?? null,
    parsed.data,
  );

  // v1.32.22 (M1) — guard the deep-merge write on the client's base token. A
  // stale base 409s and writes NOTHING, so a concurrent web PATCH can't revert
  // a category (e.g. `medication.clientManaged`) another writer just set from a
  // fresher read. A tokenless request keeps the prior unconditional write.
  const guarded = await guardedUserUpdate({
    userId: user.id,
    base,
    data: { notificationPrefs: toJson(merged) },
    conflict: {
      action: "user.notification_prefs.conflict",
      errorCode: "notification_prefs_conflict",
      message: "Notification preferences changed since they were loaded",
    },
  });
  if ("conflict" in guarded) return guarded.conflict;

  // Capture which categories the PATCH actually touched so the audit
  // trail records the user's intent, not just the full resolved row.
  const changedCategories = Object.keys(parsed.data);

  await auditLog("user.notification-prefs.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous,
      next: merged,
      changed: changedCategories,
    },
  });

  annotate({
    action: { name: "user.notification_prefs.update" },
    meta: {
      changed: changedCategories,
      medication_client_managed: merged.medication.clientManaged,
    },
  });

  return apiSuccess({ ...merged, updatedAt: guarded.updatedAt });
});
