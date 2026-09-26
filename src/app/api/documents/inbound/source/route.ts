/**
 * `GET /api/documents/inbound/source?sourceSystem=…&sourceId=…` — does the
 * vault already hold this import source key? (#1038)
 *
 * Lets an importer skip a document before downloading it from the source
 * system at all: a nightly re-sync of an archive HealthLog already holds then
 * costs one small request per document instead of a download and an upload.
 *
 * It answers only what the upload itself would answer for the same key —
 * `known`, the document `id`, and whether the owner `deleted` it — so a
 * `documents:write` token learns nothing here it could not learn by uploading.
 * That token is the reason the route exists, and it is the second of the two
 * routes the scope reaches (`bearer-scope-enforcement-guard.test.ts`).
 */
import { apiHandler, isScopedCredential, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { DOCUMENTS_WRITE_SCOPE } from "@/lib/documents/scopes";
import {
  checkSourceLookupRateLimit,
  findSourceKey,
} from "@/lib/documents/source-key";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { documentSourceKeySchema } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: Request) => {
  const auth = await requireAuth(DOCUMENTS_WRITE_SCOPE);
  const { user } = auth;

  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const rl = await checkSourceLookupRateLimit(
    isScopedCredential(auth),
    auth.session.id,
    user.id,
  );
  if (!rl.allowed) {
    const response = apiError("Too many lookups. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const url = new URL(request.url);
  const parsed = documentSourceKeySchema.safeParse({
    sourceSystem: url.searchParams.get("sourceSystem") ?? undefined,
    sourceId: url.searchParams.get("sourceId") ?? undefined,
  });
  if (!parsed.success) {
    return apiValidationError(
      "Invalid source key",
      sanitiseZodIssues(parsed.error.issues),
      422,
      { errorCode: "documents.inbound.invalidMetadata" },
    );
  }

  const match = await findSourceKey(
    user.id,
    parsed.data.sourceSystem,
    parsed.data.sourceId,
  );
  annotate({
    action: { name: "documents.vault.sourceLookup" },
    meta: {
      sourceSystem: parsed.data.sourceSystem,
      known: match !== null,
      deleted: match?.state === "deleted",
    },
  });
  return apiSuccess({
    known: match !== null,
    id:
      match === null
        ? null
        : match.state === "live"
          ? match.document.id
          : match.id,
    deleted: match?.state === "deleted",
  });
});
