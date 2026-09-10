/**
 * v1.15.0 — per-user cycle-tracking preferences.
 *
 *  GET   /api/auth/me/cycle-prefs   — current resolved CycleProfileDTO.
 *  PATCH /api/auth/me/cycle-prefs   — body `{ enabled?, goal?, rawChartMode?,
 *                                      predictionEnabled?, discreetNotifications?,
 *                                      sensitiveCategoryEncryption?,
 *                                      typicalCycleLength?, typicalPeriodLength?,
 *                                      lutealPhaseLength? }`. Deep-merges the
 *                                      supplied fields over the persisted row
 *                                      (the notification-prefs precedent) and
 *                                      returns the merged CycleProfileDTO.
 *
 * This route does NOT enforce the cycle gate — it is the surface that
 * FLIPS the gate (`enabled` → `cycleTrackingEnabled`). `enabled` is
 * idempotent last-writer-wins; the route is otherwise idempotent.
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
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { getOrCreateCycleProfile } from "@/lib/cycle/profile";
import { isCycleEnabled } from "@/lib/cycle/gate";
import { toCycleProfileDTO } from "@/lib/cycle/dto";
import { cyclePrefsSchema } from "@/lib/validations/cycle";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.cycle-prefs.get" } });

  const profile = await getOrCreateCycleProfile(user.id);
  const resolved = isCycleEnabled(user.gender, profile);
  return apiSuccess(toCycleProfileDTO(profile, resolved));
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `cycle-prefs:patch:${user.id}`,
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
      errorCode: "cycle-prefs.body.invalid_json",
    });
  }

  const parsed = cyclePrefsSchema.safeParse(body ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.cycle-prefs.patch.invalid_shape" },
      meta: { issues: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "cycle-prefs.invalid",
    });
  }

  // Ensure the row exists, then deep-merge: only the supplied fields are
  // touched; siblings are left untouched (field-by-field, no mass
  // assignment). `enabled` maps onto the `cycleTrackingEnabled` column.
  await getOrCreateCycleProfile(user.id);
  const p = parsed.data;

  const updated = await prisma.cycleProfile.update({
    where: { userId: user.id },
    data: {
      ...(p.enabled !== undefined && { cycleTrackingEnabled: p.enabled }),
      ...(p.goal !== undefined && { goal: p.goal }),
      ...(p.secondarySymptom !== undefined && {
        secondarySymptom: p.secondarySymptom,
      }),
      ...(p.rawChartMode !== undefined && { rawChartMode: p.rawChartMode }),
      ...(p.predictionEnabled !== undefined && {
        predictionEnabled: p.predictionEnabled,
      }),
      ...(p.discreetNotifications !== undefined && {
        discreetNotifications: p.discreetNotifications,
      }),
      ...(p.sensitiveCategoryEncryption !== undefined && {
        sensitiveCategoryEncryption: p.sensitiveCategoryEncryption,
      }),
      ...(p.typicalCycleLength !== undefined && {
        typicalCycleLength: p.typicalCycleLength,
      }),
      ...(p.typicalPeriodLength !== undefined && {
        typicalPeriodLength: p.typicalPeriodLength,
      }),
      ...(p.lutealPhaseLength !== undefined && {
        lutealPhaseLength: p.lutealPhaseLength,
      }),
    },
  });

  const resolved = isCycleEnabled(user.gender, updated);

  await auditLog("user.cycle-prefs.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { changed: Object.keys(p) },
  });

  annotate({
    action: { name: "user.cycle_prefs.update" },
    meta: { changed: Object.keys(p), enabled: resolved },
  });

  return apiSuccess(toCycleProfileDTO(updated, resolved));
});
