/**
 * Deleting an intake from the dose history is a soft delete with an Undo in
 * the toast, the way measurements, mood and labs delete. It used to open a
 * dialog that said the entry was "removed permanently" (it never was) and the
 * toast offered no way back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api/api-fetch", () => ({
  apiDelete: vi.fn().mockResolvedValue({ deleted: true }),
  apiPost: vi.fn().mockResolvedValue({ id: "new" }),
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));

import { apiDelete, apiPost } from "@/lib/api/api-fetch";
import {
  restoreIntakeBody,
  runDeleteIntake,
} from "@/components/medications/use-medication-intake";

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}${JSON.stringify(params)}` : key;
const formatTime = (at: Date) => at.toISOString().slice(11, 16);
/** The reader's 12-hour clock, as the time setting gives it. */
const wallTime12 = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(apiDelete).mockClear();
  vi.mocked(apiPost).mockClear();
});

describe("restoreIntakeBody", () => {
  it("records a taken dose again with its time, slot and dose", () => {
    expect(
      restoreIntakeBody({
        id: "e1",
        takenAt: "2026-11-20T07:12:00.000Z",
        skipped: false,
        scheduledFor: "2026-11-20T07:00:00.000Z",
        doseTaken: "5 mg",
      }),
    ).toEqual({
      skipped: false,
      takenAt: "2026-11-20T07:12:00.000Z",
      scheduledFor: "2026-11-20T07:00:00.000Z",
      doseTaken: "5 mg",
    });
  });

  it("records a skip again on its slot", () => {
    expect(
      restoreIntakeBody({
        id: "e1",
        takenAt: null,
        skipped: true,
        scheduledFor: "2026-11-20T07:00:00.000Z",
      }),
    ).toEqual({ skipped: true, scheduledFor: "2026-11-20T07:00:00.000Z" });
  });

  it("offers nothing to restore for an automatic missed placeholder", () => {
    expect(
      restoreIntakeBody({
        id: "e1",
        takenAt: null,
        skipped: false,
        scheduledFor: "2026-11-20T07:00:00.000Z",
        autoMissed: true,
      }),
    ).toBeNull();
  });
});

describe("runDeleteIntake", () => {
  it("deletes at once and offers an Undo that records the dose again", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    await runDeleteIntake({
      medicationId: "med-1",
      intake: {
        id: "e1",
        takenAt: "2026-11-20T08:00:00.000Z",
        skipped: false,
        scheduledFor: "2026-11-20T09:00:00.000Z",
      },
      t,
      formatTime,
      wallTime: (hhmm) => hhmm,
      reconcile,
    });
    expect(apiDelete).toHaveBeenCalledWith("/api/medications/med-1/intake/e1");
    expect(reconcile).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast.success).mock.calls[0];
    // The toast says which dose went: its slot and when it was taken.
    expect(message).toBe(
      t("medications.dose.removed", {
        dose: t("medications.dose.which.slotTaken", {
          slot: "09:00",
          taken: "08:00",
        }),
      }),
    );
    const action = (
      options as { action: { label: string; onClick: () => void } }
    ).action;
    expect(action.label).toBe("medications.dose.action.undo");

    action.onClick();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    expect(apiPost).toHaveBeenCalledWith("/api/medications/med-1/intake", {
      skipped: false,
      takenAt: "2026-11-20T08:00:00.000Z",
      scheduledFor: "2026-11-20T09:00:00.000Z",
    });
    expect(vi.mocked(toast.success).mock.calls[1][0]).toBe(
      t("medications.dose.restored", {
        dose: t("medications.dose.which.slotTaken", {
          slot: "09:00",
          taken: "08:00",
        }),
      }),
    );
  });

  it("names the slot by the schedule's own wall time in the reader's clock", async () => {
    await runDeleteIntake({
      medicationId: "med-1",
      intake: {
        id: "e2",
        takenAt: null,
        skipped: true,
        scheduledFor: "2026-11-20T20:00:00.000Z",
        slotTime: "21:00",
      },
      t,
      formatTime,
      wallTime: wallTime12,
      reconcile: vi.fn().mockResolvedValue(undefined),
    });
    expect(vi.mocked(toast.success).mock.calls[0][0]).toBe(
      t("medications.dose.removed", {
        dose: t("medications.dose.which.slotSkipped", { slot: "9:00 PM" }),
      }),
    );
  });
});
