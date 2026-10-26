/**
 * Per-user "read documents automatically with AI" opt-in endpoint.
 *
 *  GET    /api/auth/me/documents-auto-ai-read  — current flag.
 *  PATCH  /api/auth/me/documents-auto-ai-read  — body `{ documentsAutoAiRead: boolean }`.
 *
 * OFF by default: the document vault stays local-first and every external AI
 * egress needs an explicit per-document action + an active consent receipt. When
 * `true`, the auto-index-on-upload job may read a freshly uploaded document
 * through the user's configured external provider with no per-document tap.
 *
 * Flipping it ON is itself the standing consent act, so the write also mints an
 * append-only `ai_extraction` consent receipt — the durable record the document
 * capability reads. It covers reading documents, lab reports and medication
 * text and nothing else: the Coach and the AI analysis keep asking for their
 * own consent. (Before this release the toggle minted `ai_full`, which also
 * opened those; receipts minted that way stay valid, because nothing tells
 * them apart from a deliberate master grant.) An OFF→ON flip additionally
 * schedules a bounded catch-up over the documents already stored
 * (`enqueueSummaryCatchUp`), because the summary job is enqueued at upload time
 * and would otherwise never revisit a vault filled before the opt-in; it is
 * skipped when the `documentAi` capability is closed for the record, since
 * every summary it would enqueue could only be refused. Mirrors `auth/me/labs-local-ocr`: 60/min rate
 * limit, Zod `safeParse` → 422 via `returnAllZodIssues`, audit-log row,
 * field-by-field write (no mass assignment). Idempotent — always returns the
 * resolved next state so the client can hard-set the optimistic update.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import { AI_CAPABILITIES } from "@/lib/ai/capabilities/types";
import { AI_EXTRACTION_CONSENT_KIND } from "@/lib/consent/receipts";
import { prisma } from "@/lib/db";
import { isP2002 } from "@/lib/prisma-errors";
import { enqueueSummaryCatchUp } from "@/lib/jobs/document-summary-catchup";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { documentsAutoAiReadPatchSchema } from "@/lib/validations/user-prefs";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

type DocumentsAutoAiReadResponse = {
  documentsAutoAiRead: boolean;
};

/**
 * The receipt kind the toggle mints: the extraction grant, narrower than the
 * master `ai_full`. The capability table lists it (with `ai_full`) as what
 * satisfies the document consent rule.
 */
const AUTO_READ_CONSENT_KIND = AI_EXTRACTION_CONSENT_KIND;

/**
 * Mint the extraction receipt unless one that satisfies document reads is
 * already active. The toggle is an affirmative act, so an earlier revocation
 * does not block it, exactly as a first grant would not be blocked. The
 * partial unique index on active receipts is the backstop for two concurrent
 * flips; losing that race means the other flip already minted, which is the
 * outcome wanted. Returns whether a receipt was written.
 */
async function ensureExtractionReceipt(
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const active = await prisma.consentReceipt.findFirst({
    where: {
      userId,
      revokedAt: null,
      kind: { in: [...AI_CAPABILITIES.documentAi.consent.kinds] },
    },
    select: { id: true },
  });
  if (active) return false;
  try {
    await prisma.consentReceipt.create({
      data: {
        userId,
        kind: AUTO_READ_CONSENT_KIND,
        artefact: JSON.stringify({
          source: "web",
          kind: AUTO_READ_CONSENT_KIND,
          grantedAt: now.toISOString(),
          note: "Documents read automatically with AI, turned on in the app.",
        }),
        signedAt: now,
      },
    });
    return true;
  } catch (err) {
    if (isP2002(err)) return false;
    throw err;
  }
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.documentsAutoAiRead.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { documentsAutoAiRead: true },
  });
  const payload: DocumentsAutoAiReadResponse = {
    documentsAutoAiRead: row?.documentsAutoAiRead ?? false,
  };
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `documents-auto-ai-read:patch:${user.id}`,
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
  const parsed = await parseJsonBody(req, documentsAutoAiReadPatchSchema, {
    maxBytes: 1024,
    action: "auth.me.documentsAutoAiRead.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const next = parsed.data.documentsAutoAiRead;

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { documentsAutoAiRead: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { documentsAutoAiRead: next },
  });

  // Turning the toggle ON is the standing consent act — mint an append-only
  // extraction receipt (idempotent) so the durable audit trail records it and
  // the document capability can read it.
  const consentMinted = next ? await ensureExtractionReceipt(user.id) : false;

  // A genuine OFF→ON flip schedules a catch-up over the documents already in
  // the vault. Without it the switch only ever applied to FUTURE uploads: the
  // summary job is enqueued at upload time and no-ops while the flag is OFF, so
  // a user who uploaded first and opted in later saw the toggle do nothing.
  // Fire-and-forget and bounded; the pass only enqueues, and every consent and
  // budget gate still runs per document inside the summary job itself.
  const wasEnabled = previous?.documentsAutoAiRead ?? false;
  if (next && !wasEnabled) {
    // Read after the mint, so a receipt this request just wrote counts.
    const documentAi = await getAiCapability("documentAi");
    if (documentAi.available) {
      void enqueueSummaryCatchUp(user.id);
    } else {
      annotate({
        action: { name: "auth.me.documentsAutoAiRead.catchUpSkipped" },
        meta: { reason: documentAi.reason },
      });
    }
  }

  await auditLog("user.documentsAutoAiRead.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: previous?.documentsAutoAiRead ?? false,
      next,
      consentMinted,
    },
  });

  annotate({
    action: { name: "auth.me.documentsAutoAiRead.patch" },
    meta: { documentsAutoAiRead: next },
  });

  const payload: DocumentsAutoAiReadResponse = { documentsAutoAiRead: next };
  return apiSuccess(payload);
});
