import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GOOGLE_HEALTH_DIR = join(__dirname, "..");
const LEAVES = [
  "sync-activity.ts",
  "sync-metrics.ts",
  "sync-sleep.ts",
  "sync-workout.ts",
] as const;

function source(file: string): string {
  return readFileSync(join(GOOGLE_HEALTH_DIR, file), "utf8");
}

describe("Google Health sync module graph", () => {
  it("uses static orchestrator-to-leaf imports and never dynamically imports a leaf", () => {
    const orchestrator = source("sync.ts");

    for (const leaf of LEAVES) {
      const moduleName = `./${leaf.replace(/\.ts$/, "")}`;
      const escapedModuleName = moduleName.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      expect(orchestrator).toMatch(
        new RegExp(`from\\s+["']${escapedModuleName}["']`),
      );
      expect(orchestrator).not.toMatch(
        new RegExp(`import\\s*\\(\\s*["']${escapedModuleName}["']`),
      );
    }
  });

  it("keeps every leaf's sync edge pointed only at sync-core", () => {
    for (const leaf of LEAVES) {
      const leafSource = source(leaf);
      const syncImports = Array.from(
        leafSource.matchAll(/from\s+["'](\.\/sync(?:-[^"']+)?)["']/g),
        (match) => match[1],
      );
      expect(syncImports).toEqual(["./sync-core"]);
      expect(leafSource).not.toMatch(/import\s*\(\s*["']\.\/sync/);
    }
  });

  it("keeps sync-core independent of the orchestrator and leaves", () => {
    const core = source("sync-core.ts");
    expect(core).not.toMatch(/from\s+["']\.\/sync(?:-|["'])/);
    expect(core).not.toMatch(/import\s*\(\s*["']\.\/sync/);
  });
});
