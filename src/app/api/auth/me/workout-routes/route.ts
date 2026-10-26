/**
 * Per-account opt-in for keeping workout GPS tracks.
 *
 *  GET    /api/auth/me/workout-routes  — current flag.
 *  PATCH  /api/auth/me/workout-routes  — body `{ storeWorkoutRoutes: boolean }`.
 *
 * Off by default. While it is off, `POST /api/workouts/batch` and the
 * Apple Health export import keep every workout but drop its track, so a
 * route (where a person lives, works and trains) is stored only after the
 * person asked for it. Turning it off later stops new tracks; tracks already
 * stored stay until the workout or the account is deleted.
 *
 * Same per-user-scalar pattern as `labs-local-ocr`: 60/min rate limit, a
 * bounded body, Zod safeParse → 422, field-by-field write, audit row, and
 * the resolved next state in the response.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { workoutRoutesPatchSchema } from "@/lib/validations/user-prefs";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

type WorkoutRoutesResponse = {
  storeWorkoutRoutes: boolean;
};

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.workoutRoutes.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { storeWorkoutRoutes: true },
  });
  const payload: WorkoutRoutesResponse = {
    storeWorkoutRoutes: row?.storeWorkoutRoutes ?? false,
  };
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `workout-routes:patch:${user.id}`,
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

  const parsed = await parseJsonBody(req, workoutRoutesPatchSchema, {
    maxBytes: 1024,
    action: "auth.me.workoutRoutes.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const next = parsed.data.storeWorkoutRoutes;

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { storeWorkoutRoutes: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { storeWorkoutRoutes: next },
  });

  await auditLog("user.storeWorkoutRoutes.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: previous?.storeWorkoutRoutes ?? false,
      next,
    },
  });

  annotate({
    action: { name: "auth.me.workoutRoutes.patch" },
    meta: { storeWorkoutRoutes: next },
  });

  const payload: WorkoutRoutesResponse = { storeWorkoutRoutes: next };
  return apiSuccess(payload);
});
