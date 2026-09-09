import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A one-shot DOM read must be gated on the element it measures, not on the
 * network.
 *
 * The failure this catches, twice on consecutive CI runs during v1.33.0:
 * a spec navigates with `waitUntil: "networkidle"` and then reads the DOM in
 * a single `page.evaluate` / `evaluateAll` that never retries. An idle
 * network says nothing about whether React has rendered, so the read can land
 * on a tree that is still mounting. The assertion then blames the application
 * — "language + dob fields must exist", "the helper is measuring the wrong
 * element" — for what is a race inside the test.
 *
 * Why this guard lives in the unit suite rather than in Playwright: e2e runs
 * at PR-CI only, and `playwright.config.ts` sets `failOnFlakyTests` on CI, so
 * one unguarded read costs a whole red pipeline before anyone sees it. Here it
 * is red in seconds, on the machine that wrote it.
 *
 * It is deliberately a source-shape check rather than a runtime one. The
 * shape is what a developer gets wrong; the runtime symptom only appears on a
 * loaded runner, which is precisely where it is most expensive to discover.
 */

const E2E_DIR = resolve(__dirname, "../../e2e");

/**
 * Sites where a `goto` → `evaluate` with no locator gate is correct, each with
 * the reason. Keep this list short: it is an inventory of exceptions, not a
 * place to put anything inconvenient. Past ~15 entries the guard is asking the
 * wrong question and should be rethought rather than extended.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; test: string; why: string }> = [
  {
    file: "vaccinations.spec.ts",
    test: "the list and the capture form carry no serious accessibility violations",
    why: "The evaluate after the goto reads no DOM: it issues the seed POST from the page's own origin so the row is written over the browser's socket rather than the runner's shared keep-alive agent, which handed POSTs to sockets the server had already closed. The scan that follows is gated on the reloaded list.",
  },
  {
    file: "ipad-viewport.spec.ts",
    test: "no horizontal overflow and full-width content on",
    why: "Deliberate swallowed waitForFunction. The rail settle can land just after networkidle on a loaded runner, but a genuine regression — the rail never engaging — still fails at the width assertion below, which reports the actual measured number. A hard gate here would replace that number with a generic timeout message, so the swallow buys a better diagnostic rather than hiding a race.",
  },
];

interface Offence {
  file: string;
  testName: string;
  line: number;
}

/** Source positions of every `test(` / `test.only(` block opener. */
function testBlocks(
  source: string,
): Array<{ name: string; start: number; end: number }> {
  const blocks: Array<{ name: string; start: number; end: number }> = [];
  const opener = /\btest(?:\.only|\.fixme|\.skip)?\s*\(\s*(`|"|')([\s\S]*?)\1/g;
  const starts: Array<{ name: string; index: number }> = [];
  for (let m = opener.exec(source); m !== null; m = opener.exec(source)) {
    starts.push({ name: m[2], index: m.index });
  }
  for (let i = 0; i < starts.length; i += 1) {
    blocks.push({
      name: starts[i].name,
      start: starts[i].index,
      end: i + 1 < starts.length ? starts[i + 1].index : source.length,
    });
  }
  return blocks;
}

const GOTO = /\bpage\.goto\s*\(/g;
/** A read that samples the DOM once and does not retry. */
const ONE_SHOT_READ =
  /\b(?:page|\w+)\.(?:evaluate|evaluateAll|evaluateHandle|\$\$eval|\$eval)\s*\(/;
/**
 * Anything that waits for the DOM to reach a state before the read.
 *
 * No leading `\b`: the common form is `page.locator(…).first().waitFor(…)`,
 * where the character before the dot is `)`. There is no word boundary
 * between `)` and `.`, so a `\b` here silently fails to match the most
 * frequent gate in the suite and reports correct tests as offenders. That is
 * worse than no guard, because the fix someone reaches for is to allowlist a
 * test that was never wrong.
 */
const GATE =
  /(?:await\s+expect(?:\.poll|\.soft)?\s*\(|\.waitFor\s*\(|waitForSelector\s*\(|waitForFunction\s*\(|settleBeforeMeasure\s*\(|settleForOverflowMeasurement\s*\(|toBeVisible\s*\(|toBeAttached\s*\()/;

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/**
 * A wait whose rejection is thrown away is not a gate.
 *
 * `await page.waitForFunction(...).catch(() => {})` reads like a guarantee and
 * is not one: on timeout it proceeds to the measurement exactly as if it had
 * never waited. Counting it would also leave the guard trivially defeatable —
 * append `.catch(() => {})` to any wait and the check goes quiet. Where the
 * swallow is deliberate, the allowlist is the place to say so.
 */
const SWALLOWED_WAIT =
  /(?:waitForFunction|waitForSelector|waitFor)\s*\([\s\S]*?\)\s*\n?\s*\.catch\s*\(/;

function stripSwallowedWaits(segment: string): string {
  return segment.replace(new RegExp(SWALLOWED_WAIT, "g"), "«swallowed»");
}

function scan(file: string, source: string): Offence[] {
  const offences: Offence[] = [];
  for (const block of testBlocks(source)) {
    const body = source.slice(block.start, block.end);
    GOTO.lastIndex = 0;
    for (let g = GOTO.exec(body); g !== null; g = GOTO.exec(body)) {
      const after = body.slice(g.index);
      const read = ONE_SHOT_READ.exec(after);
      if (!read) continue;
      const between = stripSwallowedWaits(after.slice(0, read.index));
      if (GATE.test(between)) continue;
      offences.push({
        file,
        testName: block.name,
        line: lineOf(source, block.start + g.index),
      });
      break;
    }
  }
  return offences;
}

describe("e2e specs gate their measurements on the element, not the network", () => {
  const specs = readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts"));

  it("finds spec files to check (the guard must not pass vacuously)", () => {
    expect(specs.length).toBeGreaterThan(10);
  });

  it("has no ungated goto → one-shot DOM read outside the allowlist", () => {
    const offences: Offence[] = [];
    for (const spec of specs) {
      const source = readFileSync(join(E2E_DIR, spec), "utf8");
      offences.push(...scan(spec, source));
    }

    const unexplained = offences.filter(
      (o) =>
        !ALLOWLIST.some(
          (a) => a.file === o.file && o.testName.includes(a.test),
        ),
    );

    if (unexplained.length > 0) {
      throw new Error(
        `${unexplained.length} e2e test(s) navigate and then read the DOM once, with nothing in between that waits for the element:\n\n` +
          unexplained
            .map((o) => `  ${o.file}:${o.line} — "${o.testName}"`)
            .join("\n") +
          "\n\nAn idle network does not mean React has rendered. Gate on the element the " +
          "measurement is about (await expect(locator).toBeVisible(), or settleBeforeMeasure " +
          "from e2e/utils/settle.ts). If the read genuinely does not need a gate, add it to " +
          "ALLOWLIST in this file with the reason.",
      );
    }
  });

  it("carries no allowlist entry for a spec file that no longer exists", () => {
    for (const entry of ALLOWLIST) {
      expect(specs, `stale allowlist entry: ${entry.file}`).toContain(
        entry.file,
      );
    }
  });

  it("keeps the allowlist small enough to still be an inventory of exceptions", () => {
    expect(ALLOWLIST.length).toBeLessThanOrEqual(15);
  });
});
