#!/usr/bin/env tsx
/**
 * Emit `docs/api/openapi.yaml` from the registered Zod schemas + route
 * table in `src/lib/openapi/registry.ts`.
 *
 * v1.4.23 baseline: only the iOS-touched routes are registered (see
 * `src/lib/openapi/routes.ts`). The CI step that wraps this script runs
 * with `continue-on-error: true` until the registry catches up with the
 * rest of the hand-maintained `docs/api/openapi.yaml` — once coverage is
 * complete, the gate flips to hard-fail in v1.4.24+.
 *
 * The output is stable across re-runs: `yaml@2` is configured with
 * `sortMapEntries: true` so map keys land in lexicographic order
 * regardless of Node version or the order in which schemas were
 * imported.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { buildOpenApiDocument } from "../src/lib/openapi/registry";

const SPEC_PATH = resolve(__dirname, "..", "docs", "api", "openapi.yaml");

function main(): void {
  const document = buildOpenApiDocument();
  const yaml = stringify(document, {
    sortMapEntries: true,
    lineWidth: 120,
  });
  writeFileSync(SPEC_PATH, yaml, "utf8");
  console.log(`Wrote ${SPEC_PATH} (${yaml.length} bytes)`);
}

main();
