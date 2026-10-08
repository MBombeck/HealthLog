/**
 * Upload routes that do NOT pass through `src/proxy.ts`, and the edge duties
 * `apiHandler` takes over for them.
 *
 * WHY. Next clones the body of every non-GET request the proxy matcher covers
 * so both the proxy and the route can read it, and it reads that clone off the
 * socket into memory up to `experimental.proxyClientMaxBodySize` before the
 * route — and therefore authentication — runs at all. The ceiling was 512 MB
 * so the Apple Health importer could receive whole archives, which meant any
 * anonymous POST to any API path could make the server hold half a gigabyte
 * (twice, one copy per branch of the clone). The ceiling is now 1 MB, and the
 * routes whose legitimate bodies are larger are taken out of the matcher: they
 * stream or bound their own body after authenticating, so nothing reads their
 * body before the caller is known.
 *
 * WHAT THE PROXY DID FOR THEM, AND WHO DOES IT NOW. For an `/api/*` route the
 * proxy refuses traffic in a worker-only container, refuses every mutation on
 * a demo instance (none of these routes is on the demo allowlist), sets the
 * transport security headers and a CSP, and echoes `x-request-id`. `apiHandler`
 * does all of that for the routes listed here (`bypassRouteRefusal`,
 * `applyBypassRouteHeaders`); it already echoes `x-request-id` for every route.
 * The legacy redirects, the retired-route 410s and the page session gate never
 * applied to these paths.
 *
 * ONE LIST, TWO READERS. The matcher in `src/proxy.ts` must be a literal Next
 * can analyse at build time, so it cannot import this list; a test compiles the
 * matcher exactly as Next does and checks it excludes every path here and
 * nothing else under `/api`.
 */
import { shouldRunWeb } from "@/lib/process-type";
import { DEMO_REFUSAL_BODY } from "@/lib/demo-refusal";

export const PROXY_BYPASS_ROUTES: readonly string[] = [
  // Streamed archive uploads, up to 1.5 GB.
  "/api/import/apple-health-export",
  "/api/import/health-connect-export",
  "/api/admin/import-apple-health-export",
  // Backup file upload, up to 512 MB raw.
  "/api/admin/backups/upload",
  // Document vault upload, admin-tunable per-file cap.
  "/api/documents/inbound",
  // Bulk JSON / CSV imports, 16 MB.
  "/api/import",
  "/api/import/csv",
  "/api/medications/intake/dose-history-import",
  // Lab scan upload, 12 MB.
  "/api/labs/ocr/extract",
  // Avatar image, 2 MB.
  "/api/user/avatar",
  // Native-client batches: measurements 4 MB, workouts 5 MB, the rest 2 MB.
  "/api/measurements/batch",
  "/api/workouts/batch",
  "/api/insights/ecg",
  "/api/mood-entries/bulk",
  "/api/medications/intake/bulk",
  "/api/cycle/day-logs/bulk",
];

export function isProxyBypassRoute(pathname: string): boolean {
  const normalised =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PROXY_BYPASS_ROUTES.includes(normalised);
}

/**
 * The transport security headers the proxy puts on every response. Shared so
 * the proxy and the bypass routes cannot drift apart.
 */
export function setBaselineSecurityHeaders(headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  // The same pair the proxy sets on every page and API response. The bypass
  // routes (uploads, imports, native batches) answered without them, so a
  // cross-origin page could embed one of their JSON answers as a no-cors
  // subresource where every other route refuses it.
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  headers.set("X-Permitted-Cross-Domain-Policies", "none");
  if (process.env.NODE_ENV !== "development") {
    headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }
}

/**
 * The CSP for a bypass route's response. These answer JSON, never a page, so
 * the response may load nothing and be framed by nobody.
 */
export const BYPASS_ROUTE_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function applyBypassRouteHeaders(headers: Headers): void {
  setBaselineSecurityHeaders(headers);
  headers.set("Content-Security-Policy", BYPASS_ROUTE_CSP);
}

/**
 * The refusals the proxy would have answered with, in the same shape.
 * Returns null when the request may proceed.
 */
export function bypassRouteRefusal(method: string): Response | null {
  if (!shouldRunWeb()) {
    return Response.json(
      {
        data: null,
        error:
          "This container runs the worker only — point HTTP at the web service.",
      },
      { status: 503, headers: { "X-HealthLog-Process-Type": "worker" } },
    );
  }
  const m = method.toUpperCase();
  const isMutation = m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
  if (process.env.DEMO_MODE === "true" && isMutation) {
    return Response.json(DEMO_REFUSAL_BODY, { status: 403 });
  }
  return null;
}
