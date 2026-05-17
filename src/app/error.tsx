"use client";

import { useEffect } from "react";
import { ErrorDetails } from "@/components/error-details";

const CHUNK_RELOAD_KEY = "healthlog:chunk-reload-attempted";

function isChunkLoadError(err: Error & { digest?: string }): boolean {
  if (err.name === "ChunkLoadError") return true;
  const msg = err.message ?? "";
  return (
    msg.includes("Loading chunk") ||
    msg.includes("Loading CSS chunk") ||
    msg.includes("Failed to load chunk") ||
    msg.includes("Failed to fetch dynamically imported module")
  );
}

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to any client-side error tracker that's already hooked up.
    if (typeof window !== "undefined") {
      const g = window as typeof window & {
        __healthlog_onError?: (err: Error & { digest?: string }) => void;
      };
      g.__healthlog_onError?.(error);
    }

    // v1.4.38.3 — auto-recover from a stale-shell chunk-load error.
    // After a deploy the cached shell still references old chunk
    // filenames; they 404 and Next.js surfaces them as `ChunkLoadError`.
    // A single hard reload fetches the new shell + chunk graph.
    // sessionStorage gates the auto-reload so an error we can't recover
    // from (e.g. the new build is also missing the chunk) doesn't loop.
    if (typeof window !== "undefined" && isChunkLoadError(error)) {
      try {
        const already = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
        if (!already) {
          window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
          window.location.reload();
        }
      } catch {
        // sessionStorage can throw under strict privacy modes — fall
        // through to the error UI in that case.
      }
    }
  }, [error]);

  return <ErrorDetails error={error} reset={reset} />;
}
