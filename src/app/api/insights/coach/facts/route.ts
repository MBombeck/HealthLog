/**
 * GET    /api/insights/coach/facts — list the caller's ACTIVE Coach facts.
 * POST   /api/insights/coach/facts — remember one of the caller's own Coach
 *                                    messages (the remember button).
 * DELETE /api/insights/coach/facts — "forget all": soft-delete every active
 *                                    fact for the caller.
 *
 * v1.11.1 — the GDPR / "forget what you know about me" surface for the
 * durable Coach facts. v1.41 — also the Coach's one memory list: each fact
 * says where it came from (`source`), when it was last used in a turn and
 * which message it came out of; the person edits a fact through
 * `PATCH …/facts/{id}`. A health fact still waiting for the person's answer
 * (`source: "proposed"`) is not listed: nothing the person has not agreed to
 * appears as something the Coach knows. "Forget all" clears those too.
 *
 * POST names a message, never text: the server reads the caller's own stored
 * message, files it with the medication / condition lexicon (anything else is
 * `context`) and saves it as `source: "user"`. The tap is the person's
 * confirmation, so a health message is saved too. A message the caller does
 * not own, or an assistant message, is a 404.
 *
 * Ownership: every query is scoped `where: { userId, ... }`, so a caller
 * can only ever see or clear their own facts. The fact text is decrypted
 * on the fly; an undecryptable row (e.g. a key rotated out of the map) is
 * skipped rather than 500ing the whole list — the surface stays available
 * for the rows that DO decrypt.
 *
 * Never AI-gated. The facts are the person's stored data: viewing and
 * deleting them keeps working while the Coach is off for any reason (the
 * operator's switch, the person's own opt-out, no provider, no consent).
 * Erasure that depends on the feature being on is no erasure.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { rememberMessageAsFact } from "@/lib/ai/coach/memory/remember";
import { PROPOSED_FACT_SOURCE } from "@/lib/ai/coach/memory/shared";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { coachFactCreateSchema } from "@/lib/validations/coach-fact";

// The remember button is one tap per message; the limit only caps a runaway
// client loop, like the plan mutations.
const CREATE_RATE_LIMIT = 40;
const CREATE_WINDOW_MS = 60_000;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const rows = await prisma.coachFact.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      source: { not: PROPOSED_FACT_SOURCE },
    },
    // Highest-confidence first, then newest — mirrors the injection
    // ordering so the management list reads in the same priority the
    // assistant actually weights the facts.
    orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      category: true,
      factEncrypted: true,
      confidence: true,
      source: true,
      sourceConversationId: true,
      sourceMessageId: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const facts: Array<{
    id: string;
    category: string;
    text: string;
    confidence: number;
    source: string;
    sourceConversationId: string | null;
    sourceMessageId: string | null;
    lastUsedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  for (const row of rows) {
    let text: string;
    try {
      text = decryptFromBytes(row.factEncrypted);
    } catch {
      // Fail closed per row — never surface ciphertext, never 500 the
      // whole list because one row's key id is no longer in the map.
      continue;
    }
    facts.push({
      id: row.id,
      category: row.category,
      text,
      confidence: row.confidence,
      source: row.source,
      sourceConversationId: row.sourceConversationId,
      sourceMessageId: row.sourceMessageId,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  annotate({
    action: { name: "coach.facts.listed" },
    meta: { count: facts.length },
  });

  return apiSuccess({ facts });
});

export const POST = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();
  // Saving to the Coach's memory is Coach use, like confirming a plan; it is
  // not model work, so no AI gate.
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `coach-facts:create:${user.id}`,
    CREATE_RATE_LIMIT,
    CREATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const { data: body, error: jsonError } = await safeJson(req, {
    maxBytes: 1024,
  });
  if (jsonError) return jsonError;
  const parsed = coachFactCreateSchema.safeParse(body);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  const remembered = await rememberMessageAsFact({
    userId: user.id,
    messageId: parsed.data.messageId,
  });
  if (!remembered) {
    // Indistinguishable from "owned by someone else" — never reveal which.
    return apiError("Message not found", 404);
  }

  annotate({
    action: { name: "coach.facts.created" },
    meta: { category: remembered.category, created: remembered.created },
  });

  return apiSuccess(
    {
      fact: {
        id: remembered.id,
        category: remembered.category,
        text: remembered.text,
        source: remembered.source,
      },
      created: remembered.created,
    },
    remembered.created ? 201 : 200,
  );
});

export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();

  // Soft-delete every active fact — keeps the rows for audit while
  // hiding them from injection. `updateMany` scoped to the caller can
  // never touch another user's rows.
  const { count } = await prisma.coachFact.updateMany({
    where: { userId: user.id, deletedAt: null },
    data: { deletedAt: new Date() },
  });

  annotate({
    action: { name: "coach.facts.cleared" },
    meta: { cleared: count },
  });

  return apiSuccess({ cleared: count });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
