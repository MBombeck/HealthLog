/**
 * The password strength check runs zxcvbn on the request thread, and
 * registration (with sign-ups open) and the profile claim are anonymous.
 * zxcvbn's work grows with the square of the length times the number of l33t
 * substitutions it tries: unbounded, a long crafted password cost seconds per
 * call and one address could hold the event loop. These tests pin the bound
 * (`passwordEstimateInput`), measure the worst shapes found, freeze the
 * server's zxcvbn call to the one file that applies the bound, and pin the
 * length cap on new passwords without capping sign-in.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@node-rs/argon2", () => ({ hash: vi.fn(), verify: vi.fn() }));

import {
  checkPasswordStrength,
  passwordEstimateInput,
} from "@/lib/auth/password";
import {
  changePasswordSchema,
  loginPasswordSchema,
  newAccountPasswordSchema,
} from "@/lib/validations/auth";
import { PASSWORD_STRENGTH_MAX_LENGTH } from "@/lib/zxcvbn-i18n";
import { readSourceFolder } from "@/__tests__/helpers/source-files";

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
  it("scores the worst shapes within 50 ms a call", () => {
    // Warm the dictionaries and the JIT so the first shape is not charged
    // for loading.
    checkPasswordStrength("warm up the estimator");
    const slow: string[] = [];
    for (const shape of WORST_SHAPES) {
      const worst = cheapestRunMs(() =>
        checkPasswordStrength(shape, ["someusername", "someone@example.com"]),
      );
      if (worst >= 50)
        slow.push(
          `${JSON.stringify(shape.slice(0, 12))}…: ${worst.toFixed(1)} ms`,
        );
    }
    expect(slow).toEqual([]);
  });
});

describe("zxcvbn has one server caller", () => {
  // The strength meter component loads zxcvbn with a dynamic import and
  // scores in the browser, on the person's own CPU; the matcher below does
  // not see that form, and it is not a server path.
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

describe("new password length cap", () => {
  const ok = "Xq7#vLp2!mRt".padEnd(1024, "z");
  const tooLong = ok + "z";

  it("accepts 1024 characters and refuses 1025 on every new-password schema", () => {
    expect(newAccountPasswordSchema.safeParse(ok).success).toBe(true);
    expect(newAccountPasswordSchema.safeParse(tooLong).success).toBe(false);
    const change = (pw: string) =>
      changePasswordSchema.safeParse({
        currentPassword: "current",
        newPassword: pw,
        confirmPassword: pw,
      }).success;
    expect(change(ok)).toBe(true);
    expect(change(tooLong)).toBe(false);
  });

  it("leaves sign-in and the current password uncapped", () => {
    const existing = "y".repeat(4096);
    expect(
      loginPasswordSchema.safeParse({ email: "someone", password: existing })
        .success,
    ).toBe(true);
    expect(
      changePasswordSchema.safeParse({
        currentPassword: existing,
        newPassword: ok,
        confirmPassword: ok,
      }).success,
    ).toBe(true);
  });
});
