/**
 * Per-user opt-in to the operator's shared central Codex (ChatGPT subscription).
 *
 *   GET   /api/auth/me/use-central-codex  — current flag.
 *   PATCH /api/auth/me/use-central-codex  — body `{ useCentralCodex: boolean }`.
 *
 * OFF by default. When `true`, and the operator has connected the central Codex,
 * the user's resolved provider chain gains a trailing `admin-codex` entry — an
 * external, shared, train-by-default subscription account bound by the
 * operator's rate limits. Using it is external egress: the existing consent gate
 * (`admin-codex` is server-managed) still requires an active AI consent receipt
 * before any PHI leaves for it, so flipping this ON never egresses anything on
 * its own.
 *
 * Mirrors `auth/me/labs-local-ocr`: 60/min rate limit, Zod `safeParse` → 422 via
 * `returnAllZodIssues`, audit-log row, field-by-field write (no mass
 * assignment). Idempotent — always returns the resolved next state.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { useCentralCodexPatchSchema } from "@/lib/validations/user-prefs";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

type UseCentralCodexResponse = {
  useCentralCodex: boolean;
};

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.useCentralCodex.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { useCentralCodex: true },
  });
  const payload: UseCentralCodexResponse = {
    useCentralCodex: row?.useCentralCodex ?? false,
  };
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `use-central-codex:patch:${user.id}`,
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

  const parsed = await parseJsonBody(req, useCentralCodexPatchSchema, {
    maxBytes: 1024,
    action: "auth.me.useCentralCodex.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const next = parsed.data.useCentralCodex;

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { useCentralCodex: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { useCentralCodex: next },
  });

  await auditLog("user.useCentralCodex.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: previous?.useCentralCodex ?? false,
      next,
    },
  });

  annotate({
    action: { name: "auth.me.useCentralCodex.patch" },
    meta: { useCentralCodex: next },
  });

  const payload: UseCentralCodexResponse = { useCentralCodex: next };
  return apiSuccess(payload);
});
