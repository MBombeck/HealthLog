import { describe, expect, it } from "vitest";

import { iosMetadataFor, pickIosMetadata } from "../ios-metadata";

describe("iOS metadata: eventId", () => {
  const metadata = { eventId: "ev1", url: "/seizures?event=ev1" };

  it("passes the seizure cluster's eventId and url through", () => {
    expect(pickIosMetadata(metadata)).toEqual(metadata);
    expect(iosMetadataFor({ metadata }, false)).toEqual(metadata);
  });

  it("drops it for a managed delivery", () => {
    expect(iosMetadataFor({ metadata }, true)).toEqual({});
  });
});

describe("iOS metadata: the dose's slot", () => {
  const metadata = {
    medicationId: "med-1",
    scheduledAt: "2026-11-22T08:00:00.000Z",
    replyMarkup: { inline_keyboard: [] },
    webPushTag: "dose-med-1",
  };

  it("names the slot of a medication reminder, and no channel extras", () => {
    expect(
      iosMetadataFor({ eventType: "MEDICATION_REMINDER", metadata }, false),
    ).toEqual({
      medicationId: "med-1",
      scheduledAt: "2026-11-22T08:00:00.000Z",
      slotInstant: "2026-11-22T08:00:00.000Z",
    });
  });

  it("names none for another event, a reminder without a slot or a managed delivery", () => {
    // `scheduledAt` is the tick time on other events, not a dose's slot.
    expect(
      iosMetadataFor({ eventType: "MOOD_REMINDER", metadata }, false),
    ).not.toHaveProperty("slotInstant");
    // The self-test push runs as a reminder with no dose at all.
    expect(
      iosMetadataFor({ eventType: "MEDICATION_REMINDER", metadata: {} }, false),
    ).toEqual({});
    expect(
      iosMetadataFor({ eventType: "MEDICATION_REMINDER", metadata }, true),
    ).toEqual({});
  });
});
