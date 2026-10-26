/**
 * Reading one vault upload (`POST /api/documents/inbound`): the source key
 * that may ride the query string, the bounded multipart body, the metadata
 * fields beside the file, and the one source key the upload is filed under.
 * Each step answers what it found; the route turns a refusal into its
 * response.
 */
import type { z } from "zod/v4";

import { BodyTooLargeError, readBoundedBody } from "@/lib/labs/ocr-upload";
import {
  documentCreateSchema,
  documentSourceKeySchema,
  type DocumentSourceSystemValue,
} from "@/lib/validations/inbound-documents";

const UPLOAD_BODY_TIMEOUT_MS = 30_000;

export interface QuerySourceKey {
  sourceSystem: DocumentSourceSystemValue;
  sourceId: string;
  sourceInstance?: string;
}

/**
 * The source key in the query string. Both halves or neither; half a key is
 * a mistake worth saying so about.
 */
export function parseQuerySourceKey(
  url: URL,
):
  | { kind: "none" }
  | { kind: "invalid"; issues: z.core.$ZodIssue[] }
  | { kind: "key"; key: QuerySourceKey } {
  const querySystem = url.searchParams.get("sourceSystem");
  const queryId = url.searchParams.get("sourceId");
  const queryInstance = url.searchParams.get("sourceInstance");
  if (querySystem === null && queryId === null) return { kind: "none" };
  const parsedKey = documentSourceKeySchema.safeParse({
    sourceSystem: querySystem ?? undefined,
    sourceId: queryId ?? undefined,
    sourceInstance: queryInstance ?? undefined,
  });
  if (!parsedKey.success) {
    return { kind: "invalid", issues: parsedKey.error.issues };
  }
  return { kind: "key", key: parsedKey.data };
}

/**
 * Read the multipart body, aborting at `bodyCap` bytes or after the upload
 * deadline, and parse it as form data.
 */
export async function readUploadForm(
  request: Request,
  bodyCap: number,
): Promise<
  | { kind: "form"; formData: FormData }
  | { kind: "tooLarge" }
  | { kind: "timeout" }
  | { kind: "invalid" }
> {
  try {
    const bytes = await readBoundedBody(request.body, bodyCap, {
      signal: request.signal,
      deadline: Date.now() + UPLOAD_BODY_TIMEOUT_MS,
    });
    const formData = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body: bytes,
    }).formData();
    return { kind: "form", formData };
  } catch (err) {
    if (err instanceof BodyTooLargeError) return { kind: "tooLarge" };
    if (err instanceof DOMException && err.name === "AbortError") {
      return { kind: "timeout" };
    }
    return { kind: "invalid" };
  }
}

/**
 * The optional metadata (title / kind / documentDate / episodeIds /
 * encounterIds / source key / aiRead): the form fields beside the file. Both
 * id lists may be repeated.
 */
export function parseUploadMetadata(formData: FormData) {
  const rawEpisodeIds = formData
    .getAll("episodeIds")
    .filter((v): v is string => typeof v === "string");
  const rawEncounterIds = formData
    .getAll("encounterIds")
    .filter((v): v is string => typeof v === "string");
  return documentCreateSchema.safeParse({
    title: formData.get("title") ?? undefined,
    kind: formData.get("kind") ?? undefined,
    documentDate: formData.get("documentDate") ?? undefined,
    episodeIds: rawEpisodeIds.length > 0 ? rawEpisodeIds : undefined,
    encounterIds: rawEncounterIds.length > 0 ? rawEncounterIds : undefined,
    sourceSystem: formData.get("sourceSystem") ?? undefined,
    sourceId: formData.get("sourceId") ?? undefined,
    sourceInstance: formData.get("sourceInstance") ?? undefined,
    aiRead: formData.get("aiRead") ?? undefined,
  });
}

/**
 * The key from the query string, or from the form fields; if a caller sends
 * both they have to agree.
 */
export function resolveUploadSourceKey(
  queryKey: QuerySourceKey | null,
  metadata: z.infer<typeof documentCreateSchema>,
):
  | { kind: "mismatch" }
  | {
      kind: "key";
      sourceSystem: DocumentSourceSystemValue | null;
      sourceId: string | null;
      sourceInstance: string | null;
    } {
  const formSystem = metadata.sourceSystem ?? null;
  const formId = formSystem ? (metadata.sourceId ?? null) : null;
  const formInstance = formId ? (metadata.sourceInstance ?? null) : null;
  if (
    queryKey &&
    formSystem !== null &&
    (formSystem !== queryKey.sourceSystem ||
      formId !== queryKey.sourceId ||
      (formInstance !== null &&
        formInstance !== (queryKey.sourceInstance ?? null)))
  ) {
    return { kind: "mismatch" };
  }
  const sourceSystem = queryKey?.sourceSystem ?? formSystem;
  const sourceId = queryKey?.sourceId ?? formId;
  const sourceInstance = sourceId
    ? (queryKey?.sourceInstance ?? formInstance ?? null)
    : null;
  return { kind: "key", sourceSystem, sourceId, sourceInstance };
}
