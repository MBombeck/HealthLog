/**
 * v1.18.6 — per-user diabetes opt-in endpoint.
 *
 *  GET    /api/auth/me/diabetes  — current flag.
 *  PATCH  /api/auth/me/diabetes  — body `{ hasDiabetes: boolean }`.
 *
 * The flag is an explicit, user-declared preference ("I have diabetes /
 * clinician glucose targets"). When `true`, the glucose target resolver
 * applies the tighter ADA glycemic GOAL bands (fasting 80–130, postprandial
 * < 180) instead of the general non-diabetic normal bands. It is NEVER
 * inferred from a reading and asserts NO diagnosis — it only selects which
 * target band a glucose reading is judged against.
 *
 * Mirrors the `disable-coach` / `unit-preference` per-user-scalar pattern:
 * 60/min rate limit, Zod safeParse → 422 via `returnAllZodIssues`, audit-log
 * row, field-by-field write (no mass assignment). Idempotent — the endpoint
 * always returns the resolved next state so the client can hard-set the
 * optimistic update without an extra round-trip.
 */
import { z } from "zod";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

const patchBodySchema = z
  .object({
    hasDiabetes: z.boolean(),
  })
  .strict();

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

type DiabetesResponse = {
  hasDiabetes: boolean;
};

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.diabetes.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { hasDiabetes: true },
  });
  const payload: DiabetesResponse = {
    hasDiabetes: row?.hasDiabetes ?? false,
  };
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `diabetes:patch:${user.id}`,
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

  // The body is a single boolean — bound the parse so a malformed or
  // oversized payload is rejected before it is materialised.
  const parsed = await parseJsonBody(req, patchBodySchema, {
    maxBytes: 1024,
    action: "auth.me.diabetes.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const next = parsed.data.hasDiabetes;

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { hasDiabetes: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { hasDiabetes: next },
  });

  await auditLog("user.diabetes.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: previous?.hasDiabetes ?? false,
      next,
    },
  });

  annotate({
    action: { name: "auth.me.diabetes.patch" },
    meta: { hasDiabetes: next },
  });

  const payload: DiabetesResponse = { hasDiabetes: next };
  return apiSuccess(payload);
});
