/**
 * #1404 — why background AI work stopped for this account.
 *
 * The list Settings, AI renders: one entry per kind of background work (and
 * per document, for document work) whose latest run failed, with the closed
 * code the client turns into a sentence. A later success removes the entry.
 * Own account only, like the rest of the AI settings; a document's entries
 * also ride its detail read, which a guardian reaches inside a managed
 * profile.
 *
 * A status read, not AI work: it calls no model and asks no capability.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { listAiJobFailures } from "@/lib/ai/job-failure/read";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const failures = await listAiJobFailures(user.id);
  annotate({
    action: { name: "ai.job_failures.list" },
    meta: { count: failures.length },
  });
  return apiSuccess({ failures });
});
