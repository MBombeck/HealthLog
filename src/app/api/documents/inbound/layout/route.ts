/**
 * GET / PUT the document vault presentation (view + month arrangement).
 *
 * GET returns the resolved presentation, defaults merged in when the user has
 * not chosen yet. PUT changes it with preserve-when-absent semantics: a body
 * carrying only `view` keeps the stored arrangement and vice versa, the same
 * contract `/api/medications/layout` keeps for its view and order. The blob
 * lives on its own `User` column (`documents_layout_json`) per the
 * per-surface-column convention.
 *
 * Both halves sit behind the documents module gate like every other route
 * under `/api/documents/inbound`.
 */
import { z } from "zod/v4";

import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues, safeJson } from "@/lib/api-response";
import { prisma, toJson } from "@/lib/db";
import {
  DOCUMENTS_LAYOUT_ARRANGEMENTS,
  DOCUMENTS_LAYOUT_VIEWS,
  resolveDocumentsLayout,
  type DocumentsLayout,
} from "@/lib/documents/documents-layout";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";

export const dynamic = "force-dynamic";

const layoutPutSchema = z
  .object({
    version: z.literal(1),
    view: z.enum(DOCUMENTS_LAYOUT_VIEWS).optional(),
    arrangement: z.enum(DOCUMENTS_LAYOUT_ARRANGEMENTS).optional(),
  })
  .strict();

async function readLayout(userId: string): Promise<DocumentsLayout> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { documentsLayoutJson: true },
  });
  return resolveDocumentsLayout(row?.documentsLayoutJson);
}

export const GET = apiHandler(async () => {
  // Read: the RECORD's presentation, so a delegate browsing somebody's vault
  // sees it the way its owner arranged it. The write below stays the
  // caller's own and refuses under a switch.
  const { user } = await requireRecordAuth("read", "documents");
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const layout = await readLayout(user.id);
  annotate({
    action: { name: "documents.layout.read" },
    meta: { view: layout.view, arrangement: layout.arrangement },
  });
  return apiSuccess(layout);
});

export const PUT = apiHandler(async (request: Request) => {
  // Bare on purpose: how the owner's vault is laid out is the owner's choice,
  // not something a helper rearranges on their behalf.
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 1024,
  });
  if (jsonError) return jsonError;

  const parsed = layoutPutSchema.safeParse(body);
  if (!parsed.success) {
    annotate({ action: { name: "documents.layout.validation-failed" } });
    return returnAllZodIssues(parsed.error, 422);
  }

  // Preserve-when-absent: one stored read fills whichever field the body
  // left out.
  const existing = await readLayout(user.id);
  const next: DocumentsLayout = {
    version: 1,
    view: parsed.data.view ?? existing.view,
    arrangement: parsed.data.arrangement ?? existing.arrangement,
  };

  await prisma.user.update({
    where: { id: user.id },
    data: { documentsLayoutJson: toJson(next) },
  });

  annotate({
    action: { name: "documents.layout.update" },
    meta: { view: next.view, arrangement: next.arrangement },
  });
  return apiSuccess(next);
});
