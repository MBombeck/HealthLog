/**
 * The visible "dose recorded elsewhere" confirmation is a wire contract with
 * the iOS Notification Service Extension: field names, the quiet alert shape,
 * and no medication name in clear text.
 */
import { describe, expect, it } from "vitest";

import {
  intakeRecordedPayload,
  recordedEventOf,
  reopenedEventOf,
  REOPENED_WINDOW_MS,
} from "../medication-intake-recorded";

const AS_OF = new Date("2026-11-21T07:12:03.000Z");

const ROW = {
  id: "evt-1",
  medicationId: "med-1",
  scheduledFor: new Date("2026-11-21T07:00:00.000Z"),
  takenAt: new Date("2026-11-21T07:12:00.000Z"),
  skipped: false,
};

describe("MEDICATION_INTAKE_RECORDED", () => {
  it("is a passive, mutable alert per medication thread with the slot fields", () => {
    const event = recordedEventOf(ROW, "INTEGRATION")!;
    const payload = intakeRecordedPayload(event, "en", AS_OF) as {
      aps: Record<string, unknown> & { alert: { title: string; body: string } };
    } & Record<string, unknown>;
    expect(payload.aps["mutable-content"]).toBe(1);
    expect(payload.aps["interruption-level"]).toBe("passive");
    expect(payload.aps["thread-id"]).toBe("medication-med-1");
    expect(payload).toMatchObject({
      eventType: "MEDICATION_INTAKE_RECORDED",
      medicationId: "med-1",
      intakeId: "evt-1",
      slotInstant: "2026-11-21T07:00:00.000Z",
      outcome: "taken",
      takenAt: "2026-11-21T07:12:00.000Z",
      takenVia: "INTEGRATION",
      asOf: "2026-11-21T07:12:03.000Z",
    });
    expect(payload.aps.alert.title.length).toBeGreaterThan(0);
    expect(payload.aps.alert.body).not.toMatch(/notifications\./);
  });

  it("names a skip as a skip, with no take time and no origin", () => {
    const event = recordedEventOf(
      { ...ROW, takenAt: null, skipped: true },
      "TELEGRAM",
    )!;
    const payload = intakeRecordedPayload(event, "de", AS_OF);
    expect(payload).toMatchObject({
      outcome: "skipped",
      takenAt: null,
      takenVia: null,
    });
  });

  it("sends nothing for a row that records no outcome", () => {
    expect(recordedEventOf({ ...ROW, takenAt: null }, "WEB")).toBeUndefined();
  });

  it("announces an undone dose as reopened, with no take and a neutral text", () => {
    const now = new Date("2026-11-21T09:00:00.000Z");
    const event = reopenedEventOf(ROW, null, now)!;
    expect(event).toEqual({
      medicationId: "med-1",
      intakeId: "evt-1",
      slotInstant: ROW.scheduledFor,
      outcome: "reopened",
      takenAt: null,
      takenVia: null,
    });
    const payload = intakeRecordedPayload(event, "en", AS_OF) as {
      aps: Record<string, unknown> & { alert: { title: string; body: string } };
    } & Record<string, unknown>;
    expect(payload).toMatchObject({
      outcome: "reopened",
      takenAt: null,
      takenVia: null,
      slotInstant: "2026-11-21T07:00:00.000Z",
    });
    expect(payload.aps["interruption-level"]).toBe("passive");
    expect(payload.aps.alert.body).not.toMatch(/notifications\./);
    expect(payload.aps.alert.title).not.toMatch(/notifications\./);
  });

  it("reopens only a slot that was answered and is not any more", () => {
    const now = new Date("2026-11-21T09:00:00.000Z");
    const open = { ...ROW, takenAt: null, skipped: false };
    // Open before: nothing was announced, nothing to undo.
    expect(reopenedEventOf(open, null, now)).toBeUndefined();
    // Still answered after the edit.
    expect(
      reopenedEventOf(ROW, { takenAt: new Date(), skipped: false }, now),
    ).toBeUndefined();
    expect(
      reopenedEventOf(ROW, { takenAt: null, skipped: true }, now),
    ).toBeUndefined();
    // A skip undone reopens too.
    expect(
      reopenedEventOf(
        { ...ROW, takenAt: null, skipped: true },
        { takenAt: null, skipped: false },
        now,
      )?.outcome,
    ).toBe("reopened");
    // Moved to another slot: the old slot is open again.
    expect(
      reopenedEventOf(
        ROW,
        {
          takenAt: ROW.takenAt,
          skipped: false,
          scheduledFor: new Date("2026-11-21T08:00:00.000Z"),
        },
        now,
      )?.slotInstant,
    ).toEqual(ROW.scheduledFor);
    // Past the app's horizon nothing is sent.
    expect(
      reopenedEventOf(
        ROW,
        null,
        new Date(ROW.scheduledFor.getTime() + REOPENED_WINDOW_MS + 1),
      ),
    ).toBeUndefined();
  });
});
