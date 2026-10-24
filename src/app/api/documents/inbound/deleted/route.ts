/**
 * Document vault: Recently deleted.
 *
 * GET lists the caller's deleted documents that the purge has not removed yet,
 * newest deletion first, each with the moment it becomes due for the purge.
 * Restoring one is `POST /api/documents/inbound/{id}/restore` (or the bulk
 * route's `restore`); removing one for good ahead of time is
 * `POST /api/documents/inbound/{id}/purge`.
 *
 * Owner-only, like the restore and delete beside it: a deleted document is the
 * owner's decision in progress, and nothing a delegate may do (restore, delete
 * now) is a verb a grant admits. A bare `requireAuth()` therefore refuses the
 * request while it acts inside somebody else's record, and refuses a narrow
 * token.
 *
 * Metadata only. The encrypted blob is never selected; a deleted document's
 * original, thumbnail and AI surfaces stay closed until it is restored.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiListSuccess } from "@/lib/api/list-cap";
import { prisma } from "@/lib/db";
import { DOCUMENT_PURGE_GRACE_DAYS } from "@/lib/documents/inbound-constants";
import { documentPurgeAt } from "@/lib/documents/tombstones";
import { listPage } from "@/lib/http/list-query";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { dateOnlyKey } from "@/lib/tz/date-only";
import {
  toDocumentSourceSystem,
  type DeletedDocumentListDto,
  type InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

/**
 * Rows per answer. Thirty days of deletions rarely come near it; a person who
 * cleared out a large import gets the newest ones and the list-cap notice.
 */
const DELETED_DOCUMENTS_LIMIT = 200;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const { rows, cap } = await listPage(DELETED_DOCUMENTS_LIMIT, (take) =>
    prisma.inboundDocument.findMany({
      where: { userId: user.id, deletedAt: { not: null } },
      select: {
        id: true,
        kind: true,
        title: true,
        filename: true,
        mimeType: true,
        byteSize: true,
        documentDate: true,
        sourceSystem: true,
        deletedAt: true,
      },
      orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
      take,
    }),
  );

  const payload: DeletedDocumentListDto = {
    graceDays: DOCUMENT_PURGE_GRACE_DAYS,
    documents: rows.map((row) => {
      // Selected under `deletedAt: { not: null }`.
      const deletedAt = row.deletedAt as Date;
      return {
        id: row.id,
        kind: row.kind as InboundDocumentKindValue,
        title: row.title,
        filename: row.filename,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        documentDate: row.documentDate ? dateOnlyKey(row.documentDate) : null,
        sourceSystem: toDocumentSourceSystem(row.sourceSystem),
        deletedAt: deletedAt.toISOString(),
        purgeAt: documentPurgeAt(deletedAt).toISOString(),
      };
    }),
  };

  annotate({
    action: { name: "documents.trash.list" },
    meta: { count: rows.length, truncated: cap.truncated },
  });

  return apiListSuccess(payload, cap);
});
