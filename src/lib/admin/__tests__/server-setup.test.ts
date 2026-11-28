/**
 * The server setup's pure parts (1.50): the stored steps read fail-soft and
 * through their 1.49 ids, the resume point, the pass metadata a "Later"
 * keeps, and the stepper's segments.
 */
import { describe, expect, it } from "vitest";

import {
  applyServerSetupStep,
  everyServerSetupStepSettled,
  parseServerSetupSteps,
  SERVER_SETUP_SEGMENTS,
  SERVER_SETUP_STEP_IDS,
  serverSetupResumeStep,
  serverSetupStepper,
} from "../server-setup";

describe("the server setup steps", () => {
  it("reads every step in order, unknown entries dropped", () => {
    const steps = parseServerSetupSteps([
      { id: "ai", status: "skipped" },
      { id: "nope", status: "done" },
      { id: "signups", status: "half" },
    ]);
    expect(steps.map((s) => s.id)).toEqual([...SERVER_SETUP_STEP_IDS]);
    expect(steps.find((s) => s.id === "ai")?.status).toBe("skipped");
    expect(steps.find((s) => s.id === "signups")?.status).toBe("pending");
    // A blob of current ids infers nothing about the second factor.
    expect(steps.find((s) => s.id === "account-mfa")?.status).toBe("pending");
  });

  it("reads a 1.49 setup through its old ids and never asks it for a second factor", () => {
    const steps = parseServerSetupSteps([
      { id: "accounts", status: "done" },
      { id: "notifications", status: "skipped" },
      { id: "privacy", status: "done" },
    ]);
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(byId.signups.status).toBe("done");
    expect(byId.relay.status).toBe("skipped");
    expect(byId["account-mfa"]).toEqual({
      id: "account-mfa",
      status: "skipped",
    });
    expect(serverSetupResumeStep(steps)).toBe("ai");
  });

  it("keeps when and by whom a step was passed", () => {
    const steps = applyServerSetupStep(
      parseServerSetupSteps(null),
      "recovery",
      "skipped",
      { at: "2026-12-01T10:00:00.000Z", by: "u1" },
    );
    const recovery = steps.find((s) => s.id === "recovery");
    expect(recovery).toEqual({
      id: "recovery",
      status: "skipped",
      at: "2026-12-01T10:00:00.000Z",
      by: "u1",
    });
    expect(
      parseServerSetupSteps(steps).find((s) => s.id === "recovery"),
    ).toEqual(recovery);
    // A step answered "done" carries no pass.
    const done = applyServerSetupStep(steps, "recovery", "done", {
      at: "2026-12-02T10:00:00.000Z",
      by: "u1",
    });
    expect(done.find((s) => s.id === "recovery")).toEqual({
      id: "recovery",
      status: "done",
    });
  });

  it("resumes on the first step owed and settles once all are answered", () => {
    let steps = parseServerSetupSteps(null);
    expect(serverSetupResumeStep(steps)).toBe("account-mfa");
    steps = applyServerSetupStep(steps, "account-mfa", "done");
    expect(serverSetupResumeStep(steps)).toBe("signups");
    for (const id of SERVER_SETUP_STEP_IDS) {
      steps = applyServerSetupStep(steps, id, "skipped");
    }
    expect(everyServerSetupStepSettled(steps)).toBe(true);
  });

  it("puts the owner account and its second factor in one segment", () => {
    expect(serverSetupStepper("register")).toMatchObject({
      segment: "account",
      current: 0,
      fraction: 0.5,
    });
    expect(serverSetupStepper("account-mfa")).toMatchObject({
      current: 0,
      fraction: 1,
    });
    expect(serverSetupStepper("recovery")).toMatchObject({
      current: SERVER_SETUP_SEGMENTS.length - 1,
      fraction: 1,
    });
  });
});
