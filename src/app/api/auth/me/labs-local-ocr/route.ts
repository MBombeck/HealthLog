/**
 * v1.18.10 — per-user local-OCR opt-in endpoint.
 *
 *  GET    /api/auth/me/labs-local-ocr  — current flag.
 *  PATCH  /api/auth/me/labs-local-ocr  — body `{ labsLocalOcrEnabled: boolean }`.
 *
 * When `true`, a user whose AI provider cannot read images (ChatGPT-OAuth/Codex,
 * a text-only model) can still scan a paper lab report: the image is OCR'd in
 * the browser via tesseract.js and only the extracted TEXT is forwarded to the
 * text-only provider for structuring. The raw image never leaves the device in
 * this mode. Less accurate than native vision — the mandatory review screen is
 * the safety backstop.
 *
 * Mirrors the `diabetes` / `unit-preference` per-user-scalar pattern: 60/min
 * rate limit, Zod safeParse → 422 via `returnAllZodIssues`, audit-log row,
 * field-by-field write (no mass assignment). Idempotent — always returns the
 * resolved next state so the client can hard-set the optimistic update.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { labsLocalOcrPatchSchema } from "@/lib/validations/user-prefs";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

type LabsLocalOcrResponse = {
  labsLocalOcrEnabled: boolean;
};

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.labsLocalOcr.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { labsLocalOcrEnabled: true },
  });
  const payload: LabsLocalOcrResponse = {
    labsLocalOcrEnabled: row?.labsLocalOcrEnabled ?? false,
  };
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `labs-local-ocr:patch:${user.id}`,
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

  // The body is a single boolean — bound the parse so a malformed or oversized
  // payload is rejected before it is materialised.
  const parsed = await parseJsonBody(req, labsLocalOcrPatchSchema, {
    maxBytes: 1024,
    action: "auth.me.labsLocalOcr.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const next = parsed.data.labsLocalOcrEnabled;

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { labsLocalOcrEnabled: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { labsLocalOcrEnabled: next },
  });

  await auditLog("user.labsLocalOcr.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: previous?.labsLocalOcrEnabled ?? false,
      next,
    },
  });

  annotate({
    action: { name: "auth.me.labsLocalOcr.patch" },
    meta: { labsLocalOcrEnabled: next },
  });

  const payload: LabsLocalOcrResponse = { labsLocalOcrEnabled: next };
  return apiSuccess(payload);
});
