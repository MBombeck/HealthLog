import { describe, expect, it, vi } from "vitest";

import { waitForMedicationIntakeImport } from "../intake-import-poll";

describe("waitForMedicationIntakeImport", () => {
  it("polls queued and running jobs until the durable result is done", async () => {
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "queued", result: null })
      .mockResolvedValueOnce({ status: "running", result: null })
      .mockResolvedValueOnce({
        status: "done",
        result: {
          imported: 3,
          skippedDuplicates: 1,
          skippedInvalid: 0,
        },
      });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForMedicationIntakeImport("/api/import/job-1/status", {
        readStatus,
        wait,
      }),
    ).resolves.toEqual({
      imported: 3,
      skippedDuplicates: 1,
      skippedInvalid: 0,
    });
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("rejects terminal failures without polling again", async () => {
    const readStatus = vi.fn().mockResolvedValue({
      status: "failed",
      result: null,
      failureReason: "worker failed",
    });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForMedicationIntakeImport("/api/import/job-1/status", {
        readStatus,
        wait,
      }),
    ).rejects.toThrow("worker failed");
    expect(readStatus).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
});
