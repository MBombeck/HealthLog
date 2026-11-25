/**
 * v1.15.0 — per-user cycle-tracking preferences.
 *
 *  GET   /api/auth/me/cycle-prefs   — current resolved CycleProfileDTO.
 *  PATCH /api/auth/me/cycle-prefs   — body `{ enabled?, goal?, rawChartMode?,
 *                                      predictionEnabled?, discreetNotifications?,
 *                                      sensitiveCategoryEncryption?,
 *                                      typicalCycleLength?, typicalPeriodLength?,
 *                                      lutealPhaseLength?, pregnancy? }`. Deep-merges the
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
import { withUserRowLock } from "@/lib/user-row-lock";
import { isCycleEnabled } from "@/lib/cycle/enabled";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { toCycleProfileDTO } from "@/lib/cycle/dto";
import {
  cyclePrefsSchema,
  mergePregnancyPatch,
  pregnancyPatchProblem,
} from "@/lib/validations/cycle";
import { predictionsPausedOn } from "@/lib/cycle/pregnancy";
import {
  pregnancyFieldsOf,
  pregnancyWriteData,
} from "@/lib/cycle/pregnancy-store";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/** The owner's calendar day, the day every cycle date is counted on. */
function ownerToday(timezone: string | null | undefined): string {
  return moodDateKey(new Date(), timezone ?? DEFAULT_TIMEZONE);
}

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.cycle-prefs.get" } });

  const profile = await getOrCreateCycleProfile(user.id);
  const resolved = isCycleEnabled(user.gender, profile);
  return apiSuccess(
    toCycleProfileDTO(profile, resolved, ownerToday(user.timezone)),
  );
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

  const p = parsed.data;
  const today = ownerToday(user.timezone);

  // Ensure the row exists, then deep-merge: only the supplied fields are
  // touched; siblings are left untouched (field-by-field, no mass
  // assignment). `enabled` maps onto the `cycleTrackingEnabled` column.
  // The pregnancy state is one sealed document, read, merged and written
  // back whole, so the read and the write run under the account's row lock:
  // two overlapping saves (the start date from one tab, the due date from
  // another) would otherwise both read the same document and the later one
  // would drop the earlier one's date.
  const written = await withUserRowLock(user.id, async (tx) => {
    const stored = await getOrCreateCycleProfile(user.id, tx);

    // The pregnancy state merges over the stored columns and is checked
    // as a whole: a patch that only moves the due date must still agree with
    // the first day already stored.
    const pregnancy = p.pregnancy
      ? mergePregnancyPatch(pregnancyFieldsOf(stored), p.pregnancy)
      : null;
    if (pregnancy) {
      const problem = pregnancyPatchProblem(pregnancy, today);
      if (problem) return { problem };
    }

    const updated = await tx.cycleProfile.update({
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
        ...(pregnancy &&
          pregnancyWriteData({ ...pregnancy, ownerDecided: true })),
      },
    });
    return { updated, pregnancy };
  });
  if ("problem" in written) {
    return apiError("Invalid pregnancy dates", 422, {
      errorCode: written.problem,
    });
  }
  const { updated, pregnancy } = written;

  // A state that pauses the forecast takes the cached forecast with it at
  // once, so the reminder cron has nothing left to push from; the refresh job
  // writes a new one once the state no longer holds.
  if (pregnancy && predictionsPausedOn(pregnancy, today)) {
    await prisma.cyclePrediction.deleteMany({ where: { userId: user.id } });
  }

  const resolved = isCycleEnabled(user.gender, updated);
  // The typical lengths, the prediction switch and tracking itself all feed
  // the dashboard's cycle line, which is cached in the digest extras cell.
  invalidateUserHealthContext(user.id);

  await auditLog("user.cycle-prefs.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { changed: Object.keys(p) },
  });

  annotate({
    action: { name: "user.cycle_prefs.update" },
    meta: { changed: Object.keys(p), enabled: resolved },
  });

  return apiSuccess(toCycleProfileDTO(updated, resolved, today));
});
