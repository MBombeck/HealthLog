import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.43 W11 — motion-reduce sweep guard.
 *
 * Every `animate-spin` site in component / app code must also carry
 * `motion-reduce:animate-none` so that motion-sensitive users see a
 * static icon instead of a continuous rotation. The audit found 21
 * sites missing the modifier; this test prevents regressions.
 *
 * Scope: `src/**` excluding test files. The check is textual to avoid
 * rendering every loading state — a CI-cheap guard that catches drift
 * any time a new spinner is added without the modifier.
 */
const ROOT = join(process.cwd(), "src");
const EXCLUDE_DIRS = new Set(["__tests__", "node_modules"]);

function collectTsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTsxFiles(full, acc);
    } else if (
      entry.endsWith(".tsx") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".test.ts")
    ) {
      acc.push(full);
    }
  }
  return acc;
}

describe("motion-reduce coverage — every animate-spin pairs with motion-reduce:animate-none", () => {
  const files = collectTsxFiles(ROOT);

  it("collects component files to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("every animate-spin site declares motion-reduce:animate-none", () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, idx) => {
        if (!line.includes("animate-spin")) return;
        // Skip comments and string literals that aren't classNames.
        if (line.trim().startsWith("//") || line.trim().startsWith("*"))
          return;
        if (!line.includes("motion-reduce:animate-none")) {
          violations.push(`${file}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      violations,
      `The following animate-spin sites are missing motion-reduce:animate-none. ` +
        `Append the modifier so motion-sensitive users see a static icon:\n` +
        violations.join("\n"),
    ).toEqual([]);
  });
});
