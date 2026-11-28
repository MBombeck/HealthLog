"use client";

/**
 * Upload a report or an image from the exam's sheet into the document vault,
 * filed as kind `IMAGING` on the exam's day. The same POST the vault uses,
 * with its busy-retry. `aiRead=defer`: nothing sends an exam's file to a
 * model on its own; the person can still read it from the vault.
 */
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { randomId } from "@/lib/random-id";
import { uploadWithBusyRetry } from "@/components/documents/upload-busy-retry";
import {
  parseUploadResponse,
  type UploadResult,
} from "@/components/documents/vault-utils";

/** What the exam's upload accepts: the vault's PDF and picture types. */
export const IMAGING_UPLOAD_ACCEPT = "application/pdf,image/jpeg,image/png";

export async function uploadImagingDocument(
  file: File,
  examDay: string | null,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return uploadWithBusyRetry(
    async () => {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", "IMAGING");
      form.append("aiRead", "defer");
      if (examDay) form.append("documentDate", examDay);
      const answer = await apiFetchRaw("/api/documents/inbound", {
        method: "POST",
        headers: { "Idempotency-Key": randomId() },
        body: form,
      });
      return parseUploadResponse(
        answer.status,
        await answer.text(),
        answer.headers.get("Retry-After"),
      );
    },
    { signal },
  );
}
