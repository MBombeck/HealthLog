/**
 * GET /api/documents/inbound/capability
 *
 * Document-scoped AI capability probe (no provider call). Mirrors the labs
 * `/api/labs/ocr/capability` probe but resolves over the DOCUMENT provider
 * order (local-first, codex last — governance fix, oauth-investigation
 * SYNTHESIS §1) and adds the vendor-blind `egress` class so the vault UI can
 * show the "this leaves your machine to a third-party AI" notice BEFORE a read.
 *
 * The `mode` / `pdfSupported` / `egress` here reflect exactly what the document
 * routes (suggest / summary / extract / index) will do, so the affordance the
 * UI offers never diverges from what the endpoint accepts.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { resolveDocumentAiCapability } from "@/lib/documents/provider-order";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("guardian", "documents");

  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const capability = await resolveDocumentAiCapability(user.id);

  annotate({
    action: { name: "documents.ai.capability" },
    meta: {
      available: capability.available,
      mode: capability.mode,
      reason: capability.reason,
      pdfSupported: capability.pdfSupported,
      egress: capability.egress,
      aiReason: capability.ai.reason,
    },
  });

  return apiSuccess(capability);
});
