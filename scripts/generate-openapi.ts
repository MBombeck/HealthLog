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
 * The output is stable across re-runs because the upstream order is
 * itself deterministic: Zod preserves schema property declaration
 * order and the path table is a single object literal in
 * `src/lib/openapi/routes.ts`. `yaml@2`'s `sortMapEntries` option is
 * intentionally NOT set — when enabled, the emitter reorders keys
 * alphabetically and can place an `*alias` reference before its
 * `&anchor` definition, which triggers `verifyAliasOrder` and throws
 * `Unresolved alias` during `stringify`. This started biting once
 * `.meta()`-tagged sub-schemas were nested inside `z.array(...)` for
 * the v1.4.48 admin diagnostic envelope: the array's element-schema
 * anchor lives under `recentPushAttempts` (sorted to the bottom of
 * the data object) while the alias from `notificationChannels`
 * (sorted above it) refers to the same `$ref`. Leaving the source
 * order intact keeps anchors emitted before their aliases.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { buildOpenApiDocument } from "../src/lib/openapi/registry";

const SPEC_PATH = resolve(__dirname, "..", "docs", "api", "openapi.yaml");

function main(): void {
  const document = buildOpenApiDocument();
  const yaml = stringify(document, {
    sortMapEntries: false,
    lineWidth: 120,
  });
  writeFileSync(SPEC_PATH, yaml, "utf8");
  console.log(`Wrote ${SPEC_PATH} (${yaml.length} bytes)`);
}

main();
