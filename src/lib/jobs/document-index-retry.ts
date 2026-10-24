/**
 * Boot discovery: one more content-index attempt for the documents a
 * migration marked for it.
 *
 * Migration 0479 marks a PDF whose last index attempt failed the way a pdf.js
 * clash made it fail by clearing its attempt time and keeping its failure
 * reason. No index attempt leaves that state behind (`recordIndexAttempt`
 * always writes both), so the mark selects exactly those documents and
 * nothing a person or a job produced.
 *
 * Each marked document gets the auto-index job an upload enqueues, so it runs
 * the same provider-first, local-fallback decision under the same consent
 * rules: a deferred import stays local because the document row says so, and
 * an external provider reads it only when the owner opted into automatic
 * reads. The attempt writes its time back, so the document drops out whatever
 * the outcome, and a document that really cannot be read records its reason
 * again and is not picked up at the next boot. An account whose documents
 * module is off keeps its marks until the module is on again; a boot with
 * nothing marked costs one query.
 */
import { prisma } from "@/lib/db";
import { enqueueDocumentIndex } from "@/lib/jobs/document-index";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";

/** Documents enqueued per boot; the rest wait for the next one. */
const MAX_ENQUEUES_PER_BOOT = 1000;

export async function enqueueBootTimeIndexRetry(): Promise<{
  enqueued: number;
}> {
  const rows = await prisma.inboundDocument.findMany({
    where: {
      deletedAt: null,
      lastIndexAttemptAt: null,
      lastIndexOutcome: { not: null },
      contentIndex: { is: null },
    },
    select: { id: true, userId: true },
    orderBy: { id: "asc" },
    take: MAX_ENQUEUES_PER_BOOT,
  });

  const moduleOn = new Map<string, boolean>();
  let enqueued = 0;
  for (const { id, userId } of rows) {
    let on = moduleOn.get(userId);
    if (on === undefined) {
      on = await isModuleEnabled(userId, "inboundDocuments");
      moduleOn.set(userId, on);
    }
    if (!on) continue;
    const { enqueued: ok } = await enqueueDocumentIndex(userId, id);
    if (ok) enqueued += 1;
  }

  annotate({
    action: { name: "documents.contentIndex.retry.boot" },
    meta: { marked: rows.length, enqueued },
  });
  return { enqueued };
}
