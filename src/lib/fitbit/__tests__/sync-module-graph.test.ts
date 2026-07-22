import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FITBIT_DIR = resolve(__dirname, "..");
const LEAF_MODULES = [
  "sync-metrics.ts",
  "sync-activity.ts",
  "sync-sleep.ts",
  "sync-workout.ts",
] as const;

function source(file: string): string {
  return readFileSync(resolve(FITBIT_DIR, file), "utf8");
}

describe("Fitbit sync module graph", () => {
  it("orchestrator statically imports every sync leaf without dynamic imports", () => {
    const orchestrator = source("sync.ts");

    for (const leaf of LEAF_MODULES) {
      const specifier = `./${leaf.replace(/\.ts$/, "")}`;
      expect(orchestrator).toMatch(
        new RegExp(`from\\s+["']${specifier.replace("-", "\\-")}["']`),
      );
      expect(orchestrator).not.toContain(`import("${specifier}")`);
      expect(orchestrator).not.toContain(`import('${specifier}')`);
    }
  });

  it("sync leaves depend on sync-core and never on the orchestrator", () => {
    for (const leaf of LEAF_MODULES) {
      const leafSource = source(leaf);
      expect(leafSource, leaf).toMatch(/from\s+["']\.\/sync-core["']/);
      expect(leafSource, leaf).not.toMatch(/from\s+["']\.\/sync["']/);
      expect(leafSource, leaf).not.toMatch(/import\(["']\.\/sync["']\)/);
    }
  });
});
