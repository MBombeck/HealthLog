import type { NextConfig } from "next";

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

export default nextConfig;
