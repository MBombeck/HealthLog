#!/usr/bin/env tsx
/**
 * Compare the freshly-generated OpenAPI spec against the committed
 * `docs/api/openapi.yaml`. Exits non-zero on drift.
 *
 * Used by the CI gate in `.github/workflows/security.yml`. Hard-fails on
 * drift since v1.4.25 — the Zod registry is the source of truth for the
 * public API contract that the v1.5 iOS Swift codegen consumes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { buildOpenApiDocument } from "../src/lib/openapi/registry";

const SPEC_PATH = resolve(__dirname, "..", "docs", "api", "openapi.yaml");

function main(): void {
  const document = buildOpenApiDocument();
  // Must match the options used by `scripts/generate-openapi.ts`.
  // `sortMapEntries` stays off — see that file's header comment for the
  // yaml@2 alias-ordering pitfall under sorted output.
  const generated = stringify(document, {
    sortMapEntries: false,
    lineWidth: 120,
  });
  const committed = readFileSync(SPEC_PATH, "utf8");
  if (generated === committed) {
    console.log("OpenAPI spec in sync with source schemas.");
    return;
  }
  console.error(
    "OpenAPI spec drift detected. Run `pnpm openapi:generate` and commit the result.",
  );
  // Surface a unified-diff-ish hint so PR reviewers see what changed
  // without having to re-run the generator locally.
  const genLines = generated.split("\n");
  const onDiskLines = committed.split("\n");
  const max = Math.max(genLines.length, onDiskLines.length);
  for (let i = 0; i < max; i++) {
    if (genLines[i] !== onDiskLines[i]) {
      console.error(
        `Line ${i + 1}:\n  generated: ${JSON.stringify(genLines[i] ?? "")}\n  committed: ${JSON.stringify(onDiskLines[i] ?? "")}`,
      );
      // Limit the noise — first 5 mismatched lines is enough to point
      // the maintainer at the regenerate command.
      let shown = 1;
      for (let j = i + 1; j < max && shown < 5; j++) {
        if (genLines[j] !== onDiskLines[j]) {
          console.error(
            `Line ${j + 1}:\n  generated: ${JSON.stringify(genLines[j] ?? "")}\n  committed: ${JSON.stringify(onDiskLines[j] ?? "")}`,
          );
          shown++;
        }
      }
      break;
    }
  }
  process.exit(1);
}

main();
