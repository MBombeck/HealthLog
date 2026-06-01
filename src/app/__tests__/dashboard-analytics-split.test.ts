import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.39.2 — dashboard analytics slim/thick split.
 *
 * Pre-fix the dashboard fired a single `useAnalyticsQuery()` against the
 * thick `/api/analytics` envelope; every per-type tile waited on the
 * heavy fan-out before paint. Mood and medication tiles arrived first
 * (separate routes) and then every other tile arrived as one burst,
 * which Marc reported as "etwas nervig" in the v1.4.39.1 post-deploy
 * trace.
 *
 * Post-fix the dashboard mounts TWO `useAnalyticsQuery` calls in
 * parallel: one for `?slice=summaries` (per-type tile strip) and one
 * for the thick envelope (BD-Zielbereich + glucose tiles). The tile
 * strip paints from the slim slice as soon as it lands; thick fields
 * stream in afterwards. Without this dual-mount the cold-mount UX
 * waterfall regresses to the v1.4.39.1 behaviour, so the test pins the
 * two call shapes.
 *
 * v1.7.0 W6 — both calls now carry an `enabled` gate so the unified
 * snapshot rollout flag can disable them in favour of a single
 * `/api/dashboard/snapshot` cell. With the flag OFF (default) the
 * slim/thick split still drives the page, so the protective intent
 * holds; the matchers only relaxed to tolerate the `enabled` arg.
 */
const ROOT = join(__dirname, "../../..");
const PAGE_PATH = join(ROOT, "src/app/page.tsx");

function load(path: string): string {
  return readFileSync(path, "utf8");
}

describe("v1.4.39.2 — dashboard analytics slim/thick split", () => {
  it("mounts both the slim slice and the thick slice in parallel", () => {
    const src = load(PAGE_PATH);
    // Slim slice — `?slice=summaries` paints the per-type tile strip.
    expect(src).toMatch(/useAnalyticsQuery\(\{\s*\n?\s*slice:\s*"summaries"/);
    // Thick slice — the no-slice `useAnalyticsQuery` feeds the
    // BD-Zielbereich + glucose tiles. Both must coexist. The thick
    // call now opens with `{ enabled:` (no `slice` key).
    expect(src).toMatch(/useAnalyticsQuery\(\{\s*\n?\s*enabled:/);
  });

  it("merges slim and thick results so call-sites stay shape-stable", () => {
    const src = load(PAGE_PATH);
    // The merge contract: slim wins on overlapping fields, thick fills
    // in `bpInTargetPct*` and `glucoseByContext`. The text anchors
    // protect against a future refactor accidentally dropping one of
    // the queries — the `data` object that downstream tile rendering
    // consumes must stay shape-stable across both query states.
    expect(src).toMatch(/analyticsSlimQuery/);
    expect(src).toMatch(/analyticsThickQuery/);
    expect(src).toMatch(/bpInTargetPct/);
    expect(src).toMatch(/glucoseByContext/);
  });
});
