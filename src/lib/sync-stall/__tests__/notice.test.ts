import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  NOTICE_EARLIEST_HOUR,
  NOTICE_LATEST_HOUR,
  inNoticeWindow,
  quietSinceWording,
  renderStallNotice,
  stallTapUrl,
} from "../notice";

const BERLIN = "Europe/Berlin";

describe("the notice's daytime window", () => {
  it("never sends at night, in the person's own zone", () => {
    // 07:30 UTC is 08:30 in Berlin in winter: still quiet hours.
    expect(inNoticeWindow(new Date("2026-11-20T07:30:00Z"), BERLIN)).toBe(
      false,
    );
    // 08:00 UTC is 09:00 in Berlin: the first hour a notice may go out in.
    expect(inNoticeWindow(new Date("2026-11-20T08:00:00Z"), BERLIN)).toBe(true);
    expect(inNoticeWindow(new Date("2026-11-20T18:59:00Z"), BERLIN)).toBe(true);
    // 19:00 UTC is 20:00 in Berlin: quiet again until the morning.
    expect(inNoticeWindow(new Date("2026-11-20T19:00:00Z"), BERLIN)).toBe(
      false,
    );
    expect(inNoticeWindow(new Date("2026-11-20T02:00:00Z"), BERLIN)).toBe(
      false,
    );
    // The same instant is daytime somewhere else.
    expect(inNoticeWindow(new Date("2026-11-20T02:00:00Z"), "Asia/Tokyo")).toBe(
      true,
    );
    expect(NOTICE_EARLIEST_HOUR).toBeLessThan(NOTICE_LATEST_HOUR);
  });

  it("follows the local clock across both DST changes", () => {
    // 2026-03-29, Berlin springs forward at 02:00: 07:00 UTC is 09:00 CEST.
    expect(inNoticeWindow(new Date("2026-03-29T07:00:00Z"), BERLIN)).toBe(true);
    expect(inNoticeWindow(new Date("2026-03-29T06:59:00Z"), BERLIN)).toBe(
      false,
    );
    // 2026-10-25, Berlin falls back at 03:00: 08:00 UTC is 09:00 CET.
    expect(inNoticeWindow(new Date("2026-10-25T08:00:00Z"), BERLIN)).toBe(true);
    expect(inNoticeWindow(new Date("2026-10-25T07:59:00Z"), BERLIN)).toBe(
      false,
    );
  });
});

describe("how the notice names the start of the quiet", () => {
  it("says yesterday for the previous local day, a date before that", () => {
    const now = new Date("2026-11-20T09:00:00Z");
    expect(
      quietSinceWording(new Date("2026-11-19T08:00:00Z"), now, BERLIN),
    ).toBe("yesterday");
    // 23:30 on the 18th in Berlin: two local days back, a date.
    expect(
      quietSinceWording(new Date("2026-11-18T22:30:00Z"), now, BERLIN),
    ).toBe("date");
    // 00:30 on the 19th in Berlin, though still the 18th in UTC: yesterday.
    expect(
      quietSinceWording(new Date("2026-11-18T23:30:00Z"), now, BERLIN),
    ).toBe("yesterday");
  });

  it("reads local days, so the night of a DST change is still yesterday", () => {
    // Last delivery 23:30 CET on 28 March; the clock springs forward that
    // night. The next morning, 10:00 CEST, is 22.5 hours later.
    const since = new Date("2026-03-28T22:30:00Z");
    const now = new Date("2026-03-29T08:00:00Z");
    expect(quietSinceWording(since, now, BERLIN)).toBe("yesterday");
    // Two local days back is a date.
    expect(
      quietSinceWording(new Date("2026-03-27T10:00:00Z"), now, BERLIN),
    ).toBe("date");
  });
});

describe("renderStallNotice", () => {
  const now = new Date("2026-11-20T09:00:00Z");

  it("asks an iPhone owner to open HealthLog once", () => {
    const text = renderStallNotice(
      { source: "apple-health", since: new Date("2026-11-19T08:00:00Z") },
      now,
      BERLIN,
      "en",
    );
    expect(text.message).toBe(
      "Apple Health has sent nothing since yesterday. Opening HealthLog once is enough.",
    );
    expect(text.title).toContain("Apple Health");
  });

  it("names the date of a longer quiet, and the source by its brand", () => {
    const text = renderStallNotice(
      { source: "garmin", since: new Date("2026-11-16T08:00:00Z") },
      now,
      BERLIN,
      "de",
    );
    expect(text.message).toMatch(/^Garmin hat seit 16\. Nov/);
    expect(text.message).toContain("Garmin in HealthLog neu");
  });

  it("opens the source's own card", () => {
    expect(stallTapUrl("apple-health")).toBe(
      "/settings/integrations#apple-health",
    );
    expect(stallTapUrl("oura")).toBe("/settings/integrations#oura");
  });
});

describe("the notice on the wire to the iPhone app", () => {
  it("carries the source key, never the url, a device name or an instant", async () => {
    const { alertMessage } = await import("@/lib/push-relay/apns-channel");
    const { pickIosMetadata } =
      await import("@/lib/notifications/senders/ios-metadata");
    const metadata = {
      source: "apple-health",
      url: stallTapUrl("apple-health"),
    };
    const sealed = alertMessage({
      title: "T",
      message: "M",
      eventType: "SYNC_STALLED",
      metadata,
    });
    expect(sealed.type).toBe("SYNC_STALLED");
    expect(sealed.pushClass).toBe("alert");
    expect(sealed.data).toEqual({ source: "apple-health" });
    expect(pickIosMetadata(metadata)).toEqual(metadata);
    // Anything but a connection key is dropped.
    expect(pickIosMetadata({ source: "My iPhone 15" })).toEqual({});
    expect(pickIosMetadata({ source: 3 })).toEqual({});
  });
});
