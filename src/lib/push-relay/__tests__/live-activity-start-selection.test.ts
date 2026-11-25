/**
 * Which dose a relay push-to-start picks: one rule, read off the dose
 * resolver the today list uses, for every pass including the first one after
 * the Live Activity consent.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_LEAD_MS,
  newLaStartRef,
  pickStartDose,
  startableDose,
} from "@/lib/push-relay/live-activity";
import {
  resolveDoseState,
  type SlotOutcome,
} from "@/lib/medications/dose-state/resolve";

const MIN = 60_000;
const NOW = new Date("2026-11-22T20:26:12Z");

/**
 * A dose on `slot` with a band of `onTime` minutes either side and a miss
 * cutoff `late` minutes after the slot, resolved at `now`.
 */
function dose(
  medicationId: string,
  slot: Date,
  opts: {
    liveActivityEnabled?: boolean;
    outcome?: SlotOutcome | null;
    onTime?: { start: number; end: number };
    late?: number;
    now?: Date;
  } = {},
) {
  const onTime = opts.onTime ?? { start: -60, end: 60 };
  const band = {
    at: slot,
    earlyStart: new Date(slot.getTime() + (onTime.start - 30) * MIN),
    onTimeStart: new Date(slot.getTime() + onTime.start * MIN),
    onTimeEnd: new Date(slot.getTime() + onTime.end * MIN),
    overdueEnd: new Date(slot.getTime() + (opts.late ?? 240) * MIN),
  };
  return {
    medicationId,
    scheduledFor: slot,
    liveActivityEnabled: opts.liveActivityEnabled ?? true,
    resolved: resolveDoseState(band, opts.outcome ?? null, opts.now ?? NOW),
  };
}

const minutesFrom = (base: Date, m: number) =>
  new Date(base.getTime() + m * MIN);

describe("a dose the pass may start", () => {
  it.each([
    ["pending, inside the lead", { slot: 90 }, true],
    ["due, before the slot", { slot: 30 }, true],
    ["due, after the slot", { slot: -30 }, true],
    ["overdue", { slot: -90 }, false],
    ["missed", { slot: -300 }, false],
    ["further ahead than the lead", { slot: 121 }, false],
    ["with the opt-in off", { slot: 30, liveActivityEnabled: false }, false],
    ["taken", { slot: 30, outcome: { takenAt: NOW, skipped: false } }, false],
    ["skipped", { slot: 30, outcome: { takenAt: null, skipped: true } }, false],
    [
      "closed by the auto-miss pass",
      {
        slot: -30,
        outcome: { takenAt: null, skipped: false, autoMissed: true },
      },
      false,
    ],
  ] as const)("%s", (_label, input, expected) => {
    const d = dose("m", minutesFrom(NOW, input.slot), {
      liveActivityEnabled:
        "liveActivityEnabled" in input ? input.liveActivityEnabled : true,
      outcome: "outcome" in input ? input.outcome : null,
    });
    expect(startableDose(d, NOW)).toBe(expected);
  });

  it("opens exactly at the lead before the slot", () => {
    const slot = minutesFrom(NOW, 150);
    const at = (ms: number) => new Date(slot.getTime() - ACTIVITY_LEAD_MS + ms);
    expect(startableDose(dose("m", slot, { now: at(-1) }), at(-1))).toBe(false);
    expect(startableDose(dose("m", slot, { now: at(0) }), at(0))).toBe(true);
  });

  it("closes exactly where the resolver turns the dose overdue", () => {
    const slot = minutesFrom(NOW, -10);
    const end = minutesFrom(slot, 60);
    const plus = (ms: number) => new Date(end.getTime() + ms);
    expect(startableDose(dose("m", slot, { now: end }), end)).toBe(true);
    expect(startableDose(dose("m", slot, { now: plus(1) }), plus(1))).toBe(
      false,
    );
  });

  it("follows the medication's own window, not a fixed minute", () => {
    // On time from the slot to three hours after it: 150 minutes past the
    // slot is still due by the stored window.
    const slot = minutesFrom(NOW, -150);
    expect(
      startableDose(dose("m", slot, { onTime: { start: 0, end: 180 } }), NOW),
    ).toBe(true);
  });
});

describe("the dose the pass picks", () => {
  it("is the earliest startable slot", () => {
    const later = dose("a", minutesFrom(NOW, 60));
    const sooner = dose("b", minutesFrom(NOW, 20));
    expect(pickStartDose([later, sooner], NOW)).toBe(sooner);
    expect(pickStartDose([sooner, later], NOW)).toBe(sooner);
  });

  it("breaks a tie on the medication id, whatever the read order", () => {
    const slot = minutesFrom(NOW, 30);
    const a = dose("a", slot);
    const b = dose("b", slot);
    expect(pickStartDose([b, a], NOW)).toBe(a);
    expect(pickStartDose([a, b], NOW)).toBe(a);
  });

  it("passes over an earlier dose that is behind or not opted in", () => {
    const overdue = dose("a", minutesFrom(NOW, -90));
    const optedOut = dose("b", minutesFrom(NOW, 10), {
      liveActivityEnabled: false,
    });
    const next = dose("c", minutesFrom(NOW, 40));
    expect(pickStartDose([overdue, optedOut, next], NOW)).toBe(next);
  });

  it("is none when nothing is entering its window", () => {
    expect(
      pickStartDose(
        [dose("a", minutesFrom(NOW, -90)), dose("b", minutesFrom(NOW, 180))],
        NOW,
      ),
    ).toBeNull();
    expect(pickStartDose([], NOW)).toBeNull();
  });

  it("starts the opted-in due dose, not the long-overdue one without the opt-in", () => {
    // The first pass after a consent given at 20:21:13Z, at 20:26:12Z: a
    // daily 19:00 Europe/Berlin dose (18:00Z, window 18:00Z to 19:00Z, Live
    // Activity off) stood open about an hour and a half past its window;
    // another medication's 21:32 dose (20:32Z, window 20:02Z to 21:32Z, Live
    // Activity on) was due. The pass started the first.
    const overdue = dose(
      "cmwrpnps2001g01no0e27x6hy",
      new Date("2026-11-22T18:00:00Z"),
      {
        liveActivityEnabled: false,
        onTime: { start: 0, end: 60 },
        late: 360,
      },
    );
    const due = dose(
      "cmwsaefjx1dc701liy7yot43m",
      new Date("2026-11-22T20:32:00Z"),
      {
        onTime: { start: -30, end: 60 },
      },
    );
    expect(overdue.resolved.state).toBe("overdue");
    expect(due.resolved.state).toBe("due");
    expect(pickStartDose([overdue, due], NOW)).toBe(due);
    // With the opt-in on it is still behind: no backlog catch-up.
    expect(
      pickStartDose([{ ...overdue, liveActivityEnabled: true }], NOW),
    ).toBeNull();
  });
});

describe("the start id the relay writes into the Activity", () => {
  it("is 16 random bytes and carries no time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const a = newLaStartRef();
      const b = newLaStartRef();
      expect(a).toMatch(/^las-[A-Za-z0-9_-]{22}$/);
      expect(Buffer.from(a.slice(4), "base64url")).toHaveLength(16);
      // Minted in the same millisecond, the two share nothing.
      expect(a).not.toBe(b);
      expect(a.slice(4, 14)).not.toBe(b.slice(4, 14));
      // No ULID: a ULID's first ten characters are the creation time.
      expect(a).not.toMatch(/^las-[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      vi.useRealTimers();
    }
  });
});
