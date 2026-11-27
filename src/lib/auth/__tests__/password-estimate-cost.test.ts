/**
 * The password strength estimator runs zxcvbn on the request thread, and the
 * meter's route is anonymous. zxcvbn's work grows with the square of the
 * length times the number of l33t substitutions it tries: unbounded, 256
 * characters cost seconds per call and one address could hold the event loop.
 * These tests pin the bound (`passwordEstimateInput`), prove the cost it
 * leaves is small by counting what zxcvbn would enumerate, keep a coarse
 * wall-time check for order-of-magnitude regressions, and freeze zxcvbn to
 * the one file that applies the bound.
 *
 * The guard is structural on purpose. A wall-clock budget close to the real
 * cost (it was 50 ms against a measured 30 to 50 ms) fails on a busy runner
 * without any change to the code; the length and the substitution count are
 * what make the cost small, and they do not depend on the machine.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@node-rs/argon2", () => ({ hash: vi.fn(), verify: vi.fn() }));

import {
  checkPasswordStrength,
  estimatePasswordStrength,
  passwordEstimateInput,
} from "@/lib/auth/password";
import { PASSWORD_STRENGTH_MAX_LENGTH } from "@/lib/zxcvbn-i18n";
import { readSourceFolder } from "@/__tests__/helpers/source-files";
import {
  enumerate_l33t_subs,
  relevant_l33t_subtable,
} from "zxcvbn-typescript/lib/matching/dictionary_match";

/**
 * zxcvbn's l33t table (`L33T_TABLE` in the matcher, not exported). The
 * matcher tries every combination of the substitutions present in the
 * password; `enumerate_l33t_subs` over the pruned table is that list.
 */
const ZXCVBN_L33T_TABLE: Record<string, string[]> = {
  a: ["4", "@"],
  b: ["8"],
  c: ["(", "{", "[", "<"],
  e: ["3"],
  g: ["6", "9"],
  i: ["1", "!", "|"],
  l: ["1", "|", "7"],
  o: ["0"],
  s: ["$", "5"],
  t: ["+", "7"],
  x: ["%"],
  z: ["2"],
};
const L33T_CHARACTERS = [
  ...new Set(Object.values(ZXCVBN_L33T_TABLE).flat()),
].sort();

/** The l33t combinations zxcvbn's matcher would try for this input. */
const l33tCombinations = (input: string) =>
  enumerate_l33t_subs(relevant_l33t_subtable(input, ZXCVBN_L33T_TABLE)).length;

/** Six distinct l33t characters allow at most this many combinations. */
const MAX_L33T_COMBINATIONS = 36;

function* subsets<T>(items: T[], size: number, from = 0): Generator<T[]> {
  if (size === 0) {
    yield [];
    return;
  }
  for (let i = from; i <= items.length - size; i++)
    for (const rest of subsets(items, size - 1, i + 1))
      yield [items[i], ...rest];
}

const LONG = 1024;
const fill = (unit: string) =>
  unit.repeat(Math.ceil(LONG / unit.length)).slice(0, LONG);

/**
 * The slowest shapes found by fuzzing the bounded estimator: l33t characters
 * that each stand for two letters, interleaved with letters so that every
 * substitution spells dictionary words, plus the repeat, sequence, date and
 * symbol shapes zxcvbn treats specially.
 */
const WORST_SHAPES = [
  fill("a4b@c1d|e7f+"),
  fill("a@@@a+|ea11+1a4+++4aaeaaeae117a4"),
  fill("4@1|7+"),
  fill("1|7+!4@8({[<3690$5%2"),
  fill("|o"),
  fill("ab"),
  fill("a"),
  fill("0123456789"),
  fill("19901231"),
  fill("p@55w0rd"),
  fill("monkeydragon"),
  fill("ä€😀"),
  fill("!@#$%^&*()"),
];

/** The fastest of a few runs: the cost of the input, not of the scheduler. */
function cheapestRunMs(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("passwordEstimateInput", () => {
  it("leaves an ordinary password whole", () => {
    for (const pw of [
      "Tr0ub4dor&3",
      "correct horse battery staple",
      "P@ssw0rd!2024",
    ]) {
      expect(passwordEstimateInput(pw)).toBe(pw);
    }
  });

  it("reads at most PASSWORD_STRENGTH_MAX_LENGTH characters", () => {
    const long = "abcdefghij".repeat(10);
    expect(passwordEstimateInput(long)).toBe(
      long.slice(0, PASSWORD_STRENGTH_MAX_LENGTH),
    );
  });

  it("cuts before the seventh distinct l33t character", () => {
    expect(passwordEstimateInput("x4@1|7+yy8zz")).toBe("x4@1|7+yy");
    // Repeating the six already seen does not count again.
    expect(passwordEstimateInput("4@1|7+4@1|7+")).toBe("4@1|7+4@1|7+");
  });
});

describe("estimator cost on hostile input", () => {
  it("counts every character of zxcvbn's l33t table toward the bound", () => {
    // The bound only holds if it sees every substitution zxcvbn tries: each
    // table character, added after six others, is the seventh and is cut.
    for (const ch of L33T_CHARACTERS) {
      const six = L33T_CHARACTERS.filter((c) => c !== ch)
        .slice(0, 6)
        .join("");
      expect(passwordEstimateInput(six + ch)).toBe(six);
    }
  });

  it("leaves at most 36 l33t combinations for any six distinct l33t characters", () => {
    let worst = 0;
    for (const six of subsets(L33T_CHARACTERS, 6))
      worst = Math.max(worst, l33tCombinations(six.join("")));
    expect(worst).toBe(MAX_L33T_COMBINATIONS);
    // Without the bound the same matcher would try hundreds.
    expect(l33tCombinations(L33T_CHARACTERS.join(""))).toBeGreaterThan(500);
  });

  it("bounds the worst shapes structurally: length, distinct l33t, combinations", () => {
    for (const shape of WORST_SHAPES) {
      const input = passwordEstimateInput(shape);
      const label = JSON.stringify(shape.slice(0, 12));
      expect(input.length, label).toBeLessThanOrEqual(
        PASSWORD_STRENGTH_MAX_LENGTH,
      );
      expect(PASSWORD_STRENGTH_MAX_LENGTH).toBe(32);
      const distinct = new Set(
        [...input].filter((c) => L33T_CHARACTERS.includes(c)),
      );
      expect(distinct.size, label).toBeLessThanOrEqual(6);
      expect(l33tCombinations(input), label).toBeLessThanOrEqual(
        MAX_L33T_COMBINATIONS,
      );
    }
  });

  it("scores the worst shapes well under 250 ms a call, meter and submit alike", () => {
    // A coarse sanity check against an order-of-magnitude regression (an
    // unbounded call costs seconds), not a budget: the bound is proven above.
    estimatePasswordStrength("warm up the estimator");
    const slow: string[] = [];
    for (const shape of WORST_SHAPES) {
      const meter = cheapestRunMs(() => estimatePasswordStrength(shape));
      const submit = cheapestRunMs(() =>
        checkPasswordStrength(shape, ["someusername", "someone@example.com"]),
      );
      const worst = Math.max(meter, submit);
      if (worst >= 250)
        slow.push(
          `${JSON.stringify(shape.slice(0, 12))}…: ${worst.toFixed(1)} ms`,
        );
    }
    expect(slow).toEqual([]);
  });
});

describe("zxcvbn has one caller", () => {
  it("is imported and called only in src/lib/auth/password.ts", () => {
    const files = readSourceFolder("src", {
      floor: 3000,
      include: (rel) =>
        !rel.startsWith("generated/") &&
        !rel.includes("__tests__") &&
        !/\.test\.tsx?$/.test(rel),
    });
    const call = /from\s+["']zxcvbn|require\(\s*["']zxcvbn|\bzxcvbn\s*\(/;
    const callers = files
      .filter(([, text]) => call.test(text))
      .map(([rel]) => rel);
    // A non-empty match set: the matcher still finds the one real caller.
    expect(callers).toEqual(["lib/auth/password.ts"]);
  });
});
