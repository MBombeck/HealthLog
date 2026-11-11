/**
 * The BMI chart divides the weights on screen by the height of the record on
 * screen. It used to know only the viewer's height, so inside another
 * person's record it drew nothing at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  inSharedRecord: false,
  recordHeightCm: 120 as number | null,
  enabled: [] as boolean[],
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { heightCm: 180 } }),
}));
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ inSharedRecord: h.inSharedRecord }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { enabled: boolean }) => {
    h.enabled.push(options.enabled);
    return options.enabled
      ? { data: { profile: { heightCm: h.recordHeightCm } } }
      : { data: undefined };
  },
}));

import { useBmiDivisor } from "../health-chart/use-bmi-divisor";

describe("useBmiDivisor", () => {
  beforeEach(() => {
    h.inSharedRecord = false;
    h.recordHeightCm = 120;
    h.enabled.length = 0;
  });

  it("uses the viewer's own height in their own record", () => {
    expect(useBmiDivisor("bmi")).toBeCloseTo(3.24);
    expect(h.enabled).toEqual([false]);
  });

  it("uses the record's height inside somebody else's record", () => {
    h.inSharedRecord = true;
    expect(useBmiDivisor("bmi")).toBeCloseTo(1.44);
  });

  it("draws no BMI when the record has no height", () => {
    h.inSharedRecord = true;
    h.recordHeightCm = null;
    expect(useBmiDivisor("bmi")).toBeNull();
  });

  it("asks for nothing outside the BMI view", () => {
    h.inSharedRecord = true;
    expect(useBmiDivisor("raw")).toBeNull();
    expect(h.enabled).toEqual([false]);
  });
});
