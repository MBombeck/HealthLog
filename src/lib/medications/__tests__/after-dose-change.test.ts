import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: (userId: string, opts?: { evict?: boolean }) => {
    calls.push(`evict:${userId}:${opts?.evict === true}`);
  },
}));
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: (input: { userId: string }) => {
    calls.push(`sync:${input.userId}`);
  },
}));
vi.mock("@/lib/push-relay/data-changed", () => ({
  noteDataChanged: (userId: string, domains: string[]) => {
    calls.push(`data:${userId}:${domains.join(",")}`);
    return Promise.resolve();
  },
}));

import {
  afterDoseChange,
  afterMedicationChange,
} from "@/lib/medications/after-dose-change";

beforeEach(() => {
  calls.length = 0;
});

describe("the dose seam evicts the read caches before it tells a device", () => {
  // A device woken by the push reads within a second. A writer that only
  // marks the cells stale, or does not touch them, would have the server
  // answer that read with the state before the write.
  it("for an intake change", () => {
    afterDoseChange({ userId: "u1", scope: "intakes" });
    expect(calls).toEqual(["evict:u1:true", "sync:u1", "data:u1:intakes"]);
  });

  it("for a medication change, once", () => {
    afterMedicationChange("u2", "device-1");
    expect(calls).toEqual([
      "evict:u2:true",
      "sync:u2",
      "data:u2:intakes,medications",
    ]);
  });
});
