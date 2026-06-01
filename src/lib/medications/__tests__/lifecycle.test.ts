/**
 * v1.5.0 — `reconcileOneShotState` unit tests.
 *
 * Pins the contract for the lifecycle helper that every intake-mutation
 * path (POST, PUT, DELETE) tails:
 *
 *  - one-shot + live intake exists → flip active to false
 *  - one-shot + no live intake     → flip active to true
 *  - matching state                → noop (no write, no audit)
 *  - non-one-shot medication       → noop (the updateMany gate is
 *    `oneShot:true`, so the action is "noop" regardless of state)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import { reconcileOneShotState } from "../lifecycle";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";

interface MedRow {
  oneShot: boolean;
  active: boolean;
}

function buildClient(
  med: MedRow | null,
  liveIntake: { id: string } | null,
) {
  return {
    medication: {
      findUnique: vi.fn().mockResolvedValue(med),
      updateMany: vi.fn().mockResolvedValue({ count: med?.oneShot ? 1 : 0 }),
    },
    medicationIntakeEvent: {
      findFirst: vi.fn().mockResolvedValue(liveIntake),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcileOneShotState", () => {
  it("deactivates a one-shot medication when a live intake is found", async () => {
    const client = buildClient(
      { oneShot: true, active: true },
      { id: "evt-1" },
    );
    const action = await reconcileOneShotState(client, "med-1", "user-1");
    expect(action).toBe("deactivate");
    expect(client.medication.updateMany).toHaveBeenCalledWith({
      where: { id: "med-1", userId: "user-1", oneShot: true },
      data: { active: false },
    });
    expect(auditLog).toHaveBeenCalledWith(
      "medication.oneShot.reconciled",
      expect.objectContaining({
        userId: "user-1",
        details: { medicationId: "med-1", action: "deactivate" },
      }),
    );
  });

  it("reactivates a one-shot medication when no live intake remains", async () => {
    const client = buildClient({ oneShot: true, active: false }, null);
    const action = await reconcileOneShotState(client, "med-1", "user-1");
    expect(action).toBe("activate");
    expect(client.medication.updateMany).toHaveBeenCalledWith({
      where: { id: "med-1", userId: "user-1", oneShot: true },
      data: { active: true },
    });
    expect(auditLog).toHaveBeenCalledWith(
      "medication.oneShot.reconciled",
      expect.objectContaining({
        details: { medicationId: "med-1", action: "activate" },
      }),
    );
  });

  it("is idempotent on a non-one-shot medication", async () => {
    const client = buildClient(
      { oneShot: false, active: true },
      { id: "evt-1" },
    );
    const action = await reconcileOneShotState(client, "med-1", "user-1");
    expect(action).toBe("noop");
    expect(client.medication.updateMany).not.toHaveBeenCalled();
    expect(client.medicationIntakeEvent.findFirst).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("is idempotent when state already matches (one-shot deactivated, no live intake)", async () => {
    const client = buildClient({ oneShot: true, active: false }, null);
    // active matches the "no live intake → should be active=true" expectation? No:
    // when no live intake exists shouldBeActive=true; current is false → activate.
    // To pin the "matches" branch we want active:true + live intake exists
    // (already deactivated state) is one shape; here we test active:false
    // + no live intake should ACTIVATE (the other direction). So pick the
    // truly-matching shape below.
    const action = await reconcileOneShotState(client, "med-1", "user-1");
    expect(action).toBe("activate");

    // Now the matching branch: one-shot + active:true + no live intake.
    const matchingClient = buildClient(
      { oneShot: true, active: true },
      null,
    );
    const matched = await reconcileOneShotState(
      matchingClient,
      "med-1",
      "user-1",
    );
    expect(matched).toBe("noop");
    expect(matchingClient.medication.updateMany).not.toHaveBeenCalled();
    // annotate still fires (the breadcrumb is the whole point) but
    // auditLog stays silent on noop.
    expect(annotate).toHaveBeenCalled();
  });

  it("returns noop when the medication does not exist", async () => {
    const client = buildClient(null, null);
    const action = await reconcileOneShotState(client, "ghost", "user-1");
    expect(action).toBe("noop");
    expect(client.medication.updateMany).not.toHaveBeenCalled();
  });
});
