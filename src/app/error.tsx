"use client";

import { useEffect } from "react";
import { ErrorDetails } from "@/components/error-details";
import { reloadOnceForChunkError } from "@/lib/pwa/chunk-reload";

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

    // v1.4.38.3 — auto-recover from a stale-shell chunk-load error with a
    // single reload (`src/lib/pwa/chunk-reload.ts`, shared with the root
    // boundary).
    reloadOnceForChunkError(error);
  }, [error]);

  return <ErrorDetails error={error} reset={reset} />;
}
