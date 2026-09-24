/**
 * v1.15.18 — traceable dose-history reconstruction (spec B).
 *
 * Produces a complete, attributable ledger from the expected-slot bands +
 * the actual intake rows:
 *   - every expected slot appears with a status (taken_on_time / taken_late /
 *     skipped / missed / upcoming) even when never taken;
 *   - a TAKEN intake is attributed to a slot by its real `takenAt` band
 *     membership (NOT the stored, possibly-snapped `scheduledFor`), so the
 *     corrected bands converge forward over legacy mis-snapped rows;
 *   - skipped / auto-missed / pending rows bind to their slot by anchor
 *     (they were written against a slot deliberately);
 *   - a taken intake matching no slot band is emitted as a tagged `ad_hoc`
 *     row at its real time — never silently snapped onto a scheduled slot.
 */
import { describe, expect, it } from "vitest";

import { buildSlotBands, type SlotWindowInput } from "../attribution";
import {
  reconstructDoseHistory,
  suggestNearestSlot,
  type HistoryIntake,
} from "../dose-history";
import { localHmAsUtc } from "@/lib/tz/local-day";

const TZ = "Europe/Berlin";
const MIN = 60_000;
const day = new Date("2026-06-08T12:00:00Z");

function pointSlot(at: Date, timeOfDay: string): SlotWindowInput {
  return {
    at,
    timeOfDay,
    onTimeStart: new Date(at.getTime() - 60 * MIN),
    onTimeEnd: new Date(at.getTime() + 60 * MIN),
    lateGraceMs: 180 * MIN,
  };
}
const bands = buildSlotBands([
  pointSlot(localHmAsUtc(day, TZ, 7, 0), "07:00"),
  pointSlot(localHmAsUtc(day, TZ, 19, 0), "19:00"),
]);

function at(h: number, m: number): Date {
  return localHmAsUtc(day, TZ, h, m);
}
function intake(over: Partial<HistoryIntake>): HistoryIntake {
  return {
    id: "i",
    scheduledFor: at(7, 0),
    takenAt: null,
    skipped: false,
    autoMissed: false,
    ...over,
  };
}

// Late "now" so both of today's slots are past their miss cutoff.
const nowEvening = at(23, 59);

describe("reconstructDoseHistory", () => {
  it("emits one row per expected slot even with no intakes", () => {
    const rows = reconstructDoseHistory(bands, [], nowEvening, null);
    expect(rows.map((r) => r.timeOfDay)).toEqual(["07:00", "19:00"]);
    expect(rows.every((r) => r.kind === "slot")).toBe(true);
    expect(rows.map((r) => r.status)).toEqual(["missed", "missed"]);
  });

  it("attributes an on-time take to its slot", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ takenAt: at(7, 0), scheduledFor: at(7, 0) })],
      nowEvening,
      null,
    );
    const morning = rows.find((r) => r.timeOfDay === "07:00");
    expect(morning?.status).toBe("taken_on_time");
    expect(morning?.intake?.takenAt?.toISOString()).toBe(
      at(7, 0).toISOString(),
    );
  });

  it("attributes a take inside the late tail as taken_late", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ takenAt: at(8, 30), scheduledFor: at(7, 0) })],
      nowEvening,
      null,
    );
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe(
      "taken_late",
    );
  });

  it("emits an 11:29 take as an ad-hoc row and leaves 07:00 missed", () => {
    // the reported case: the stored scheduledFor was snapped to 07:00 by the old
    // write path, but the real takenAt (11:29) is outside every band → ad-hoc.
    const rows = reconstructDoseHistory(
      bands,
      [intake({ takenAt: at(11, 29), scheduledFor: at(7, 0) })],
      nowEvening,
      null,
    );
    const adhoc = rows.find((r) => r.kind === "ad_hoc");
    expect(adhoc?.status).toBe("ad_hoc");
    expect(adhoc?.at.toISOString()).toBe(at(11, 29).toISOString());
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("missed");
  });

  it("binds an explicit skip to its slot by anchor", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ skipped: true, scheduledFor: at(7, 0) })],
      nowEvening,
      null,
    );
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("skipped");
  });

  it("counts an auto-missed pending row as missed", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ autoMissed: true, scheduledFor: at(7, 0) })],
      nowEvening,
      null,
    );
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("missed");
  });

  it("marks a future slot upcoming, not missed", () => {
    const earlyMorning = at(5, 0); // before every slot's miss cutoff
    const rows = reconstructDoseHistory(bands, [], earlyMorning, null);
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("upcoming");
    expect(rows.find((r) => r.timeOfDay === "19:00")?.status).toBe("upcoming");
  });

  it("a second take near an already-filled slot becomes ad-hoc", () => {
    const rows = reconstructDoseHistory(
      bands,
      [
        intake({ id: "a", takenAt: at(7, 0), scheduledFor: at(7, 0) }),
        intake({ id: "b", takenAt: at(7, 20), scheduledFor: at(7, 0) }),
      ],
      nowEvening,
      null,
    );
    expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe(
      "taken_on_time",
    );
    const adhoc = rows.filter((r) => r.kind === "ad_hoc");
    expect(adhoc).toHaveLength(1);
    expect(adhoc[0].intake?.id).toBe("b");
  });

  // v1.15.19 — time-aware pending-row semantics. The today-projector and the
  // reminder worker mint pending rows (takenAt = null, neither skipped nor
  // auto-missed) for every slot of the day up front, so a pending row's
  // status must be derived from the clock exactly like an unfilled slot's:
  // missed only past the slot's miss cutoff, upcoming until then.
  describe("pending (server-minted) rows", () => {
    it("reads upcoming while now is inside the slot's overdue window", () => {
      // 07:00 slot: on-time ends 08:00, late tail ends 11:00. At 08:30 the
      // dose is still takeable — the pending row must not read missed.
      const rows = reconstructDoseHistory(
        bands,
        [intake({ scheduledFor: at(7, 0) })],
        at(8, 30),
        null,
      );
      const morning = rows.find((r) => r.timeOfDay === "07:00");
      expect(morning?.status).toBe("upcoming");
      // The row stays bound to its slot (the intake annotates it).
      expect(morning?.intake?.id).toBe("i");
    });

    it("reads missed once now is past the slot's overdueEnd", () => {
      // 07:00 band's miss cutoff is 11:00; at 12:00 the dose is gone.
      const rows = reconstructDoseHistory(
        bands,
        [intake({ scheduledFor: at(7, 0) })],
        at(12, 0),
        null,
      );
      expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("missed");
    });

    it("weekly slot: a pending row 2 days past the anchor stays upcoming inside the 4-day tail", () => {
      const HOUR_MS = 60 * MIN;
      const DAY_MS = 24 * HOUR_MS;
      const weeklyAt = localHmAsUtc(day, TZ, 7, 0);
      const weeklyBands = buildSlotBands([
        {
          at: weeklyAt,
          timeOfDay: "07:00",
          onTimeStart: new Date(weeklyAt.getTime() - 12 * HOUR_MS),
          onTimeEnd: new Date(weeklyAt.getTime() + 12 * HOUR_MS),
          // Weekly injectable: the clinical 4-day late tail.
          lateGraceMs: 4 * DAY_MS,
        },
      ]);
      const twoDaysLater = new Date(weeklyAt.getTime() + 2 * DAY_MS);
      const rows = reconstructDoseHistory(
        weeklyBands,
        [intake({ scheduledFor: weeklyAt })],
        twoDaysLater,
        null,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("upcoming");
    });

    it("drops a pending row matching no band instead of emitting a phantom ad-hoc row", () => {
      // `to = now` early-afternoon read: the 19:00 band is outside the
      // minted window, but the projector already minted the evening pending
      // row. It is a server placeholder, not a user action — it must not
      // surface as an ad-hoc row with takenAt = null.
      const morningOnly = bands.filter((b) => b.timeOfDay === "07:00");
      const rows = reconstructDoseHistory(
        morningOnly,
        [intake({ scheduledFor: at(19, 0) })],
        at(14, 0),
        null,
      );
      expect(rows.filter((r) => r.kind === "ad_hoc")).toHaveLength(0);
      expect(rows.map((r) => r.timeOfDay)).toEqual(["07:00"]);
    });

    it("a skip with no band match still surfaces ad-hoc (deliberate action)", () => {
      const morningOnly = bands.filter((b) => b.timeOfDay === "07:00");
      const rows = reconstructDoseHistory(
        morningOnly,
        [intake({ skipped: true, scheduledFor: at(19, 0) })],
        at(14, 0),
        null,
      );
      expect(rows.filter((r) => r.kind === "ad_hoc")).toHaveLength(1);
    });

    it("auto-missed stays missed even while the overdue window is still open", () => {
      // The cron's verdict is authoritative — the clock does not resurrect it.
      const rows = reconstructDoseHistory(
        bands,
        [intake({ autoMissed: true, scheduledFor: at(7, 0) })],
        at(8, 30),
        null,
      );
      expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("missed");
    });
  });

  // v1.15.20 — deliberate user pins ("diesem Slot zuordnen"). A USER_PIN row
  // binds by its stored `scheduledFor` anchor like a skip, NOT by takenAt
  // band membership, so a pin outside the late tail stays on its slot. The
  // status never flatters: taken_late unless the takenAt happens to sit
  // inside the slot's own on-time band anyway.
  describe("pinned takes (USER_PIN)", () => {
    it("binds an off-band pinned take to its slot anchor as taken_late", () => {
      // 13:00 is past the 07:00 band's miss cutoff (11:00) — unpinned it
      // would be ad-hoc and the slot missed; the pin keeps it on the slot.
      const rows = reconstructDoseHistory(
        bands,
        [intake({ takenAt: at(13, 0), scheduledFor: at(7, 0), pinned: true })],
        nowEvening,
        null,
      );
      const morning = rows.find((r) => r.timeOfDay === "07:00");
      expect(morning?.status).toBe("taken_late");
      expect(morning?.pinned).toBe(true);
      expect(morning?.intake?.takenAt?.toISOString()).toBe(
        at(13, 0).toISOString(),
      );
      expect(rows.filter((r) => r.kind === "ad_hoc")).toHaveLength(0);
    });

    it("reads taken_on_time only when the takenAt sits inside the on-time band anyway", () => {
      const rows = reconstructDoseHistory(
        bands,
        [intake({ takenAt: at(7, 30), scheduledFor: at(7, 0), pinned: true })],
        nowEvening,
        null,
      );
      const morning = rows.find((r) => r.timeOfDay === "07:00");
      expect(morning?.status).toBe("taken_on_time");
      expect(morning?.pinned).toBe(true);
    });

    // The pin confirm dialog promises exactly this split: on time inside the
    // slot's on-time window (also ahead of the slot's clock time), late
    // otherwise.
    it("an early pin inside the on-time window reads on time, one before it reads late", () => {
      const early = reconstructDoseHistory(
        bands,
        [intake({ takenAt: at(6, 15), scheduledFor: at(7, 0), pinned: true })],
        nowEvening,
        null,
      );
      expect(early.find((r) => r.timeOfDay === "07:00")?.status).toBe(
        "taken_on_time",
      );
      const tooEarly = reconstructDoseHistory(
        bands,
        [intake({ takenAt: at(5, 30), scheduledFor: at(7, 0), pinned: true })],
        nowEvening,
        null,
      );
      expect(tooEarly.find((r) => r.timeOfDay === "07:00")?.status).toBe(
        "taken_late",
      );
    });

    it("a pin inside the late tail reads taken_late, never flattered", () => {
      const rows = reconstructDoseHistory(
        bands,
        [intake({ takenAt: at(9, 0), scheduledFor: at(7, 0), pinned: true })],
        nowEvening,
        null,
      );
      expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe(
        "taken_late",
      );
    });

    it("a deliberate pin claims the slot before a band-attributed take", () => {
      const rows = reconstructDoseHistory(
        bands,
        [
          intake({ id: "auto", takenAt: at(7, 0), scheduledFor: at(7, 0) }),
          intake({
            id: "pin",
            takenAt: at(13, 0),
            scheduledFor: at(7, 0),
            pinned: true,
          }),
        ],
        nowEvening,
        null,
      );
      const morning = rows.find((r) => r.timeOfDay === "07:00");
      expect(morning?.intake?.id).toBe("pin");
      expect(morning?.status).toBe("taken_late");
      const adhoc = rows.filter((r) => r.kind === "ad_hoc");
      expect(adhoc.map((r) => r.intake?.id)).toEqual(["auto"]);
    });

    it("falls through to ad-hoc when the pinned slot is already claimed by a skip", () => {
      const rows = reconstructDoseHistory(
        bands,
        [
          intake({ id: "skip", skipped: true, scheduledFor: at(7, 0) }),
          intake({
            id: "pin",
            takenAt: at(13, 0),
            scheduledFor: at(7, 0),
            pinned: true,
          }),
        ],
        nowEvening,
        null,
      );
      expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("skipped");
      const adhoc = rows.filter((r) => r.kind === "ad_hoc");
      expect(adhoc.map((r) => r.intake?.id)).toEqual(["pin"]);
    });

    it("falls through to ad-hoc when the pinned anchor matches no band (schedule changed)", () => {
      const rows = reconstructDoseHistory(
        bands,
        [
          intake({
            takenAt: at(15, 30),
            scheduledFor: at(15, 0),
            pinned: true,
          }),
        ],
        nowEvening,
        null,
      );
      const adhoc = rows.filter((r) => r.kind === "ad_hoc");
      expect(adhoc).toHaveLength(1);
      expect(adhoc[0].at.toISOString()).toBe(at(15, 30).toISOString());
    });

    // v1.16.0 — a RELEASED pin ("Zuordnung lösen") persists USER_PIN with
    // `scheduledFor === takenAt`: deliberately ad-hoc, never anchor-bound.
    it("surfaces a released pin (scheduledFor === takenAt) as a pinned ad-hoc row, never taken_late", () => {
      const rows = reconstructDoseHistory(
        bands,
        [intake({ takenAt: at(9, 0), scheduledFor: at(9, 0), pinned: true })],
        nowEvening,
        null,
      );
      const adhoc = rows.filter((r) => r.kind === "ad_hoc");
      expect(adhoc).toHaveLength(1);
      expect(adhoc[0].status).toBe("ad_hoc");
      expect(adhoc[0].pinned).toBe(true);
      // The 07:00 slot stays unserved (missed by evening) — the released
      // take must not be pulled back onto it.
      expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("missed");
    });

    it("a released pin within anchor epsilon of a slot still reads ad-hoc (no re-binding)", () => {
      // 07:00:30 sits 30 s from the 07:00 anchor — inside ANCHOR_EPSILON_MS.
      // Without the release guard the pinned path would claim the slot as
      // taken_on_time, silently reverting the user's release.
      const t = new Date(at(7, 0).getTime() + 30_000);
      const rows = reconstructDoseHistory(
        bands,
        [intake({ takenAt: t, scheduledFor: t, pinned: true })],
        nowEvening,
        null,
      );
      const adhoc = rows.filter((r) => r.kind === "ad_hoc");
      expect(adhoc).toHaveLength(1);
      expect(adhoc[0].pinned).toBe(true);
      expect(rows.find((r) => r.timeOfDay === "07:00")?.status).toBe("missed");
    });
  });

  // v1.15.20 — the due-context an ad-hoc take carries. With the test
  // geometry the 07:00 band runs 06:00–11:00 (on-time 06:00–08:00, 180min
  // tail), so its suggestion zone extends to 12:30 (tail + 50 %).
  describe("ad-hoc nearestSlot due-context", () => {
    it("an ad-hoc take inside an unserved slot's suggestion zone offers the pin", () => {
      const rows = reconstructDoseHistory(
        bands,
        [intake({ takenAt: at(11, 29), scheduledFor: at(7, 0) })],
        nowEvening,
        null,
      );
      const adhoc = rows.find((r) => r.kind === "ad_hoc");
      expect(adhoc?.nearestSlot?.timeOfDay).toBe("07:00");
      expect(adhoc?.nearestSlot?.at.toISOString()).toBe(at(7, 0).toISOString());
      expect(adhoc?.nearestSlot?.filled).toBe(false);
    });

    it("a take past the suggestion zone keeps the context but reads filled (no pin offer)", () => {
      // 12:45 > 12:30 — outside the zone even though the slot is unserved.
      const rows = reconstructDoseHistory(
        bands,
        [intake({ takenAt: at(12, 45), scheduledFor: at(7, 0) })],
        nowEvening,
        null,
      );
      const adhoc = rows.find((r) => r.kind === "ad_hoc");
      expect(adhoc?.nearestSlot?.timeOfDay).toBe("07:00");
      expect(adhoc?.nearestSlot?.filled).toBe(true);
    });

    it("a second take near an already-served slot reads filled", () => {
      const rows = reconstructDoseHistory(
        bands,
        [
          intake({ id: "a", takenAt: at(7, 0), scheduledFor: at(7, 0) }),
          intake({ id: "b", takenAt: at(7, 20), scheduledFor: at(7, 0) }),
        ],
        nowEvening,
        null,
      );
      const adhoc = rows.find((r) => r.kind === "ad_hoc");
      expect(adhoc?.intake?.id).toBe("b");
      expect(adhoc?.nearestSlot?.timeOfDay).toBe("07:00");
      expect(adhoc?.nearestSlot?.filled).toBe(true);
    });

    it("an orphaned ad-hoc skip carries no due-context", () => {
      const morningOnly = bands.filter((b) => b.timeOfDay === "07:00");
      const rows = reconstructDoseHistory(
        morningOnly,
        [intake({ skipped: true, scheduledFor: at(19, 0) })],
        at(14, 0),
        null,
      );
      const adhoc = rows.find((r) => r.kind === "ad_hoc");
      expect(adhoc).toBeDefined();
      expect(adhoc?.nearestSlot).toBeUndefined();
    });

    it("suggestNearestSlot caps the zone at the next slot's on-time start", () => {
      // 07:00's tail+50 % would reach 12:30, but the 12:00 slot's on-time
      // window opens at 11:30 — the zones must stay disjoint.
      const tight = buildSlotBands([
        pointSlot(at(7, 0), "07:00"),
        {
          at: at(12, 0),
          timeOfDay: "12:00",
          onTimeStart: at(11, 30),
          onTimeEnd: at(12, 30),
          lateGraceMs: 180 * MIN,
        },
      ]);
      const before = suggestNearestSlot(at(11, 15), tight, () => false);
      expect(before?.timeOfDay).toBe("07:00");
      expect(before?.filled).toBe(false);
      const after = suggestNearestSlot(at(11, 45), tight, () => false);
      expect(after?.timeOfDay).toBe("12:00");
      expect(after?.filled).toBe(false);
    });

    it("suggestNearestSlot returns null without bands", () => {
      expect(suggestNearestSlot(at(9, 0), [], () => false)).toBeNull();
    });
  });

  it("returns rows in chronological order (slots + ad-hoc interleaved)", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ id: "x", takenAt: at(13, 0), scheduledFor: at(13, 0) })],
      nowEvening,
      null,
    );
    const times = rows.map((r) => r.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("suggestNearestSlot fallback cap", () => {
  it("omits due-context when the nearest anchor sits days away", async () => {
    const { suggestNearestSlot } = await import("../dose-history");
    const mk = (iso: string) => {
      const at = new Date(iso);
      return {
        at,
        timeOfDay: "09:00",
        onTimeStart: new Date(at.getTime() - 60 * 60_000),
        onTimeEnd: new Date(at.getTime() + 60 * 60_000),
        overdueEnd: new Date(at.getTime() + 4 * 60 * 60_000),
      } as never;
    };
    // First minted slot is 2026-05-31 (startsOn); the take predates it by 6 days.
    const bands = [mk("2026-05-31T07:00:00Z"), mk("2026-06-01T07:00:00Z")];
    const far = suggestNearestSlot(
      new Date("2026-05-25T09:26:00Z"),
      bands,
      () => false,
    );
    expect(far).toBeNull();
    // A take inside the suggestion zone still gets its context.
    const near = suggestNearestSlot(
      new Date("2026-05-31T08:30:00Z"),
      bands,
      () => false,
    );
    expect(near?.timeOfDay).toBe("09:00");
  });
});

/**
 * #1028 — a medication created between its 07:00 and 19:00 slots. The 07:00
 * slot predates it: it shows only when a recorded dose claims it, and a
 * pending or auto-missed placeholder on it never reads as missed or as an
 * off-schedule row.
 */
describe("reconstructDoseHistory — slots before the medication existed (#1028)", () => {
  const createdAt = at(12, 0);
  const statusRows = (rows: ReturnType<typeof reconstructDoseHistory>) =>
    rows.map((r) => [r.kind, r.timeOfDay, r.status, r.intake?.id ?? null]);

  it("omits an unclaimed pre-creation slot and keeps the later one", () => {
    const rows = reconstructDoseHistory(bands, [], nowEvening, createdAt);
    expect(statusRows(rows)).toEqual([["slot", "19:00", "missed", null]]);
  });

  it("drops an auto-missed placeholder on a pre-creation slot", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ id: "placeholder", scheduledFor: at(7, 0), autoMissed: true })],
      nowEvening,
      createdAt,
    );
    expect(statusRows(rows)).toEqual([["slot", "19:00", "missed", null]]);
  });

  it("drops a pending placeholder on a pre-creation slot", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ id: "pending", scheduledFor: at(7, 0) })],
      nowEvening,
      createdAt,
    );
    expect(statusRows(rows)).toEqual([["slot", "19:00", "missed", null]]);
  });

  it("drops an auto-missed placeholder whose pre-creation slot was not minted", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ id: "orphan", scheduledFor: at(3, 0), autoMissed: true })],
      nowEvening,
      createdAt,
    );
    expect(rows.some((r) => r.intake?.id === "orphan")).toBe(false);
  });

  it("materialises a pre-creation slot a take claims by its stored slot instant", () => {
    const rows = reconstructDoseHistory(
      bands,
      [intake({ id: "t", scheduledFor: at(7, 0), takenAt: at(7, 0) })],
      nowEvening,
      createdAt,
    );
    expect(statusRows(rows)).toEqual([
      ["slot", "07:00", "taken_on_time", "t"],
      ["slot", "19:00", "missed", null],
    ]);
  });

  it("materialises a pre-creation slot a take claims by band membership", () => {
    // Stored as an unanchored take (scheduledFor === takenAt), late.
    const rows = reconstructDoseHistory(
      bands,
      [intake({ id: "t", scheduledFor: at(9, 30), takenAt: at(9, 30) })],
      nowEvening,
      createdAt,
    );
    expect(statusRows(rows)[0]).toEqual(["slot", "07:00", "taken_late", "t"]);
  });

  it("materialises a pre-creation slot a pin or a skip claims", () => {
    const pinned = reconstructDoseHistory(
      bands,
      [
        intake({
          id: "p",
          scheduledFor: at(7, 0),
          takenAt: at(11, 30),
          pinned: true,
        }),
      ],
      nowEvening,
      createdAt,
    );
    expect(statusRows(pinned)[0]).toEqual(["slot", "07:00", "taken_late", "p"]);

    const skipped = reconstructDoseHistory(
      bands,
      [intake({ id: "s", scheduledFor: at(7, 0), skipped: true })],
      nowEvening,
      createdAt,
    );
    expect(statusRows(skipped)[0]).toEqual(["slot", "07:00", "skipped", "s"]);
  });

  it("does not offer an absent pre-creation slot as due-context", () => {
    // A take far outside every band, before the creation.
    const rows = reconstructDoseHistory(
      bands,
      [intake({ id: "x", scheduledFor: at(1, 0), takenAt: at(1, 0) })],
      nowEvening,
      createdAt,
    );
    const adHoc = rows.find((r) => r.intake?.id === "x");
    expect(adHoc?.kind).toBe("ad_hoc");
    expect(adHoc?.nearestSlot?.timeOfDay).not.toBe("07:00");
  });

  it("treats every band as expected when no floor is given", () => {
    const rows = reconstructDoseHistory(bands, [], nowEvening, null);
    expect(rows.map((r) => r.timeOfDay)).toEqual(["07:00", "19:00"]);
  });
});
