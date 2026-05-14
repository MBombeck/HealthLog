import { describe, expect, it } from "vitest";

import {
  researchModeGateState,
  type ResearchModeStatus,
} from "../research-mode-types";

const ACK_OPEN: ResearchModeStatus = {
  enabled: true,
  acknowledgedAt: "2026-05-13T00:00:00.000Z",
  acknowledgedVersion: "v3",
  currentDisclaimerVersion: "v3",
};

const ACK_STALE: ResearchModeStatus = {
  enabled: true,
  acknowledgedAt: "2026-04-01T00:00:00.000Z",
  acknowledgedVersion: "v2",
  currentDisclaimerVersion: "v3",
};

const OFF: ResearchModeStatus = {
  enabled: false,
  acknowledgedAt: null,
  acknowledgedVersion: null,
  currentDisclaimerVersion: "v3",
};

describe("researchModeGateState", () => {
  it("returns 'off' when status is null (unauthenticated / loading)", () => {
    expect(researchModeGateState(null)).toBe("off");
  });

  it("returns 'off' when status is undefined", () => {
    expect(researchModeGateState(undefined)).toBe("off");
  });

  it("returns 'off' when the user never enabled Research Mode", () => {
    expect(researchModeGateState(OFF)).toBe("off");
  });

  it("returns 'open' when enabled and acknowledged versions align", () => {
    expect(researchModeGateState(ACK_OPEN)).toBe("open");
  });

  it("returns 'stale' when enabled but server bumped the disclaimer version", () => {
    expect(researchModeGateState(ACK_STALE)).toBe("stale");
  });

  it("treats acknowledgedVersion === null as stale when enabled", () => {
    const status: ResearchModeStatus = {
      enabled: true,
      acknowledgedAt: null,
      acknowledgedVersion: null,
      currentDisclaimerVersion: "v3",
    };
    expect(researchModeGateState(status)).toBe("stale");
  });

  it("never returns 'open' when enabled is false even if versions happen to match", () => {
    const status: ResearchModeStatus = {
      enabled: false,
      acknowledgedAt: "2026-05-13T00:00:00.000Z",
      acknowledgedVersion: "v3",
      currentDisclaimerVersion: "v3",
    };
    expect(researchModeGateState(status)).toBe("off");
  });
});
