/**
 * The summary windows count from the request's clock in a session outside
 * UTC too. The app pins its sessions to UTC; this runs the pool in another
 * zone on purpose, so a bound that went through `timestamptz` (and so through
 * the session zone) would be cut hours off (see
 * `request-clock-windows.cases.ts`).
 */
import { describe, vi } from "vitest";

vi.mock("@/lib/db-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db-session")>();
  return { ...actual, TIME_ZONE_OPTION: "-c TimeZone=Pacific/Auckland" };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// The read path's fire-and-forget refresh would build the rollup tier behind
// the live case; the cases build it themselves when they mean to.
vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/rollups/measurement-rollups")
  >()),
  ensureUserRollupsFresh: async () => {},
}));

import { defineRequestClockCases } from "./request-clock-windows.cases";

describe("summary windows on the request's clock, outside UTC", () => {
  defineRequestClockCases("Pacific/Auckland");
});
