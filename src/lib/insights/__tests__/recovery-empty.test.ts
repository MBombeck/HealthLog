import { describe, expect, it } from "vitest";

import { resolveRecoveryEmpty } from "../recovery-empty";

/**
 * The recovery page's empty reason is decided here, on the server, from the
 * summaries and the Oura connection; clients render the answer.
 */
describe("resolveRecoveryEmpty", () => {
  const none = { connected: false, scopeDenied: [] };

  it("has no reason when any recovery type has a reading", () => {
    expect(resolveRecoveryEmpty({ RESILIENCE: { count: 1 } }, none)).toBeNull();
    expect(resolveRecoveryEmpty({ DAY_STRAIN: { count: 3 } }, none)).toBeNull();
  });

  it("counts HealthLog's estimates, which close the page", () => {
    expect(
      resolveRecoveryEmpty({ STRESS_SCORE: { count: 2 } }, none),
    ).toBeNull();
    expect(
      resolveRecoveryEmpty({ STRAIN_SCORE: { count: 2 } }, none),
    ).toBeNull();
  });

  it("does not count types the page does not chart", () => {
    expect(resolveRecoveryEmpty({ RECOVERY_SCORE: { count: 30 } }, none)).toBe(
      "general",
    );
  });

  it("asks for a reconnect only when the grant leaves resilience out", () => {
    expect(
      resolveRecoveryEmpty(
        {},
        { connected: true, scopeDenied: ["resilience"] },
      ),
    ).toBe("oura_permission");
    expect(
      resolveRecoveryEmpty({}, { connected: true, scopeDenied: ["spo2"] }),
    ).toBe("oura_no_resilience");
  });
});
