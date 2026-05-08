import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Default `pnpm test` keeps unit tests only — integration suite uses
    // testcontainers and runs separately via `pnpm test:integration`.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
    coverage: {
      provider: "v8",
      // `include` enumerates the full source tree so the report shows
      // per-file coverage for files never imported by a test (vitest 4
      // dropped the `coverage.all` flag and uses `include` for this).
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/generated/**",
        "src/**/__tests__/**",
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
      ],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
