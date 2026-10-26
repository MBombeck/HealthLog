/**
 * The summary windows count from the request's clock, in the UTC session
 * every connection runs in (see `request-clock-windows.cases.ts`).
 */
import { describe, vi } from "vitest";

// The read path's fire-and-forget refresh would build the rollup tier behind
// the live case; the cases build it themselves when they mean to.
vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/rollups/measurement-rollups")
  >()),
  ensureUserRollupsFresh: async () => {},
}));

import { defineRequestClockCases } from "./request-clock-windows.cases";

describe("summary windows on the request's clock", () => {
  defineRequestClockCases("UTC");
});
