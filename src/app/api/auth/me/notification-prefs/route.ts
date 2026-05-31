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
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
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
    select: { notificationPrefs: true },
  });
  return apiSuccess(parseNotificationPrefs(row?.notificationPrefs ?? null));
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
    throw new HttpError(422, "notification-prefs.body.invalid_json");
  }

  const parsed = notificationPrefsSchema.safeParse(body ?? {});
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

  await prisma.user.update({
    where: { id: user.id },
    data: { notificationPrefs: toJson(merged) },
  });

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

  return apiSuccess(merged);
});
