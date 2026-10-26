/**
 * v1.8.5 — user-level injection-site preferences endpoint.
 *
 *  GET    /api/auth/me/injection-site-prefs
 *    → `{ globalExcludedInjectionSites: InjectionSite[] }`
 *
 *  PATCH  /api/auth/me/injection-site-prefs
 *    Body: `{ globalExcludedInjectionSites: InjectionSite[] }`
 *    → the resolved next state (idempotent hard-set).
 *
 * The global exclusion is a per-user deny-list. Sites listed here are
 * never offered for ANY medication's injection-site picker, and the
 * intake write path rejects (422) a submitted site that lands on this
 * list — even when a medication's `allowedInjectionSites` lists it as
 * preferred (deny always wins).
 *
 * Mirrors the `unit-preference` per-user-scalar pattern: 60/min rate
 * limit, Zod safeParse → 422 via `returnAllZodIssues`, audit-log row,
 * field-by-field write (no mass assignment).
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  INJECTION_SITE_VALUES,
  type InjectionSiteValue,
} from "@/lib/validations/medication";
import { injectionSitePrefsPatchSchema } from "@/lib/validations/user-prefs";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

interface InjectionSitePrefsResponse {
  globalExcludedInjectionSites: InjectionSiteValue[];
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.injection-site-prefs.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { globalExcludedInjectionSites: true },
  });
  const payload: InjectionSitePrefsResponse = {
    globalExcludedInjectionSites: (row?.globalExcludedInjectionSites ??
      []) as InjectionSiteValue[],
  };
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `injection-site-prefs:patch:${user.id}`,
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

  const parsed = await parseJsonBody(request, injectionSitePrefsPatchSchema, {
    maxBytes: 64 * 1024,
    action: "auth.me.injection-site-prefs.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  // Dedup while preserving canonical order from the enum tuple.
  const submitted = new Set(parsed.data.globalExcludedInjectionSites);
  const next = INJECTION_SITE_VALUES.filter((s) => submitted.has(s));

  await prisma.user.update({
    where: { id: user.id },
    data: { globalExcludedInjectionSites: next },
  });

  await auditLog("user.injection-site-prefs.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { count: next.length },
  });

  annotate({
    action: { name: "auth.me.injection-site-prefs.patch" },
    meta: { excluded_count: next.length },
  });

  const payload: InjectionSitePrefsResponse = {
    globalExcludedInjectionSites: next,
  };
  return apiSuccess(payload);
});
