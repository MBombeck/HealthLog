"use client";

/**
 * Root-level error boundary. Renders when even the root layout itself fails,
 * so it cannot rely on any providers (i18n, query, auth). Keep it static,
 * self-contained, and bilingual: both English and German appear side by side
 * so a German visitor never lands on an all-English last-resort screen, and
 * an English visitor can still read it.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  async function handleCopy() {
    // Strip query string — OAuth callback routes carry sensitive tokens.
    const loc = typeof window !== "undefined" ? window.location : null;
    const payload = {
      message: error.message,
      digest: error.digest,
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
      window.prompt("Details kopieren · Copy details", text);
    }
  }

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          backgroundColor: "#1e1f29",
          color: "#f8f8f2",
          margin: 0,
          // v1.4.27 MB6 — `100dvh` follows the dynamic viewport on
          // iOS Safari (URL-bar collapse) so the wrapper still
          // anchors centred when the browser chrome animates in or
          // out. `safe-area-inset-top` keeps the headline out from
          // under the notch / Dynamic Island.
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding:
            "calc(env(safe-area-inset-top, 0px) + 24px) 24px 24px 24px",
        }}
      >
        <div style={{ maxWidth: 560 }}>
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>
            Etwas ist schiefgegangen · Something went wrong
          </h1>
          <p style={{ color: "#d0d0d0", marginBottom: 16, fontSize: 14 }}>
            Ein kritischer Fehler ist aufgetreten. Du kannst es erneut versuchen
            oder die Details kopieren.
            <br />A critical error occurred. You can retry or copy the details
            for support.
          </p>
          <pre
            style={{
              background: "#282a36",
              padding: 12,
              borderRadius: 6,
              fontSize: 12,
              overflow: "auto",
              marginBottom: 16,
              border: "1px solid #44475a",
            }}
          >
            {error.message || "Unbekannter Fehler · Unknown error"}
          </pre>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={reset}
              style={{
                background: "#bd93f9",
                color: "#282a36",
                border: "none",
                borderRadius: 6,
                // v1.4.27 MB6 — 44 px minimum height matches the
                // app-wide tap-target floor; the larger inline padding
                // keeps the labels comfortably finger-tap-sized.
                minHeight: 44,
                padding: "10px 16px",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Erneut versuchen · Retry
            </button>
            <button
              onClick={handleCopy}
              style={{
                background: "transparent",
                color: "#f8f8f2",
                border: "1px solid #44475a",
                borderRadius: 6,
                minHeight: 44,
                padding: "10px 16px",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Details kopieren · Copy details
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
