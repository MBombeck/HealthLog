/**
 * v1.18.0 — per-user module enable/disable preferences.
 *
 *  GET   /api/auth/me/modules  — resolved `{ <moduleKey>: boolean }` map
 *                                for every toggleable module (cycle/coach
 *                                reflect their real delegated state).
 *  PATCH /api/auth/me/modules  — body `{ <moduleKey>?: boolean }`. Merges
 *                                the supplied keys into the persisted
 *                                `modulePreferencesJson` DISABLED allowlist
 *                                (field-by-field, no mass assignment) and
 *                                returns the freshly-resolved module map.
 *
 * The body schema (`modulePrefsPatchSchema`) is `strict()` over the
 * directly-owned toggleable key set, so a core-domain key (`weight`,
 * `bloodPressure`, `pulse`), a delegated key (`cycle`, `coach`), or any
 * unknown key is a 422 — the core measurement engine can never be disabled
 * here, and a value for a delegated module can never land inert in
 * `modulePreferencesJson`. v1.18.1 (D3) — `medications` graduated to a
 * toggleable module, so it IS accepted here now. The delegated modules are
 * managed at their real control (cycle in Account, coach in Settings →
 * Coach); the Modules hub deep-links there rather than offering a dead
 * toggle.
 *
 * `userId` is always narrowed from `requireAuth()`; the body never
 * carries it. The semantics are a DISABLED allowlist: a key set to
 * `false` disables that module; `true` (or absence) leaves it enabled.
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
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  takeBaseToken,
  guardedUserUpdate,
  invalidBaseTokenError,
} from "@/lib/optimistic-lock";
import { resolveModuleMap, normalisePrefs } from "@/lib/modules/gate";
import { modulePrefsPatchSchema } from "@/lib/validations/modules";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.modules.get" } });

  const modules = await resolveModuleMap(user.id);
  // v1.32.22 (M3) — surface the optimistic-concurrency token. `resolveModuleMap`
  // returns no row metadata, so read `updatedAt` on its own.
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { updatedAt: true },
  });
  return apiSuccess({ modules, updatedAt: row?.updatedAt?.toISOString() });
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `modules:patch:${user.id}`,
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
      errorCode: "modules.body.invalid_json",
    });
  }

  // v1.32.22 (M3) — strip the optimistic-concurrency base token BEFORE the
  // parse: `modulePrefsPatchSchema` is `.strict()` and must stay strict, so
  // the transport token can never reach it (it would 422 as an unknown key).
  const taken = takeBaseToken(body ?? {});
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;

  const parsed = modulePrefsPatchSchema.safeParse(taken.rest ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.modules.patch.invalid_shape" },
      meta: { issues: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "modules.invalid",
    });
  }

  // Merge the supplied keys into the persisted DISABLED allowlist,
  // field-by-field. `normalisePrefs` strips any junk from the stored
  // row so a previously-corrupted blob can't poison the merge, and the
  // strict schema guarantees `parsed.data` carries only toggleable keys
  // (core domains were rejected at the 422 above).
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { modulePreferencesJson: true },
  });
  const merged: Record<string, boolean> = normalisePrefs(
    existing?.modulePreferencesJson,
  );
  const changed: string[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    merged[key] = value;
    changed.push(key);
  }

  // v1.32.22 (M3) — guard the write on the client's base token; a stale base
  // 409s and writes nothing. Tokenless requests keep the unconditional write.
  const guarded = await guardedUserUpdate({
    userId: user.id,
    base,
    data: { modulePreferencesJson: merged },
    conflict: {
      action: "auth.me.modules.conflict",
      errorCode: "modules_conflict",
      message: "Module preferences changed since they were loaded",
    },
  });
  if ("conflict" in guarded) return guarded.conflict;

  // A module toggle can add or remove a Health Score pillar, so the
  // cached composite was computed from a composition that no longer
  // holds. Without this the score stays stale for up to an hour after a
  // change the person made on purpose.
  invalidateUserHealthScore(user.id);

  const modules = await resolveModuleMap(user.id);

  await auditLog("user.modules.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { changed },
  });

  annotate({
    action: { name: "auth.me.modules.patch" },
    meta: { changed },
  });

  return apiSuccess({ modules, updatedAt: guarded.updatedAt });
});
