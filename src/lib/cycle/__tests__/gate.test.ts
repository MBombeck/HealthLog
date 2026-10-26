/**
 * v1.15.0 — cycle-tracking feature gate resolver.
 * v1.18.0 — the route guard + the server-side availability helper now AND
 * in the operator server-wide kill-switch via the module foundation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isModuleEnabledMock =
  vi.fn<(userId: string, key: string) => Promise<boolean>>();
const getOrCreateCycleProfileMock = vi.fn();

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: (userId: string, key: string) =>
    isModuleEnabledMock(userId, key),
}));
vi.mock("@/lib/cycle/profile", () => ({
  getOrCreateCycleProfile: (...args: unknown[]) =>
    getOrCreateCycleProfileMock(...args),
}));

import { isCycleEnabled } from "../enabled";
import {
  isCycleAvailableForUser,
  requireCycleEnabled,
  CYCLE_DISABLED_ERROR_CODE,
} from "../gate";

describe("isCycleEnabled", () => {
  it("derives from gender when the toggle is null", () => {
    expect(isCycleEnabled("FEMALE", { cycleTrackingEnabled: null })).toBe(true);
    expect(isCycleEnabled("MALE", { cycleTrackingEnabled: null })).toBe(false);
    expect(isCycleEnabled(null, { cycleTrackingEnabled: null })).toBe(false);
  });

  it("derives from gender when no profile row exists", () => {
    expect(isCycleEnabled("FEMALE", null)).toBe(true);
    expect(isCycleEnabled("MALE", undefined)).toBe(false);
    expect(isCycleEnabled(null, null)).toBe(false);
  });

  it("an explicit true opts a non-FEMALE account in", () => {
    expect(isCycleEnabled("MALE", { cycleTrackingEnabled: true })).toBe(true);
    expect(isCycleEnabled(null, { cycleTrackingEnabled: true })).toBe(true);
  });

  it("an explicit false opts a FEMALE account out", () => {
    expect(isCycleEnabled("FEMALE", { cycleTrackingEnabled: false })).toBe(
      false,
    );
  });

  it("gates on UPPERCASE FEMALE only (server enum spelling)", () => {
    // Lowercase / other spellings never enable by derivation.
    expect(isCycleEnabled("female", { cycleTrackingEnabled: null })).toBe(
      false,
    );
    expect(isCycleEnabled("OTHER", { cycleTrackingEnabled: null })).toBe(false);
  });

  it("exports the wire errorCode the iOS retry classifier branches on", () => {
    expect(CYCLE_DISABLED_ERROR_CODE).toBe("cycle.disabled");
  });
});

describe("isCycleAvailableForUser (operator AND user — v1.18.0)", () => {
  beforeEach(() => {
    isModuleEnabledMock.mockReset();
    getOrCreateCycleProfileMock.mockReset();
  });

  it("delegates to the cycle ModuleKey so the operator kill-switch is AND-ed in", async () => {
    isModuleEnabledMock.mockResolvedValue(false);
    await expect(isCycleAvailableForUser("u1")).resolves.toBe(false);
    expect(isModuleEnabledMock).toHaveBeenCalledWith("u1", "cycle");
  });

  it("reports available when the module gate resolves true", async () => {
    isModuleEnabledMock.mockResolvedValue(true);
    await expect(isCycleAvailableForUser("u1")).resolves.toBe(true);
  });
});

describe("requireCycleEnabled (route guard — v1.18.0)", () => {
  beforeEach(() => {
    isModuleEnabledMock.mockReset();
    getOrCreateCycleProfileMock.mockReset();
    getOrCreateCycleProfileMock.mockResolvedValue({
      id: "cp-1",
      cycleTrackingEnabled: true,
    });
  });

  it("passes through the profile when the resolved module is enabled", async () => {
    isModuleEnabledMock.mockResolvedValue(true);
    const result = await requireCycleEnabled("u1", "FEMALE");
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      expect(result.profile).toMatchObject({ id: "cp-1" });
    }
    expect(isModuleEnabledMock).toHaveBeenCalledWith("u1", "cycle");
  });

  it("returns a 403 cycle.disabled envelope when the operator turned the module off", async () => {
    // Per-user toggle is on (profile.cycleTrackingEnabled = true) — the only
    // thing closing the gate is the operator server-wide kill-switch routed
    // through the module foundation.
    isModuleEnabledMock.mockResolvedValue(false);
    const result = await requireCycleEnabled("u1", "FEMALE");
    expect(result.enabled).toBe(false);
    if (!result.enabled) {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as {
        error: string | null;
        meta?: { errorCode?: string };
      };
      expect(body.meta?.errorCode).toBe(CYCLE_DISABLED_ERROR_CODE);
    }
  });
});
