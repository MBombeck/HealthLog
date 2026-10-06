/**
 * GET /api/coach/plans — list the caller's Coach goal / if-then plans.
 *
 * v1.21.3 (B1) — the management + confirm surface for the durable plans the
 * Coach proposes. A plan is an "if-then" implementation intention tied to one
 * metric, with an optional target. The Coach extractor writes a plan as
 * `status: "proposed"`; only the user-facing PATCH (`/api/coach/plans/[id]`)
 * activates it. There is no silent self-edit of the user's plan set. A plan
 * the Coach proposes in a turn (`propose_plan`, v1.41) exists only once the
 * answer carrying it is stored (`memory/turn-writes.ts`), so a turn that was
 * blocked, failed or abandoned has nothing here to list.
 *
 * Ownership: every query is scoped `where: { userId, ... }`, so a caller can
 * only ever see their own plans. The free-text fields (if-cue, then-action,
 * target) are decrypted on the fly; an undecryptable row (a key rotated out of
 * the map) is skipped rather than 500ing the whole list.
 *
 * Not gated on the Coach. A plan is the person's own stored record: reading
 * it never depends on the Coach being available, the same rule as the stored
 * facts and conversations (a Coach switched off by the operator or hidden by
 * the person must not lock them out of what it kept). Activating a proposed
 * plan is Coach use and stays gated on the PATCH route.
 * The owner is always narrowed from the session, never the body.
 *
 * `?status=proposed|active|met|abandoned` optionally filters the list (e.g.
 * the chat thread fetches `proposed` to surface confirm cards). `?scope=`
 * pulls a named status group instead (`open` | `past` | `all`) so the plans
 * management page reads its whole ledger in one round-trip. Omitted returns
 * the non-terminal set (proposed + active), newest first.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { coachPlansListQuerySchema } from "@/lib/validations/coach-plan";

/** The status sets behind the named `?scope=` groups (`all` = no filter). */
const SCOPE_STATUSES: Record<"open" | "past", string[]> = {
  open: ["proposed", "active", "review_due"],
  past: ["met", "abandoned", "reviewed"],
};

export const GET = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();
  const url = new URL(req.url);
  const parsed = coachPlansListQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    scope: url.searchParams.get("scope") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422);
  }

  // No filter → the non-terminal set (the actionable plans). An explicit
  // status filters to exactly that status; a scope selects a named group
  // (`all` drops the status clause entirely).
  const scope = parsed.data.scope;
  const statusWhere = parsed.data.status
    ? { status: parsed.data.status }
    : scope === "all"
      ? {}
      : scope
        ? { status: { in: SCOPE_STATUSES[scope] } }
        : { status: { in: ["proposed", "active"] } };

  const rows = await prisma.coachPlan.findMany({
    where: { userId: user.id, deletedAt: null, ...statusWhere },
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      metric: true,
      ifCueEncrypted: true,
      thenActionEncrypted: true,
      targetEncrypted: true,
      status: true,
      reviewDate: true,
      sourceConversationId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const plans: Array<{
    id: string;
    metric: string;
    ifCue: string;
    thenAction: string;
    target: string | null;
    status: string;
    reviewDate: string | null;
    sourceConversationId: string | null;
    createdAt: string;
    updatedAt: string;
  }> = [];

  for (const row of rows) {
    let ifCue: string;
    let thenAction: string;
    try {
      ifCue = decryptFromBytes(row.ifCueEncrypted);
      thenAction = decryptFromBytes(row.thenActionEncrypted);
    } catch {
      // Fail closed per row — never surface ciphertext, never 500 the whole
      // list because one row's key id is no longer in the map.
      continue;
    }
    let target: string | null = null;
    if (row.targetEncrypted) {
      try {
        target = decryptFromBytes(row.targetEncrypted);
      } catch {
        target = null;
      }
    }
    plans.push({
      id: row.id,
      metric: row.metric,
      ifCue,
      thenAction,
      target,
      status: row.status,
      reviewDate: row.reviewDate?.toISOString() ?? null,
      // Provenance for the chat surface: the thread only shows proposal
      // cards born in the OPEN conversation, never strays from another one.
      sourceConversationId: row.sourceConversationId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  annotate({
    action: { name: "coach.plans.listed" },
    meta: { count: plans.length },
  });

  return apiSuccess({ plans });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
