import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
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
