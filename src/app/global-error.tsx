"use client";

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
  async function handleCopy() {
    // Strip query string — OAuth callback routes carry sensitive tokens.
    const loc =
      typeof window !== "undefined" ? window.location : null;
    const payload = {
      message: error.message,
      digest: error.digest,
      name: error.name,
      stack: error.stack?.split("\n").slice(0, 10).join("\n"),
      urlPath: loc?.pathname ?? null,
      userAgent:
        typeof navigator !== "undefined" ? navigator.userAgent : null,
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
          backgroundColor: "#1e1f29",
          color: "#f8f8f2",
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 560 }}>
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>
            Something went wrong
          </h1>
          <p style={{ color: "#d0d0d0", marginBottom: 16, fontSize: 14 }}>
            A critical error occurred. You can retry or copy the details for
            support.
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
            {error.message || "Unknown error"}
          </pre>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={reset}
              style={{
                background: "#bd93f9",
                color: "#282a36",
                border: "none",
                borderRadius: 6,
                padding: "8px 14px",
                cursor: "pointer",
                fontSize: 13,
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
                border: "1px solid #44475a",
                borderRadius: 6,
                padding: "8px 14px",
                cursor: "pointer",
                fontSize: 13,
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
