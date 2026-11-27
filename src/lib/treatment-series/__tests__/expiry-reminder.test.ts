import { beforeEach, describe, expect, it, vi } from "vitest";

const claimMock = vi.fn();
vi.mock("@/lib/notifications/reminder-dedup", () => ({
  claimNotificationEvent: (...args: unknown[]) => claimMock(...args),
}));
vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn(),
}));
vi.mock("@/lib/i18n/job-locale", () => ({
  resolveJobLocale: async (locale: string | null) => locale ?? "en",
}));
vi.mock("../dto", () => ({
  decryptSeriesText: () => "Physiotherapy, left knee",
}));

import type { PrismaClient } from "@/generated/prisma/client";
import { hasClientManagedApnsGate } from "@/lib/notifications/client-managed-apns";

import {
  buildSeriesExpiryPayload,
  runTreatmentSeriesExpiryTick,
  seriesExpiryDue,
} from "../expiry-reminder";

describe("seriesExpiryDue", () => {
  const series = { plannedSessions: 6, validUntil: "2026-12-10" };

  it("is due inside the week before the last valid day with sessions left", () => {
    expect(seriesExpiryDue(series, 3, "2026-12-03")).toEqual({
      due: true,
      remaining: 3,
    });
    expect(seriesExpiryDue(series, 3, "2026-12-10").due).toBe(true);
  });

  it("is not due before the window or after the last day", () => {
    expect(seriesExpiryDue(series, 3, "2026-12-02").due).toBe(false);
    expect(seriesExpiryDue(series, 3, "2026-12-11").due).toBe(false);
  });

  it("is off when no session is left or nothing can be left", () => {
    expect(seriesExpiryDue(series, 6, "2026-12-05")).toEqual({
      due: false,
      remaining: 0,
    });
    expect(
      seriesExpiryDue({ ...series, plannedSessions: null }, 1, "2026-12-05")
        .due,
    ).toBe(false);
    expect(
      seriesExpiryDue({ ...series, validUntil: null }, 1, "2026-12-05").due,
    ).toBe(false);
  });
});

describe("buildSeriesExpiryPayload", () => {
  it("names the series, the count left and the day", () => {
    const en = buildSeriesExpiryPayload("en", "Physio", 2, "2026-12-10");
    expect(en.title).toBe("Treatment series expiring");
    expect(en.message).toBe(
      "Physio: valid until Dec 10, 2026, 2 sessions left.",
    );
    const de = buildSeriesExpiryPayload("de", "Physio", 1, "2026-12-10");
    expect(de.message).toBe(
      "Physio: gültig bis 10.12.2026, noch 1 Sitzung offen.",
    );
  });
});

describe("the client-managed flag", () => {
  it("covers a check-up push but not a series running out", () => {
    expect(
      hasClientManagedApnsGate("MEASUREMENT_REMINDER", { reminderId: "r1" }),
    ).toBe(true);
    expect(
      hasClientManagedApnsGate("MEASUREMENT_REMINDER", {
        treatmentSeriesId: "s1",
      }),
    ).toBe(false);
  });
});

describe("runTreatmentSeriesExpiryTick", () => {
  const dispatch = vi.fn();
  // 09:15 in Berlin on 3 December.
  const now = new Date("2026-12-03T08:15:00.000Z");

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: "s1",
      titleEncrypted: new Uint8Array([1]),
      plannedSessions: 6,
      validUntil: new Date("2026-12-10T00:00:00.000Z"),
      user: { id: "u1", timezone: "Europe/Berlin", locale: "en" },
      sessions: [
        { id: "e1", occurredAt: new Date("2026-11-10"), status: "DONE" },
        { id: "e2", occurredAt: new Date("2026-11-14"), status: "DONE" },
        { id: "e3", occurredAt: new Date("2026-11-17"), status: "CANCELLED" },
      ],
      ...overrides,
    };
  }

  function prismaWith(rows: unknown[]) {
    const findMany = vi.fn().mockResolvedValue(rows);
    const release = vi.fn().mockResolvedValue({ count: 1 });
    return {
      prisma: {
        treatmentSeries: { findMany },
        notificationEvent: { deleteMany: release },
      } as unknown as PrismaClient,
      findMany,
      release,
    };
  }

  const claimRow = {
    where: {
      recordUserId: "u1",
      eventType: "MEASUREMENT_REMINDER",
      dedupKey: "series-expiry:s1:2026-12-10",
    },
  };

  it("gives the claim back when every channel failed, so the next hour retries", async () => {
    dispatch.mockResolvedValue({ dispatched: false, channelsAttempted: 2 });
    const { prisma, release } = prismaWith([row()]);
    await runTreatmentSeriesExpiryTick(prisma, now, { dispatch });
    expect(release).toHaveBeenCalledWith(claimRow);
  });

  it("gives the claim back when the send threw", async () => {
    dispatch.mockRejectedValue(new Error("dispatcher down"));
    const { prisma, release } = prismaWith([row()]);
    const summary = await runTreatmentSeriesExpiryTick(prisma, now, {
      dispatch,
    });
    expect(summary.failed).toBe(1);
    expect(release).toHaveBeenCalledWith(claimRow);
  });

  it("keeps the claim when it went out or no channel wants it", async () => {
    const { prisma, release } = prismaWith([row()]);
    await runTreatmentSeriesExpiryTick(prisma, now, { dispatch });
    dispatch.mockResolvedValue({ dispatched: false, channelsAttempted: 0 });
    await runTreatmentSeriesExpiryTick(prisma, now, { dispatch });
    expect(release).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    dispatch.mockReset().mockResolvedValue({ dispatched: true });
    claimMock.mockReset().mockResolvedValue(true);
  });

  it("sends one check-up reminder per series and expiry date", async () => {
    const { prisma, findMany } = prismaWith([row()]);
    const summary = await runTreatmentSeriesExpiryTick(prisma, now, {
      dispatch,
    });
    expect(summary.dispatched).toBe(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      deletedAt: null,
      endedOn: null,
      plannedSessions: { not: null },
    });
    expect(claimMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        recordUserId: "u1",
        eventType: "MEASUREMENT_REMINDER",
        dedupKey: "series-expiry:s1:2026-12-10",
      }),
    );
    const payload = dispatch.mock.calls[0][0];
    expect(payload).toMatchObject({
      eventType: "MEASUREMENT_REMINDER",
      userId: "u1",
      suppressActions: true,
      metadata: { treatmentSeriesId: "s1", url: "/checkups?series=s1" },
    });
    expect(payload.message).toContain("4 sessions left");
  });

  it("stays quiet outside the morning hour on the owner's clock", async () => {
    const { prisma } = prismaWith([
      row({ user: { id: "u1", timezone: "America/New_York", locale: "en" } }),
    ]);
    const summary = await runTreatmentSeriesExpiryTick(prisma, now, {
      dispatch,
    });
    expect(summary.dispatched).toBe(0);
    expect(claimMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not send again once claimed, nor when no session is left", async () => {
    claimMock.mockResolvedValueOnce(false);
    const done = Array.from({ length: 6 }, (_, i) => ({
      id: `d${i}`,
      occurredAt: new Date("2026-11-20"),
      status: "DONE",
    }));
    const { prisma } = prismaWith([row(), row({ id: "s2", sessions: done })]);
    const summary = await runTreatmentSeriesExpiryTick(prisma, now, {
      dispatch,
    });
    expect(summary.skippedAlreadyClaimed).toBe(1);
    expect(summary.skippedNothingLeft).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
