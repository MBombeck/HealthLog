/**
 * The visible "dose recorded elsewhere" confirmation is a wire contract with
 * the iOS Notification Service Extension: field names, the quiet alert shape,
 * and no medication name in clear text.
 */
import { describe, expect, it } from "vitest";

import {
  intakeRecordedPayload,
  recordedEventOf,
} from "../medication-intake-recorded";

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
    const payload = intakeRecordedPayload(event, "en") as {
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
    });
    expect(payload.aps.alert.title.length).toBeGreaterThan(0);
    expect(payload.aps.alert.body).not.toMatch(/notifications\./);
  });

  it("names a skip as a skip, with no take time and no origin", () => {
    const event = recordedEventOf(
      { ...ROW, takenAt: null, skipped: true },
      "TELEGRAM",
    )!;
    const payload = intakeRecordedPayload(event, "de");
    expect(payload).toMatchObject({
      outcome: "skipped",
      takenAt: null,
      takenVia: null,
    });
  });

  it("sends nothing for a row that records no outcome", () => {
    expect(recordedEventOf({ ...ROW, takenAt: null }, "WEB")).toBeUndefined();
  });
});
