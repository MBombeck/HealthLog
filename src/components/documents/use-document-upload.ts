"use client";

/**
 * The vault's upload manager: a client-side queue with concurrency 3, one
 * multipart XHR POST per file (XHR because it exposes real upload-progress
 * events with zero dependencies — fetch upload streaming is not portable),
 * client-side image downscaling, and per-file terminal states.
 *
 * Perceived-speed contract: `enqueue()` adds pending entries synchronously
 * (< 100 ms — before any network work), each carrying live progress. A
 * finished file leaves the queue and the list/usage queries refetch; a
 * failed file stays as an inline error card until dismissed (an over-limit
 * file fails individually, the batch continues).
 *
 * Duplicate contract (§3.2): a same-user re-upload returns HTTP 200 with
 * envelope-level `meta.duplicate: true` and the EXISTING row — the manager
 * toasts "already stored" and hands the row id to the timeline for a brief
 * highlight. This is the one call site that must read success-side `meta`;
 * `parseUploadResponse` in `vault-utils.ts` owns that parse.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useTranslations } from "@/lib/i18n/context";
import { randomId } from "@/lib/random-id";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import {
  parseUploadResponse,
  type UploadFailure,
  type UploadResult,
} from "./vault-utils";

/** Client-side parallelism — matches the plan's NAS memory envelope. */
const CONCURRENCY = 3;

/** Longest-edge ceiling for the client-side image downscale. */
const IMAGE_MAX_EDGE = 3000;

/** How long a duplicate-highlight ring stays on the existing row. */
const HIGHLIGHT_MS = 2600;

/** Only raster photo formats are re-encoded — never PDFs/Office, never GIF
 *  (re-encoding would flatten an animation and GIF photos don't exist). */
const DOWNSCALE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface UploadQueueItem {
  /** Local id — NOT a server id; stable for the item's queue lifetime. */
  localId: string;
  fileName: string;
  byteSize: number;
  status: "uploading" | "error";
  /** 0..1 upload progress (transport bytes, not server processing). */
  progress: number;
  /** Terminal failure detail, present when `status === "error"`. */
  failure?: UploadFailure;
}

export interface EnqueueOptions {
  /** Pre-link every uploaded document to this episode (deep-link uploads). */
  episodeId?: string;
}

interface UploadLimits {
  maxFileBytes: number;
}

/**
 * Downscale a raster photo to ≤ 3000 px longest edge (canvas, JPEG 0.85).
 * Returns the original file untouched when the type is not a raster photo,
 * the image is already small enough, or anything about decoding fails —
 * a downscale must never block an upload.
 */
async function downscaleImage(file: File): Promise<File> {
  if (!DOWNSCALE_TYPES.has(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= IMAGE_MAX_EDGE) {
      bitmap.close();
      return file;
    }
    const scale = IMAGE_MAX_EDGE / longest;
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) return file;
    const stem = file.name.replace(/\.[^.]+$/u, "") || "photo";
    return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/**
 * One multipart POST via XHR, reporting upload progress.
 *
 * Exported for the unit test: this function mints the `Idempotency-Key`,
 * and it did so with `crypto.randomUUID()`, which a plain-HTTP origin does
 * not expose. The test drives it with that property absent.
 */
export function uploadViaXhr(
  file: File,
  options: EnqueueOptions,
  onProgress: (fraction: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents/inbound");
    // Retry-safe by construction: the server honours Idempotency-Key, so a
    // network blip that DID land server-side cannot double-store on retry.
    xhr.setRequestHeader("Idempotency-Key", randomId());
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      resolve(parseUploadResponse(xhr.status, xhr.responseText));
    });
    xhr.addEventListener("error", () =>
      resolve({ ok: false, reason: "generic" }),
    );
    xhr.addEventListener("abort", () =>
      resolve({ ok: false, reason: "generic" }),
    );
    const fd = new FormData();
    fd.append("file", file);
    if (options.episodeId) fd.append("episodeIds", options.episodeId);
    xhr.send(fd);
  });
}

/**
 * The pure settle decision — what a finished upload does to the UI.
 *
 * Every success flashes the row (fresh upload → the new row, duplicate →
 * the existing row); only the duplicate additionally toasts. Exported for
 * the unit test: until v1.37.19 only the duplicate branch flashed, so a
 * fresh upload gave no feedback beyond its queue row disappearing.
 */
export function settleDecision(result: UploadResult): {
  removeFromQueue: boolean;
  toastDuplicate: boolean;
  flashId: string | null;
} {
  if (!result.ok) {
    return { removeFromQueue: false, toastDuplicate: false, flashId: null };
  }
  return {
    removeFromQueue: true,
    toastDuplicate: result.duplicate,
    flashId: result.document.id,
  };
}

export interface DocumentUploadManager {
  /** Live queue — uploading entries first-in-first, then error entries. */
  items: UploadQueueItem[];
  /** Add files to the queue; returns immediately (optimistic entries). */
  enqueue: (files: File[], options?: EnqueueOptions) => void;
  /** Remove a terminal (error) entry from the queue. */
  dismiss: (localId: string) => void;
  /** Row id to briefly highlight (duplicate upload → the existing row). */
  highlightId: string | null;
}

export function useDocumentUpload(
  limits: UploadLimits | undefined,
): DocumentUploadManager {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const activeRef = useRef(0);
  const pendingRef = useRef<
    { localId: string; file: File; options: EnqueueOptions }[]
  >([]);
  const mountedRef = useRef(true);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, []);

  const patchItem = useCallback(
    (localId: string, patch: Partial<UploadQueueItem>) => {
      if (!mountedRef.current) return;
      setItems((prev) =>
        prev.map((it) => (it.localId === localId ? { ...it, ...patch } : it)),
      );
    },
    [],
  );

  const removeItem = useCallback((localId: string) => {
    if (!mountedRef.current) return;
    setItems((prev) => prev.filter((it) => it.localId !== localId));
  }, []);

  const flashHighlight = useCallback((id: string) => {
    if (!mountedRef.current) return;
    setHighlightId(id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => {
      if (mountedRef.current) setHighlightId(null);
    }, HIGHLIGHT_MS);
  }, []);

  const settle = useCallback(
    (localId: string, result: UploadResult) => {
      if (!result.ok) {
        patchItem(localId, { status: "error", failure: result, progress: 0 });
        return;
      }
      const decision = settleDecision(result);
      removeItem(localId);
      void invalidateKeys(queryClient, [queryKeys.documents()]);
      if (decision.toastDuplicate) {
        toast.info(t("documents.toast.duplicate"));
      }
      if (decision.flashId) flashHighlight(decision.flashId);
    },
    [flashHighlight, patchItem, queryClient, removeItem, t],
  );

  const pump = useCallback(() => {
    while (
      activeRef.current < CONCURRENCY &&
      pendingRef.current.length > 0 &&
      mountedRef.current
    ) {
      const next = pendingRef.current.shift();
      if (!next) return;
      activeRef.current += 1;
      void (async () => {
        try {
          const prepared = await downscaleImage(next.file);
          const result = await uploadViaXhr(prepared, next.options, (f) =>
            patchItem(next.localId, { progress: f }),
          );
          settle(next.localId, result);
        } finally {
          activeRef.current -= 1;
          pump();
        }
      })();
    }
  }, [patchItem, settle]);

  const enqueue = useCallback(
    (files: File[], options: EnqueueOptions = {}) => {
      if (files.length === 0) return;
      const fresh: UploadQueueItem[] = [];
      for (const file of files) {
        const localId = randomId();
        // Client pre-flight against the server's configured cap: an obvious
        // giant (a CD image) fails instantly and locally — friendly reason,
        // no wasted transfer. The server re-enforces regardless.
        if (limits && file.size > limits.maxFileBytes) {
          fresh.push({
            localId,
            fileName: file.name,
            byteSize: file.size,
            status: "error",
            progress: 0,
            failure: {
              ok: false,
              reason: "fileTooLarge",
              maxFileBytes: limits.maxFileBytes,
            },
          });
          continue;
        }
        fresh.push({
          localId,
          fileName: file.name,
          byteSize: file.size,
          status: "uploading",
          progress: 0,
        });
        pendingRef.current.push({ localId, file, options });
      }
      setItems((prev) => [...prev, ...fresh]);
      pump();
    },
    [limits, pump],
  );

  const dismiss = useCallback(
    (localId: string) => removeItem(localId),
    [removeItem],
  );

  return { items, enqueue, dismiss, highlightId };
}
