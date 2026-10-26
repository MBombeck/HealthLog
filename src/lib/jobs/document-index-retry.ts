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
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { prisma } from "@/lib/db";
import { enqueueDocumentIndex } from "@/lib/jobs/document-index";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";

/** Documents enqueued per boot; the rest wait for the next one. */
const MAX_ENQUEUES_PER_BOOT = 1000;

/** Marked documents read per query. */
const PAGE_SIZE = 500;

/**
 * The marks are walked by id with a cursor, and an account found with the
 * module off is left out of every later page. Taking the first thousand by id
 * once let one such account's marks fill the whole boot, every boot, while
 * the accounts after it never got their retry.
 */
export async function enqueueBootTimeIndexRetry(): Promise<{
  enqueued: number;
}> {
  const moduleOff: string[] = [];
  const moduleOn = new Set<string>();
  let marked = 0;
  let enqueued = 0;
  let cursor: string | null = null;

  walk: for (;;) {
    const rows: { id: string; userId: string }[] =
      await prisma.inboundDocument.findMany({
        where: {
          deletedAt: null,
          lastIndexAttemptAt: null,
          lastIndexOutcome: { not: null },
          contentIndex: { is: null },
          ...OWNED_BY_ACTIVE_ACCOUNT,
          ...(moduleOff.length > 0 ? { userId: { notIn: moduleOff } } : {}),
          // Past the last row read. Not Prisma's `cursor` + `skip`: the
          // cursor row may belong to an account the filter now leaves out,
          // and `skip` would then drop a row that was never read.
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, userId: true },
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
      });
    if (rows.length === 0) break;
    marked += rows.length;

    for (const { id, userId } of rows) {
      if (moduleOff.includes(userId)) continue;
      if (!moduleOn.has(userId)) {
        if (!(await isModuleEnabled(userId, "inboundDocuments"))) {
          moduleOff.push(userId);
          continue;
        }
        moduleOn.add(userId);
      }
      const { enqueued: ok } = await enqueueDocumentIndex(userId, id);
      if (ok) enqueued += 1;
      if (enqueued >= MAX_ENQUEUES_PER_BOOT) break walk;
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < PAGE_SIZE) break;
  }

  annotate({
    action: { name: "documents.contentIndex.retry.boot" },
    meta: { marked, enqueued, moduleOffAccounts: moduleOff.length },
  });
  return { enqueued };
}
