import { describe, expect, it, vi } from "vitest";

import { assertMedicationOwnership } from "../route-guards";

function buildClient(med: { id: string; userId: string } | null) {
  return {
    medication: {
      findUnique: vi.fn().mockResolvedValue(med),
    },
  };
}

describe("assertMedicationOwnership", () => {
  it("returns null when the medication exists and matches the caller", async () => {
    const client = buildClient({ id: "med-1", userId: "user-1" });
    const result = await assertMedicationOwnership("med-1", "user-1", client);
    expect(result).toBeNull();
    expect(client.medication.findUnique).toHaveBeenCalledWith({
      where: { id: "med-1" },
      select: { id: true, userId: true },
    });
  });

  it("returns 404 when the medication does not exist", async () => {
    const client = buildClient(null);
    const result = await assertMedicationOwnership("med-missing", "user-1", client);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(404);
    const body = await result!.json();
    expect(body.error).toBe("Medication not found");
  });

  it("returns 404 when the medication belongs to a different user", async () => {
    const client = buildClient({ id: "med-1", userId: "attacker" });
    const result = await assertMedicationOwnership("med-1", "victim", client);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(404);
    const body = await result!.json();
    // Privacy contract — we never leak "exists but wrong owner" via a
    // 403; an attacker sees the same shape as a missing row.
    expect(body.error).toBe("Medication not found");
  });

  it("never reveals user-id correlation in the 404 envelope", async () => {
    const client = buildClient({ id: "med-1", userId: "someone-else" });
    const result = await assertMedicationOwnership("med-1", "caller", client);
    const body = (await result!.json()) as Record<string, unknown>;
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("someone-else");
    expect(serialised).not.toContain("caller");
  });

  it("propagates the underlying Prisma error rather than swallowing it", async () => {
    const client = {
      medication: {
        findUnique: vi.fn().mockRejectedValue(new Error("DB offline")),
      },
    };
    await expect(
      assertMedicationOwnership("med-1", "user-1", client),
    ).rejects.toThrow("DB offline");
  });

  it("only selects the minimal columns required for the comparison", async () => {
    const client = buildClient({ id: "med-1", userId: "user-1" });
    await assertMedicationOwnership("med-1", "user-1", client);
    const call = client.medication.findUnique.mock.calls[0][0];
    expect(call.select).toEqual({ id: true, userId: true });
  });
});
