/**
 * v1.8.2 — reminder-worker RED-phase mint guard.
 *
 * The worker must NOT mint a pending REMINDER row for a slot that the
 * user has already actioned (taken / skipped) from ANY source, nor for
 * a slot that already carries a pending REMINDER row. Pins the
 * duplicate-intake fix on the worker side.
 */
import { describe, expect, it, vi } from "vitest";

import { shouldMintMissedDoseRow } from "../worker-helpers";

const SLOT = {
  userId: "u1",
  medicationId: "m1",
  scheduledFor: new Date("2026-06-15T05:00:00.000Z"),
};

/**
 * Fake `count` that resolves the two probes in call order: the first
 * call is the pending-REMINDER probe, the second is the actioned probe.
 */
function fakeClient(pendingReminder: number, actioned: number) {
  const count = vi
    .fn<(args: { where: Record<string, unknown> }) => Promise<number>>()
    .mockResolvedValueOnce(pendingReminder)
    .mockResolvedValueOnce(actioned);
  return { medicationIntakeEvent: { count } };
}

describe("shouldMintMissedDoseRow", () => {
  it("mints when the slot is empty (no pending, no actioned row)", async () => {
    const client = fakeClient(0, 0);
    expect(await shouldMintMissedDoseRow(client, SLOT)).toBe(true);
  });

  it("does NOT mint when a pending REMINDER row already exists", async () => {
    const client = fakeClient(1, 0);
    expect(await shouldMintMissedDoseRow(client, SLOT)).toBe(false);
    // short-circuits before the actioned probe
    expect(client.medicationIntakeEvent.count).toHaveBeenCalledTimes(1);
  });

  it("does NOT mint when an actioned (taken) row exists from any source", async () => {
    const client = fakeClient(0, 1);
    expect(await shouldMintMissedDoseRow(client, SLOT)).toBe(false);
    // the actioned probe filters takenAt-set OR skipped, live rows only
    const actionedWhere = client.medicationIntakeEvent.count.mock.calls[1]?.[0]
      .where as Record<string, unknown>;
    expect(actionedWhere.deletedAt).toBeNull();
    expect(actionedWhere.OR).toEqual([
      { takenAt: { not: null } },
      { skipped: true },
    ]);
  });

  it("does NOT mint when a skipped row exists at the slot", async () => {
    const client = fakeClient(0, 1);
    expect(await shouldMintMissedDoseRow(client, SLOT)).toBe(false);
  });
});
