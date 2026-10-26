/**
 * A provider sync loads none of the AI layer.
 *
 * Thirteen sync modules once imported `insights/comprehensive-generate` to
 * reach one invalidation function it re-exported, so every sync worker
 * evaluated the whole insight generator. The write tail is
 * `integrations/sync-kit/after-write.ts` now, and it reaches the status cards
 * through `insights/status-invalidation`. This guard holds that:
 *
 *   - no production module in a provider folder (`PROVIDER_DIRS`) imports
 *     anything under `lib/ai/` or the comprehensive generator;
 *   - and loading any of them does not evaluate the comprehensive generator
 *     transitively either.
 *
 * The planted case runs the transitive check over a module that does load
 * it, so a walk that resolves nothing cannot pass.
 */
import { describe, expect, it } from "vitest";

import { PROVIDER_DIRS } from "./helpers/provider-dirs";
import { requireFloor, walkSourceFiles } from "./helpers/source-files";
import {
  SRC,
  moduleImports,
  parse,
  readSrc,
  staticImportClosure,
} from "./helpers/source-metrics";

const GENERATOR = "lib/insights/comprehensive-generate.ts";
const FORBIDDEN_SPEC = /^@\/lib\/(?:ai\/|insights\/comprehensive-generate$)/;

function providerModules(): string[] {
  return PROVIDER_DIRS.flatMap((dir) =>
    walkSourceFiles(`${SRC}/lib/${dir}`, { floor: 1 })
      .filter((f) => !f.includes("__tests__") && !/\.test\.tsx?$/.test(f))
      .map((f) => `lib/${dir}/${f}`),
  );
}

describe("provider folders and the AI layer", () => {
  const modules = providerModules();

  it("reads every provider folder", () => {
    requireFloor("provider modules", modules, 60);
  });

  it("imports nothing from lib/ai or the comprehensive generator", () => {
    const offenders = modules.flatMap((rel) =>
      moduleImports(parse(rel, readSrc(rel)))
        .value.filter((spec) => FORBIDDEN_SPEC.test(spec))
        .map((spec) => `${rel} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it("does not load the comprehensive generator transitively", () => {
    const closure = staticImportClosure(modules);
    expect(closure.size).toBeGreaterThan(modules.length);
    expect(closure.has(GENERATOR)).toBe(false);
  });

  it("catches a module that loads it (planted)", () => {
    expect(
      staticImportClosure(["lib/jobs/morning-digest-refresh.ts"]).has(
        GENERATOR,
      ),
    ).toBe(true);
  });
});
