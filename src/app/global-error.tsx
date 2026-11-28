"use client";

import { useEffect } from "react";

import { errorIdOf, recordErrorId, shortErrorId } from "@/lib/errors/error-id";
import { reloadOnceForChunkError } from "@/lib/pwa/chunk-reload";

/**
 * Root-level error boundary. Renders when even the root layout itself fails,
 * so it cannot rely on any providers (i18n, query, auth). Keep it static,
 * in English, and self-contained.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // A chunk of the root layout's client tree missing after a deploy lands
  // here rather than in `app/error.tsx`; it gets the same single reload.
  useEffect(() => {
    reloadOnceForChunkError(error);
  }, [error]);

  // The id the operator finds this failure by. No i18n provider exists at
  // this level, so the line is the same static bilingual pair as the heading.
  const errorId = errorIdOf(error, { unexpected: true });
  useEffect(() => {
    if (errorId) recordErrorId(errorId);
  }, [errorId]);

  async function handleCopyId() {
    if (!errorId) return;
    try {
      await navigator.clipboard.writeText(errorId);
    } catch {
      window.prompt("Error ID", errorId);
    }
  }

  async function handleCopy() {
    // Strip query string — OAuth callback routes carry sensitive tokens.
    const loc = typeof window !== "undefined" ? window.location : null;
    const payload = {
      message: error.message,
      digest: error.digest,
      errorId,
      name: error.name,
      stack: error.stack?.split("\n").slice(0, 10).join("\n"),
      urlPath: loc?.pathname ?? null,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      timestamp: new Date().toISOString(),
    };
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("Copy details", text);
    }
  }

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          backgroundColor: "#101113",
          color: "#f8f8f2",
          margin: 0,
          // v1.4.27 — `100dvh` follows the dynamic viewport on
          // iOS Safari (URL-bar collapse) so the wrapper still
          // anchors centred when the browser chrome animates in or
          // out. `safe-area-inset-top` keeps the headline out from
          // under the notch / Dynamic Island. The one direct
          // `env(safe-area-*)` outside globals.css: this boundary replaces
          // the root layout, so the stylesheet that defines
          // `--safe-area-top` is not on the page.
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "calc(env(safe-area-inset-top, 0px) + 24px) 24px 24px 24px",
        }}
      >
        <div style={{ maxWidth: 560 }}>
          {/*
            v1.4.43 — bilingual lockup so a German user landing
            in this boundary doesn't read pure English in an already-
            bad-state moment. The root layout has failed by the time
            this fires, so no i18n provider is available; the static
            DE/EN pairing covers the dominant audience without a
            runtime cost. Copy tightened per the v1.4.43 audit (L1)
            to drop the verbose secondary sentence.
          */}
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>
            Etwas ist schiefgegangen / Something went wrong
          </h1>
          <p style={{ color: "#d0d0d0", marginBottom: 16, fontSize: 14 }}>
            Ein kritischer Fehler ist aufgetreten. / A critical error occurred.
          </p>
          <pre
            style={{
              background: "#1a1b1f",
              padding: 12,
              borderRadius: 6,
              fontSize: 12,
              overflow: "auto",
              marginBottom: 16,
              border: "1px solid #3b3c41",
            }}
          >
            {error.message || "Unknown error"}
          </pre>
          {errorId && (
            <p
              data-slot="error-id"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: "#d0d0d0",
                marginBottom: 16,
              }}
            >
              <span>Fehler-ID / Error ID</span>
              <code style={{ color: "#f8f8f2" }}>{shortErrorId(errorId)}</code>
              <button
                type="button"
                onClick={handleCopyId}
                aria-label="Copy error ID"
                style={{
                  background: "transparent",
                  color: "#f8f8f2",
                  border: "1px solid #3b3c41",
                  borderRadius: 6,
                  minHeight: 44,
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                Copy
              </button>
            </p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={reset}
              style={{
                background: "#ebebf5",
                color: "#101113",
                border: "none",
                borderRadius: 6,
                // v1.4.27 — 44 px minimum height matches the
                // app-wide tap-target floor; the larger inline padding
                // keeps the labels comfortably finger-tap-sized.
                minHeight: 44,
                padding: "10px 16px",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Retry
            </button>
            <button
              onClick={handleCopy}
              style={{
                background: "transparent",
                color: "#f8f8f2",
                border: "1px solid #3b3c41",
                borderRadius: 6,
                minHeight: 44,
                padding: "10px 16px",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Copy details
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
