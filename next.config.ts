import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

import { version as PKG_VERSION } from "./package.json";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // v1.4.38.4 — expose the package.json version to the client bundle
  // so the `<VersionPoller>` can compare the shell-baked version
  // against the live `/api/version` response and trigger a self-heal
  // (SW unregister + cache wipe + hard reload) when the server moves
  // ahead of the running shell after a deploy. Without this the user
  // had to discover "pull-to-refresh" themselves after every release.
  env: {
    NEXT_PUBLIC_APP_VERSION: PKG_VERSION,
  },
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
  // v1.8.0 — the routed Insights sub-pages migrated from German to
  // English slugs (`/insights/blutdruck` → `/insights/blood-pressure`,
  // …). Every legacy German URL 301-redirects to its English target so
  // bookmarks, the PWA's cached navigation, and any external link keep
  // resolving. The redirect set is exhaustive and matches the rename
  // table in `docs/adr/0001-insights-naming-convention.md`; the slug
  // registry itself lives in `src/lib/insights/sub-page-metric.ts`.
  // `bmi`, `hrv`, and `workouts` were already English and need no entry.
  async redirects() {
    const insightsSlugRenames: Array<[string, string]> = [
      ["blutdruck", "blood-pressure"],
      ["puls", "pulse"],
      ["sauerstoff", "oxygen"],
      ["koerpertemperatur", "body-temperature"],
      ["atemfrequenz", "respiratory-rate"],
      ["gewicht", "weight"],
      ["koerperwasser", "body-water"],
      ["knochenmasse", "bone-mass"],
      ["fettfreie-masse", "fat-free-mass"],
      ["fettmasse", "fat-mass"],
      ["muskelmasse", "muscle-mass"],
      ["viszeralfett", "visceral-fat"],
      ["magermasse", "lean-body-mass"],
      ["aktive-energie", "active-energy"],
      ["stockwerke", "flights-climbed"],
      ["gehstrecke", "walking-distance"],
      ["gangstabilitaet", "walking-steadiness"],
      ["gehpuls", "walking-heart-rate"],
      ["gangasymmetrie", "walking-asymmetry"],
      ["doppelstandphase", "double-support-time"],
      ["schrittlaenge", "step-length"],
      ["gehgeschwindigkeit", "walking-speed"],
      ["schlaf", "sleep"],
      ["ruhepuls", "resting-pulse"],
      ["pulswellengeschwindigkeit", "pulse-wave-velocity"],
      ["gefaessalter", "vascular-age"],
      ["laermbelastung", "environmental-audio"],
      ["kopfhoererpegel", "headphone-audio"],
      ["laermereignisse", "audio-events"],
      ["tageslicht", "daylight"],
      ["blutzucker", "blood-glucose"],
      ["hauttemperatur", "skin-temperature"],
      ["stimmung", "mood"],
      ["medikamente", "medications"],
    ];
    return insightsSlugRenames.flatMap(([from, to]) => [
      {
        source: `/insights/${from}`,
        destination: `/insights/${to}`,
        permanent: true,
      },
      // Preserve any nested path (e.g. a future `/insights/sleep/2026-05-31`).
      {
        source: `/insights/${from}/:path*`,
        destination: `/insights/${to}/:path*`,
        permanent: true,
      },
    ]);
  },
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
