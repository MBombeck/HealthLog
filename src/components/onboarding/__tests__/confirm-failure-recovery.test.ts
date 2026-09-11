/**
 * v1.39 — a failed completion leaves the confirm screen usable.
 *
 * Two defects, one symptom. `advance()` in the baseline form set its pending
 * flag and never reset it on the success path, and `finish()` on the confirm
 * screen caught its own error and returned normally — so a failed
 * `POST /api/onboarding/complete` (or a 429 on the answer PATCHes before it)
 * left "Überspringen" and "Bestätigen und weiter" disabled for the rest of the
 * page's life and only a reload recovered.
 *
 * The second defect is the retry itself: `finish()` fires one PATCH per
 * question the flow never showed, and a failure midway left a partly-passed
 * ledger that the next attempt walked from the top again.
 *
 * Both are pinned at the seam the component drives, because this repo's
 * component tests render server-side and cannot click.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";

import { runBaselineAttempt } from "../baseline-form";
import { runConfirmFinish } from "../confirm-screen";

type PassableStep = Parameters<
  Parameters<typeof runConfirmFinish>[0]["passStep"]
>[0];

/**
 * A flow with no unit-bearing area: Q6 is the question the machine never
 * showed, so the confirm screen has to pass it on the ledger before the
 * completion.
 */
function state(
  overrides: Partial<OnboardingStateDto> = {},
): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps().map((step) =>
      step.id === "who" ? { ...step, status: "done" as const } : step,
    ),
    needs: { ...emptyOnboardingNeeds(), recordTarget: "me" },
    completedAt: null,
    firstResult: null,
    ...overrides,
  };
}

/** The ledger as the server would answer it after one step was passed. */
function withPassed(
  base: OnboardingStateDto,
  ids: readonly string[],
): OnboardingStateDto {
  return {
    ...base,
    steps: base.steps.map((step) =>
      ids.includes(step.id) ? { ...step, status: "skipped" as const } : step,
    ),
  };
}

describe("runBaselineAttempt", () => {
  it("hands the buttons back when the completion rejects", async () => {
    const pending: boolean[] = [];
    const onError = vi.fn();
    await runBaselineAttempt(
      (value) => pending.push(value),
      async () => {
        throw new Error("complete failed");
      },
      onError,
    );
    expect(pending).toEqual([true, false]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("hands the buttons back on the success path too", async () => {
    const pending: boolean[] = [];
    await runBaselineAttempt(
      (value) => pending.push(value),
      async () => {},
      vi.fn(),
    );
    expect(pending).toEqual([true, false]);
  });

  it("is the form's only way to move the pending flag", () => {
    // A second, inline `setSaving(false)` is how the flag stopped being
    // reset on one of the three exits in the first place.
    const source = readFileSync(
      join(process.cwd(), "src/components/onboarding/baseline-form.tsx"),
      "utf8",
    );
    expect(source).not.toContain("setSaving(false)");
    expect(source).not.toContain("setSaving(true)");
  });
});

describe("runConfirmFinish", () => {
  it("rethrows a failed completion instead of returning normally", async () => {
    const ledger = { current: state() };
    const passed: PassableStep[] = [];
    const navigate = vi.fn();
    await expect(
      runConfirmFinish({
        ledger,
        // The server answers the written ledger; only the runner may put it
        // back, which is the whole point of the ref.
        passStep: async (step) => {
          passed.push(step);
          return withPassed(ledger.current, [step]);
        },
        complete: async () => {
          throw new Error("429");
        },
        navigate,
      }),
    ).rejects.toThrow("429");
    // Q6 was never shown for a flow with no unit-bearing area, so it is
    // passed on the ledger before the completion — and that write survived.
    expect(passed).toEqual(["units"]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not pass a step the failed attempt already passed", async () => {
    const ledger = { current: state() };
    const passed: PassableStep[] = [];
    const passStep = async (step: PassableStep) => {
      passed.push(step);
      return withPassed(ledger.current, [step]);
    };
    let attempt = 0;
    const complete = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("429");
      return { onboarding: ledger.current };
    };
    const navigate = vi.fn();

    await expect(
      runConfirmFinish({ ledger, passStep, complete, navigate }),
    ).rejects.toThrow("429");
    await runConfirmFinish({ ledger, passStep, complete, navigate });

    // "units" exactly once across both attempts; "first-result" is the
    // second attempt's own pass, because these answers offer no task.
    expect(passed).toEqual(["units", "first-result"]);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
