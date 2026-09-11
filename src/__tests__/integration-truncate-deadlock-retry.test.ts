/**
 * The integration suite wipes the database between files with one
 * `TRUNCATE`, which needs the strictest lock on every table at once. The
 * server writes in thirty-nine places without awaiting the result, so one of
 * those can land after the test that caused it has returned and take the
 * truncate down with a deadlock. Postgres picks a victim; ours was an
 * unrelated file, twice in two days, green on the rerun both times.
 *
 * The helper retries that one error now. These cases hold it to exactly that:
 * it gives up on anything else immediately, and it does not retry forever.
 */
import { describe, expect, it, vi } from "vitest";

import { truncateAllTables } from "../../tests/integration/setup";

function deadlock(): Error & { code: string } {
  const error = new Error("deadlock detected") as Error & { code: string };
  error.code = "40P01";
  return error;
}

function fakeClient(executeRaw: ReturnType<typeof vi.fn>) {
  const empty = vi.fn().mockResolvedValue([]);
  return {
    $executeRawUnsafe: executeRaw,
    moodTag: { findMany: empty, createMany: vi.fn() },
    moodTagCategory: { findMany: empty, createMany: vi.fn() },
  } as unknown as Parameters<typeof truncateAllTables>[0];
}

describe("truncateAllTables", () => {
  it("retries a deadlocked truncate and succeeds once the lock clears", async () => {
    const executeRaw = vi
      .fn()
      .mockRejectedValueOnce(deadlock())
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValue(0);

    await truncateAllTables(fakeClient(executeRaw));

    expect(executeRaw).toHaveBeenCalledTimes(3);
  });

  it("gives up on an error that is not a deadlock, on the first attempt", async () => {
    const other = new Error("permission denied") as Error & { code: string };
    other.code = "42501";
    const executeRaw = vi.fn().mockRejectedValue(other);

    await expect(truncateAllTables(fakeClient(executeRaw))).rejects.toThrow(
      "permission denied",
    );
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("stops retrying a deadlock that never clears", async () => {
    const executeRaw = vi.fn().mockRejectedValue(deadlock());

    await expect(truncateAllTables(fakeClient(executeRaw))).rejects.toThrow(
      "deadlock detected",
    );
    expect(executeRaw).toHaveBeenCalledTimes(5);
  });
});
