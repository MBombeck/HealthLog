/**
 * 1.49 — the server setup's pure parts: the stored steps read fail-soft, the
 * resume point, and the counter drawn from the same list as the bar.
 */
import { describe, expect, it } from "vitest";

import {
  applyServerSetupStep,
  everyServerSetupStepSettled,
  parseServerSetupSteps,
  SERVER_SETUP_STEP_IDS,
  serverSetupCounter,
  serverSetupResumeStep,
} from "../server-setup";

describe("the server setup steps", () => {
  it("reads every step in order, unknown entries dropped", () => {
    const steps = parseServerSetupSteps([
      { id: "ai", status: "skipped" },
      { id: "nope", status: "done" },
      { id: "accounts", status: "half" },
    ]);
    expect(steps.map((s) => s.id)).toEqual([...SERVER_SETUP_STEP_IDS]);
    expect(steps.find((s) => s.id === "ai")?.status).toBe("skipped");
    expect(steps.find((s) => s.id === "accounts")?.status).toBe("pending");
  });

  it("resumes on the first step owed and settles once all are answered", () => {
    let steps = parseServerSetupSteps(null);
    expect(serverSetupResumeStep(steps)).toBe("accounts");
    steps = applyServerSetupStep(steps, "accounts", "done");
    expect(serverSetupResumeStep(steps)).toBe("notifications");
    for (const id of SERVER_SETUP_STEP_IDS) {
      steps = applyServerSetupStep(steps, id, "skipped");
    }
    expect(everyServerSetupStepSettled(steps)).toBe(true);
  });

  it("counts from the same list the bar is drawn from", () => {
    for (const [index, id] of SERVER_SETUP_STEP_IDS.entries()) {
      expect(serverSetupCounter(id)).toEqual({
        current: index + 1,
        total: SERVER_SETUP_STEP_IDS.length,
      });
    }
  });
});
