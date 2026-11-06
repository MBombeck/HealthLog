"use client";

/**
 * The Coach's "attach a new file" upload: one POST to the document vault,
 * with the vault's busy-retry (`upload-busy-retry.ts`), so a file attached
 * while the vault is still uploading in another tab waits for a free slot
 * instead of failing.
 */
import { useEffect, useRef, type RefObject } from "react";

import { apiFetchRaw } from "@/lib/api/api-fetch";
import { randomId } from "@/lib/random-id";
import { uploadWithBusyRetry } from "@/components/documents/upload-busy-retry";
import {
  parseUploadResponse,
  type UploadResult,
} from "@/components/documents/vault-utils";

export interface CoachAttachmentUpload {
  result: UploadResult;
  /** The last response, for the error toast's cause. */
  response: Response | undefined;
}

/** Upload one file; a network failure throws, every HTTP answer resolves. */
export async function uploadCoachAttachment(
  file: File,
  signal: AbortSignal | undefined,
): Promise<CoachAttachmentUpload> {
  let response: Response | undefined;
  const result = await uploadWithBusyRetry(
    async () => {
      const form = new FormData();
      form.append("file", file);
      const answer = await apiFetchRaw("/api/documents/inbound", {
        method: "POST",
        headers: { "Idempotency-Key": randomId() },
        body: form,
      });
      response = answer;
      return parseUploadResponse(
        answer.status,
        await answer.text(),
        answer.headers.get("Retry-After"),
      );
    },
    { signal },
  );
  return { result, response };
}

/** A signal that aborts when the component unmounts, so no retry timer outlives it. */
export function useUnmountSignal(): RefObject<AbortSignal | undefined> {
  const signal = useRef<AbortSignal | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    signal.current = controller.signal;
    return () => controller.abort();
  }, []);
  return signal;
}
