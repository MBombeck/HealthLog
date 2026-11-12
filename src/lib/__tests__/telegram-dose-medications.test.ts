/**
 * Which medications the Telegram bot may offer a dose for or record one
 * against: tracked and active, with the Medications module on, and not past
 * the end of the course on the person's clock. A course that has not started
 * yet stays.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  moduleOn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findMany: db.findMany, findFirst: db.findFirst },
  },
}));
vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled: db.moduleOn }));

import {
  findTelegramDoseMedication,
  listTelegramDoseMedications,
} from "@/lib/telegram-dose-medications";

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (offset: number) => new Date(Date.now() + offset * DAY_MS);

const CHRONIC = {
  id: "chronic",
  name: "Ramipril",
  dose: "5 mg",
  startsOn: null,
  endsOn: null,
  endedAt: null,
};
const ENDED = {
  ...CHRONIC,
  id: "ended",
  startsOn: day(-12),
  endsOn: day(-2),
};
const ENDED_NOW = {
  ...CHRONIC,
  id: "ended-now",
  startsOn: day(-12),
  endsOn: day(0),
  endedAt: new Date(Date.now() - 60_000),
};
const UPCOMING = { ...CHRONIC, id: "upcoming", startsOn: day(3) };

beforeEach(() => {
  vi.clearAllMocks();
  db.moduleOn.mockResolvedValue(true);
});

describe("listTelegramDoseMedications", () => {
  it("leaves an ended course out and keeps a current or upcoming one", async () => {
    db.findMany.mockResolvedValue([CHRONIC, ENDED, ENDED_NOW, UPCOMING]);
    const listed = await listTelegramDoseMedications("user-1", "Europe/Berlin");
    expect(listed.map((m) => m.id)).toEqual(["chronic", "upcoming"]);
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", active: true, trackIntake: true },
      }),
    );
  });

  it("offers nothing with the Medications module off", async () => {
    db.moduleOn.mockResolvedValue(false);
    expect(await listTelegramDoseMedications("user-1", null)).toEqual([]);
    expect(db.moduleOn).toHaveBeenCalledWith("user-1", "medications");
    expect(db.findMany).not.toHaveBeenCalled();
  });
});

describe("findTelegramDoseMedication", () => {
  it("resolves a current course", async () => {
    db.findMany.mockResolvedValue([CHRONIC]);
    const found = await findTelegramDoseMedication("user-1", null, {
      id: "chronic",
    });
    expect(found?.id).toBe("chronic");
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "chronic",
          userId: "user-1",
          active: true,
          trackIntake: true,
        },
      }),
    );
  });

  it("refuses an ended course", async () => {
    db.findMany.mockResolvedValue([ENDED_NOW]);
    expect(
      await findTelegramDoseMedication("user-1", "Europe/Berlin", {
        id: "ended-now",
      }),
    ).toBeNull();
  });

  it("finds the current course beside an ended one of the same name", async () => {
    db.findMany.mockResolvedValue([ENDED, CHRONIC]);
    const found = await findTelegramDoseMedication("user-1", "Europe/Berlin", {
      name: { equals: "ramipril", mode: "insensitive" },
    });
    expect(found?.id).toBe("chronic");
  });

  it("judges the course at the dose's own slot", async () => {
    // The last evening dose, confirmed after midnight once the course ended.
    db.findMany.mockResolvedValue([ENDED_NOW]);
    const found = await findTelegramDoseMedication(
      "user-1",
      "Europe/Berlin",
      { id: "ended-now" },
      new Date(Date.now() - 3 * 60 * 60 * 1000),
    );
    expect(found?.id).toBe("ended-now");
  });

  it("refuses everything with the Medications module off", async () => {
    db.moduleOn.mockResolvedValue(false);
    expect(
      await findTelegramDoseMedication("user-1", null, { id: "chronic" }),
    ).toBeNull();
    expect(db.findMany).not.toHaveBeenCalled();
  });
});
