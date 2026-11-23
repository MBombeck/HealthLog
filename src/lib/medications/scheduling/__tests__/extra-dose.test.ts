/**
 * An extra dose next to a slot that already carries one.
 *
 * Two ends: the write path keeps a different external dose record off a slot
 * that is already taken (`isAnotherDose`), and the read ledger lets the dose
 * stored on the slot claim it before an extra one stored on its own instant,
 * whatever order the rows were read in.
 */
import { describe, expect, it } from "vitest";

import { buildSlotBands, type SlotWindowInput } from "../attribution";
import { reconstructDoseHistory, type HistoryIntake } from "../dose-history";
import { DOUBLE_ENTRY_TOLERANCE_MS, isAnotherDose } from "../extra-dose";

const MIN = 60_000;
const t0 = new Date("2026-06-09T20:00:00Z");
const plus = (minutes: number) => new Date(t0.getTime() + minutes * MIN);

describe("isAnotherDose", () => {
  // 22:00 in Berlin; the next local day starts two hours later.
  const TZ = "Europe/Berlin";
  const external = (id: string, minutes: number, namesSlot = false) => ({
    takenAt: plus(minutes),
    externalId: id,
    namesSlot,
  });

  it("a slot with nothing taken is never held by another dose", () => {
    expect(
      isAnotherDose(
        { takenAt: null, externalId: null },
        external("hk-2", 600),
        TZ,
      ),
    ).toBe(false);
  });

  it("the same external record is the same dose", () => {
    expect(
      isAnotherDose(
        { takenAt: t0, externalId: "hk-1" },
        external("hk-1", 600),
        TZ,
      ),
    ).toBe(false);
  });

  it("a take on another local day is another dose, whoever recorded either", () => {
    // 22:00 and 00:30 the next morning in Berlin: an hour and a half apart,
    // two calendar days.
    for (const held of [
      { takenAt: t0, externalId: "hk-1" },
      { takenAt: t0, externalId: null },
    ]) {
      expect(isAnotherDose(held, external("hk-2", 150, true), TZ)).toBe(true);
      expect(isAnotherDose(held, external("hk-2", 24 * 60 + 22), TZ)).toBe(
        true,
      );
    }
  });

  it("a take logged in HealthLog converges with an external record of the same day", () => {
    const held = { takenAt: t0, externalId: null };
    expect(isAnotherDose(held, external("hk-2", 20), TZ)).toBe(false);
    expect(isAnotherDose(held, external("hk-2", -90), TZ)).toBe(false);
  });

  it("a new record that names the slot is the slot's dose recorded again (an edit in Health)", () => {
    expect(
      isAnotherDose(
        { takenAt: t0, externalId: "hk-1" },
        external("hk-1-edited", 30, true),
        TZ,
      ),
    ).toBe(false);
  });

  it("an unscheduled record of the same day is another dose beyond a double entry", () => {
    const held = { takenAt: t0, externalId: "hk-1" };
    expect(isAnotherDose(held, external("hk-2", 30), TZ)).toBe(true);
    expect(
      isAnotherDose(
        held,
        {
          takenAt: new Date(t0.getTime() + DOUBLE_ENTRY_TOLERANCE_MS),
          externalId: "hk-2",
          namesSlot: false,
        },
        TZ,
      ),
    ).toBe(false);
  });
});

describe("reconstructDoseHistory: the slot's own dose claims the slot", () => {
  const slot: SlotWindowInput = {
    at: t0,
    timeOfDay: "22:00",
    onTimeStart: plus(-60),
    onTimeEnd: plus(60),
    lateGraceMs: 180 * MIN,
  };
  const bands = buildSlotBands([slot]);
  const onSlot: HistoryIntake = {
    id: "on-slot",
    scheduledFor: t0,
    takenAt: plus(5),
    skipped: false,
  };
  const extra: HistoryIntake = {
    id: "extra",
    scheduledFor: plus(30),
    takenAt: plus(30),
    skipped: false,
  };

  it.each([
    ["slot row first", [onSlot, extra]],
    ["extra row first (newest scheduledFor first)", [extra, onSlot]],
  ])("%s", (_label, intakes) => {
    const rows = reconstructDoseHistory(bands, intakes, plus(600), null);
    const slotRow = rows.find((row) => row.kind === "slot");
    const adHoc = rows.filter((row) => row.kind === "ad_hoc");
    expect(slotRow?.intake?.id).toBe("on-slot");
    expect(adHoc.map((row) => row.intake?.id)).toEqual(["extra"]);
  });

  it("among takes not stored on the slot, the nearer one claims it", () => {
    const far: HistoryIntake = { ...extra, id: "far" };
    const near: HistoryIntake = {
      id: "near",
      scheduledFor: plus(10),
      takenAt: plus(10),
      skipped: false,
    };
    const rows = reconstructDoseHistory(bands, [far, near], plus(600), null);
    expect(rows.find((row) => row.kind === "slot")?.intake?.id).toBe("near");
  });
});
