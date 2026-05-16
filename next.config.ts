import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // v1.4.33 IW2 — strip `console.*` calls from the production bundle
  // (keep `console.error` + `console.warn` so the GlitchTip reporter
  // and prod-side debug rails still surface). The Lighthouse audit
  // flagged ~211 KiB of bundled JS as "unminified" — Turbopack already
  // mangles + minifies the chunks, but the in-tree `console.log`
  // breadcrumbs from the chart wiring + Coach SSE handlers carried
  // hundreds of preserved string literals through to the client. The
  // SWC compiler drops the calls + their literal-only arguments
  // entirely in production.
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production"
        ? { exclude: ["error", "warn"] }
        : false,
  },
  // v1.4.33 IW2 — bfcache hygiene. `Permissions-Policy: unload=()`
  // tells the browser the page does not need the `unload` event,
  // which Chromium uses as a hint to admit the page to the
  // back/forward cache on navigation away. Pair with the absence of
  // any `beforeunload` / `unload` listener in our own code so the
  // bfcache restore path stays clear. The other CSP-style security
  // headers already live on the response via the standalone runtime;
  // we add only the bfcache hint here.
  //
  // v1.4.34 IW-A — second rule layers the bfcache-friendly
  // `Cache-Control` directive onto every authenticated HTML page
  // response (the source negative-lookahead excludes `/api/*` and
  // `/_next/*` so static assets keep their immutable caching and API
  // routes keep their explicit headers). The framework default for
  // pages that read cookies is `no-store, must-revalidate`, which
  // Chromium counts as a hard bfcache breaker. `private, max-age=0,
  // must-revalidate` keeps shared caches out (proxies, CDNs cannot
  // store personal data), still forces revalidation on every
  // navigation so session swaps detect on the wire, and is
  // bfcache-eligible — back/forward navigation restores the page
  // from memory instead of paying a full reload. See
  // `src/lib/http/cache-headers.ts` for the typed constant reused by
  // route handlers that opt into the same posture.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Permissions-Policy", value: "unload=()" },
        ],
      },
      {
        source: "/((?!api|_next).*)",
        headers: [
          {
            key: "Cache-Control",
            value: "private, max-age=0, must-revalidate",
          },
        ],
      },
    ];
  },
  serverExternalPackages: [
    "@prisma/client",
    "pg-boss",
    "@prisma/adapter-pg",
    "pg",
  ],
  // v1.4.25 Fix-G — `src/lib/ai/prompts/safety-contracts.ts` reads its
  // sibling YAML files at runtime via `__dirname + readFileSync`. The
  // standalone bundler ships the JS but not the YAML, so the build
  // crashed during page-data collection with ENOENT once the Turbopack
  // chunking-error layer was cleared. Telling Next to trace the YAML
  // files explicitly keeps them in the runtime image alongside the
  // bundled module.
  outputFileTracingIncludes: {
    "*": ["./src/lib/ai/prompts/safety-contracts.*.yaml"],
  },
  // v1.4.34 IW-A — silence the Turbopack NFT trace warnings emitted
  // during `next build`. The tracer follows the `MAXMIND_LICENSE_KEY`
  // env access in `src/lib/geo.ts` back into the config file, then
  // emits "cannot be traced" warnings for paths it tried to walk
  // (next.config.ts → mood-entries/bulk route, etc.). The standalone
  // bundle is controlled by `output: "standalone"` above; this exclude
  // only narrows trace reporting and has no runtime effect.
  outputFileTracingExcludes: {
    "*": ["./next.config.ts"],
  },
  experimental: {
    optimizePackageImports: ["recharts", "lucide-react"],
  },
};

/**
 * v1.4.28 R3d — opt-in bundle analyzer behind `ANALYZE=1`.
 *
 * `pnpm analyze` (defined in `package.json`) sets the env var and
 * runs `next build`; the analyzer writes static HTML reports to
 * `.next/analyze/*.html`. The wrapper is a no-op when the env var is
 * unset so the regular `pnpm build` pipeline pays nothing.
 */
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "1",
});

export default withBundleAnalyzer(nextConfig);
