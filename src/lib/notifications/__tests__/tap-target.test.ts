/**
 * The event → tap-target map and its resolver.
 *
 * Walks the sent event types rather than the map's own keys, so an event type
 * added to the union without a decision about where it leads fails here (the
 * `Record<SentEventType, …>` type already refuses to compile without one; this
 * pins that every entry is also a usable path).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn().mockResolvedValue({ locale: "en" }) },
  },
}));

import { withDeliveryLinks } from "@/lib/notifications/delivery-links";
import { buildNtfyMessage } from "@/lib/notifications/senders/ntfy";
import { buildWebhookBody } from "@/lib/notifications/senders/webhook";
import {
  EVENT_TYPES,
  UNSENT_EVENT_TYPES,
  isSentEventType,
  type EventType,
  type NotificationPayload,
} from "@/lib/notifications/types";
import {
  NEUTRAL_TAP_PATH,
  NOTIFICATION_TAP_PATHS,
  absoluteAppUrl,
  configuredAppOrigin,
  isSafeAppPath,
  resolveTapPath,
  telegramLinkMode,
} from "@/lib/notifications/tap-target";

/** Events never shown to the user, so they carry no target. */
const SILENT: ReadonlySet<EventType> = new Set(["MEDICATION_INTAKE_SYNC"]);

const SENT = EVENT_TYPES.filter(isSentEventType);

const ORIGINAL = {
  APP_URL: process.env.APP_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("NOTIFICATION_TAP_PATHS", () => {
  it("names a target for every sent event type", () => {
    expect(SENT.length).toBeGreaterThan(0);
    for (const eventType of SENT) {
      expect(
        Object.prototype.hasOwnProperty.call(NOTIFICATION_TAP_PATHS, eventType),
        `${eventType} has no tap target`,
      ).toBe(true);
      const path = NOTIFICATION_TAP_PATHS[eventType];
      if (SILENT.has(eventType)) {
        expect(path, `${eventType} is silent`).toBeNull();
      } else {
        expect(isSafeAppPath(path), `${eventType} → ${path}`).toBe(true);
        expect(resolveTapPath({ eventType }), eventType).toBe(path);
      }
    }
  });

  it("keeps the targets the issue names", () => {
    expect(NOTIFICATION_TAP_PATHS.MOOD_REMINDER).toBe("/mood?add=1");
    expect(NOTIFICATION_TAP_PATHS.DAILY_BRIEFING).toBe("/");
    expect(NOTIFICATION_TAP_PATHS.MEDICATION_REMINDER).toBe("/medications");
  });

  it("has no entry for an event type outside the sent set", () => {
    expect(Object.keys(NOTIFICATION_TAP_PATHS).sort()).toEqual(
      [...SENT].sort(),
    );
  });

  it("gives an event nothing sends no target", () => {
    for (const eventType of UNSENT_EVENT_TYPES) {
      expect(resolveTapPath({ eventType }), eventType).toBeNull();
    }
  });
});

describe("resolveTapPath", () => {
  it("takes a producer's same-origin path over the default", () => {
    expect(
      resolveTapPath({
        eventType: "MEDICATION_LOW_STOCK",
        metadata: { url: "/medications/m1?tab=bestand" },
      }),
    ).toBe("/medications/m1?tab=bestand");
  });

  it.each([
    "https://evil.example/",
    "//evil.example/x",
    "/\\evil.example",
    "javascript:alert(1)",
    "/a b",
    "",
    42,
  ])("ignores an unsafe override %j", (url) => {
    expect(
      resolveTapPath({ eventType: "COACH_NUDGE", metadata: { url } }),
    ).toBe("/coach");
  });

  it("gives a managed Guardian delivery the app root, not the event's path", () => {
    expect(
      resolveTapPath({
        eventType: "MEDICATION_REMINDER",
        recordUserId: "record-1",
        recipientUserId: "guardian-1",
        metadata: { url: "/medications/m1" },
      }),
    ).toBe(NEUTRAL_TAP_PATH);
  });

  it("keeps a self delivery's path when both ids are the same", () => {
    expect(
      resolveTapPath({
        eventType: "MEDICATION_REMINDER",
        recordUserId: "u1",
        recipientUserId: "u1",
      }),
    ).toBe("/medications");
  });

  it("gives a discreet delivery the app root, so nothing names the cycle surface", () => {
    expect(
      resolveTapPath({
        eventType: "CYCLE_PERIOD_SOON",
        discreet: true,
        metadata: { url: "/cycle?day=1" },
      }),
    ).toBe(NEUTRAL_TAP_PATH);
  });

  it("gives the silent sync push no path even with an override", () => {
    expect(
      resolveTapPath({
        eventType: "MEDICATION_INTAKE_SYNC",
        metadata: { url: "/medications" },
      }),
    ).toBeNull();
  });
});

describe("configuredAppOrigin / absoluteAppUrl", () => {
  it("prefers APP_URL, then NEXT_PUBLIC_APP_URL, and keeps only the origin", () => {
    process.env.APP_URL = "https://health.example/some/path";
    process.env.NEXT_PUBLIC_APP_URL = "https://other.example";
    expect(configuredAppOrigin()).toBe("https://health.example");
    delete process.env.APP_URL;
    expect(configuredAppOrigin()).toBe("https://other.example");
  });

  it("returns null without a usable origin, and so no absolute URL", () => {
    delete process.env.APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    expect(configuredAppOrigin()).toBeNull();
    expect(absoluteAppUrl("/mood?add=1")).toBeNull();
  });

  it("joins origin and path", () => {
    expect(absoluteAppUrl("/mood?add=1", "https://h.example")).toBe(
      "https://h.example/mood?add=1",
    );
    expect(absoluteAppUrl(null, "https://h.example")).toBeNull();
  });
});

describe("telegramLinkMode", () => {
  it.each([
    ["https://health.example/", "button"],
    ["http://nas.lan:3000/", "text"],
    ["https://localhost:3000/", "none"],
    ["http://127.0.0.1/", "none"],
    ["https://app.localhost/", "none"],
    ["ftp://health.example/", "none"],
    ["nonsense", "none"],
  ])("%s → %s", (url, mode) => {
    expect(telegramLinkMode(url)).toBe(mode);
  });
});

/**
 * Every visible delivery carries a target on every channel: each event type,
 * delivered to its own account, to a Guardian of a managed record, and in
 * discreet mode. Only the silent sync push carries none. The channels that
 * take the absolute URL are checked through their pure builders; APNs and Web
 * Push take the path and are pinned in their own sender tests.
 */
describe("tap target on every kind and channel", () => {
  const variants: Array<{
    name: string;
    extra: Pick<
      Partial<NotificationPayload>,
      "recordUserId" | "recipientUserId" | "discreet"
    >;
    neutral: boolean;
  }> = [
    { name: "own account", extra: {}, neutral: false },
    {
      name: "managed Guardian",
      extra: { recordUserId: "record-1", recipientUserId: "guardian-1" },
      neutral: true,
    },
    { name: "discreet", extra: { discreet: true }, neutral: true },
  ];

  it.each(variants)("$name", async ({ extra, neutral }) => {
    process.env.APP_URL = "https://health.example";
    let checked = 0;
    for (const eventType of SENT) {
      const payload = await withDeliveryLinks(
        { userId: "u1", title: "t", message: "m", eventType, ...extra },
        "guardian-1",
      );
      if (SILENT.has(eventType)) {
        expect(payload.tap, `${eventType} is silent`).toBeUndefined();
        continue;
      }
      const expectedPath = neutral
        ? NEUTRAL_TAP_PATH
        : NOTIFICATION_TAP_PATHS[eventType];
      expect(payload.tap?.path, eventType).toBe(expectedPath);
      const url = `https://health.example${expectedPath}`;
      expect(payload.tap?.url, eventType).toBe(url);

      expect(
        buildNtfyMessage("topic", payload).click,
        `ntfy ${eventType}`,
      ).toBe(url);
      expect(
        JSON.parse(buildWebhookBody({ format: "generic" }, payload)).url,
        `webhook ${eventType}`,
      ).toBe(url);
      expect(
        JSON.parse(buildWebhookBody({ format: "gotify" }, payload)).extras[
          "client::notification"
        ].click.url,
        `gotify ${eventType}`,
      ).toBe(url);
      checked += 1;
    }
    expect(checked).toBe(SENT.length - SILENT.size);
  });
});
