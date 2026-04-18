"use client";

import { useEffect } from "react";
import { ErrorDetails } from "@/components/error-details";

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
  }, [error]);

  return <ErrorDetails error={error} reset={reset} />;
}
