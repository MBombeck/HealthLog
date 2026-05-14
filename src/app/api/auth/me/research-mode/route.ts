/**
 * v1.4.25 W19c — Research Mode acknowledgment endpoint.
 *
 *  GET     /api/auth/me/research-mode  — returns the current flag,
 *                                        the timestamp + version of
 *                                        the last acknowledgment, and
 *                                        the live disclaimer version
 *                                        so the Settings UI can
 *                                        compare and re-prompt.
 *  POST    /api/auth/me/research-mode  — body { acknowledged: true,
 *                                        version }. Flips the flag
 *                                        on. Rejects 400 if `version`
 *                                        is not the live version.
 *  DELETE  /api/auth/me/research-mode  — disables Research Mode and
 *                                        clears the acknowledgment.
 *                                        Idempotent.
 *
 * Per-user POST rate-limit is intentionally low (5/min) — this is a
 * one-tap acknowledgment dialog, not a hot path. Anything above that
 * traffic looks like a malformed client retry-loop or an exploit.
 *
 * Prompt-injection surface — the API accepts the disclaimer
 * `version` string and nothing else from the client. The version
 * value never reaches the LLM; it is matched against the
 * server-side constant `RESEARCH_MODE_DISCLAIMER_VERSION` and then
 * persisted as the stamp on the user row. No free-text body.
 *
 * Audit-log entries fire on every state-changing call (POST, DELETE)
 * with the previous + next state, mirroring the doctor-report-prefs
 * route's reconcile pattern (W10 security M-3).
 */
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { RESEARCH_MODE_DISCLAIMER_VERSION } from "@/lib/medications/glp1-pk";

export const dynamic = "force-dynamic";

const POST_RATE_LIMIT = 5;
const POST_WINDOW_MS = 60_000;

type ResearchModeResponse = {
  enabled: boolean;
  acknowledgedAt: string | null;
  acknowledgedVersion: string | null;
  currentDisclaimerVersion: string;
};

function shape(row: {
  researchModeEnabled: boolean;
  researchModeAcknowledgedAt: Date | null;
  researchModeAcknowledgedVersion: string | null;
}): ResearchModeResponse {
  return {
    enabled: row.researchModeEnabled,
    acknowledgedAt: row.researchModeAcknowledgedAt
      ? row.researchModeAcknowledgedAt.toISOString()
      : null,
    acknowledgedVersion: row.researchModeAcknowledgedVersion,
    currentDisclaimerVersion: RESEARCH_MODE_DISCLAIMER_VERSION,
  };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.research-mode.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      researchModeEnabled: true,
      researchModeAcknowledgedAt: true,
      researchModeAcknowledgedVersion: true,
    },
  });
  // `requireAuth` already proved the user exists; defensive default
  // here only matters for the (impossible-in-practice) race where
  // the user is deleted mid-request.
  return apiSuccess(
    shape(
      row ?? {
        researchModeEnabled: false,
        researchModeAcknowledgedAt: null,
        researchModeAcknowledgedVersion: null,
      },
    ),
  );
});

export const POST = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  // Per-user rate-limit. 5/min is generous for a once-per-update
  // acknowledgment dialog; anything more looks like a retry loop.
  const rl = await checkRateLimit(
    `research-mode:post:${user.id}`,
    POST_RATE_LIMIT,
    POST_WINDOW_MS,
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
    throw new HttpError(422, "research-mode.body.invalid_json");
  }

  // Hand-rolled validation — the body is tiny (two fields), and
  // staying off Zod keeps the prompt-injection surface visibly
  // simple in a code review.
  if (
    !body ||
    typeof body !== "object" ||
    (body as { acknowledged?: unknown }).acknowledged !== true ||
    typeof (body as { version?: unknown }).version !== "string"
  ) {
    annotate({ action: { name: "auth.me.research-mode.post.invalid_shape" } });
    throw new HttpError(422, "research-mode.body.invalid_shape");
  }

  const submittedVersion = (body as { version: string }).version;

  // Stale-version guard — the dialog must show the *live* copy at
  // the moment of acknowledgment. A stale version means the user
  // is acknowledging older wording; we refuse and force the
  // Settings UI to re-render with the new disclaimer.
  if (submittedVersion !== RESEARCH_MODE_DISCLAIMER_VERSION) {
    annotate({
      action: { name: "auth.me.research-mode.post.stale_version" },
      meta: {
        submitted: submittedVersion,
        current: RESEARCH_MODE_DISCLAIMER_VERSION,
      },
    });
    throw new HttpError(400, "research-mode.version.stale");
  }

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      researchModeEnabled: true,
      researchModeAcknowledgedAt: true,
      researchModeAcknowledgedVersion: true,
    },
  });

  const next = {
    researchModeEnabled: true,
    researchModeAcknowledgedAt: new Date(),
    researchModeAcknowledgedVersion: RESEARCH_MODE_DISCLAIMER_VERSION,
  };
  await prisma.user.update({
    where: { id: user.id },
    data: next,
  });

  await auditLog("user.research-mode.enable", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: previous ?? null,
      next: {
        ...next,
        researchModeAcknowledgedAt: next.researchModeAcknowledgedAt.toISOString(),
      },
    },
  });

  annotate({
    action: { name: "auth.me.research-mode.post" },
    meta: { version: RESEARCH_MODE_DISCLAIMER_VERSION },
  });
  return apiSuccess(shape(next));
});

export const DELETE = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      researchModeEnabled: true,
      researchModeAcknowledgedAt: true,
      researchModeAcknowledgedVersion: true,
    },
  });

  // Idempotent — if Research Mode is already off, we still write
  // the canonical "off" state so the audit row exists.
  const next = {
    researchModeEnabled: false,
    researchModeAcknowledgedAt: null,
    researchModeAcknowledgedVersion: null,
  };
  await prisma.user.update({
    where: { id: user.id },
    data: next,
  });

  await auditLog("user.research-mode.disable", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { previous: previous ?? null, next },
  });

  annotate({ action: { name: "auth.me.research-mode.delete" } });
  return apiSuccess(shape(next));
});
