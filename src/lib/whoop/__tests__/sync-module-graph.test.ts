import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WHOOP_DIR = resolve(__dirname, "..");
const LEAF_MODULES = [
  "sync-recovery.ts",
  "sync-sleep.ts",
  "sync-cycle.ts",
  "sync-workout.ts",
  "sync-body.ts",
] as const;

function source(file: string): string {
  return readFileSync(resolve(WHOOP_DIR, file), "utf8");
}

describe("WHOOP sync module graph", () => {
  it("orchestrator statically imports every sync leaf without dynamic imports", () => {
    const orchestrator = source("sync.ts");

    for (const leaf of LEAF_MODULES) {
      const specifier = `./${leaf.replace(/\.ts$/, "")}`;
      expect(orchestrator, leaf).toMatch(
        new RegExp(`from\\s+["']${specifier.replace("-", "\\-")}["']`),
      );
      expect(orchestrator, leaf).not.toContain(`import("${specifier}")`);
      expect(orchestrator, leaf).not.toContain(`import('${specifier}')`);
    }
  });

  it("keeps shared exports on sync-core instead of re-exporting them from the parent", () => {
    const orchestrator = source("sync.ts");

    expect(orchestrator).not.toMatch(
      /export\s+(?:\*|\{[^}]*\})\s+from\s+["']\.\/sync-core["']/,
    );
  });

  it("sync leaves depend on sync-core and never on the orchestrator", () => {
    for (const leaf of LEAF_MODULES) {
      const leafSource = source(leaf);
      expect(leafSource, leaf).toMatch(/from\s+["']\.\/sync-core["']/);
      expect(leafSource, leaf).not.toMatch(/from\s+["']\.\/sync["']/);
      expect(leafSource, leaf).not.toMatch(/import\(["']\.\/sync["']\)/);
    }
  });

  it("sync-core has no leaf dependency", () => {
    const core = source("sync-core.ts");

    for (const leaf of LEAF_MODULES) {
      const specifier = `./${leaf.replace(/\.ts$/, "")}`;
      expect(core, leaf).not.toContain(specifier);
    }
  });
});
