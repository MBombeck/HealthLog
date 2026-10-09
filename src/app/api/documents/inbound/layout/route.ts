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
  storedDocumentsLayoutChoices,
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

async function readStoredLayout(userId: string): Promise<unknown> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { documentsLayoutJson: true },
  });
  return row?.documentsLayoutJson;
}

export const GET = apiHandler(async () => {
  // Read: the RECORD's presentation, so a delegate browsing somebody's vault
  // sees it the way its owner arranged it. The write below stays the
  // caller's own and refuses under a switch.
  const { user } = await requireRecordAuth("read", "documents");
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const layout = resolveDocumentsLayout(await readStoredLayout(user.id));
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
  // left out. Only fields the user has chosen are written, so a field never
  // picked keeps following the default (which can change between releases).
  const choices = {
    ...storedDocumentsLayoutChoices(await readStoredLayout(user.id)),
    ...(parsed.data.view ? { view: parsed.data.view } : {}),
    ...(parsed.data.arrangement
      ? { arrangement: parsed.data.arrangement }
      : {}),
  };
  const next: DocumentsLayout = resolveDocumentsLayout(choices);

  await prisma.user.update({
    where: { id: user.id },
    data: { documentsLayoutJson: toJson({ version: 1, ...choices }) },
  });

  annotate({
    action: { name: "documents.layout.update" },
    meta: { view: next.view, arrangement: next.arrangement },
  });
  return apiSuccess(next);
});
