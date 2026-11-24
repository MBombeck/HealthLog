/**
 * The stall notice (`SYNC_STALLED`) is an alert the app raises on its own, so
 * it lives in Settings > Notifications > Alerts, is on by default, and is
 * switchable there and per channel in the matrix like every other kind.
 *
 * Read off the section's source rather than a render: the guard is about
 * which group the card sits in, and a render of the whole section would need
 * every card's data.
 */
import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";
import { allMessages, resolveKey } from "@/lib/i18n/shared-resolve";
import {
  eventDescriptionTranslationKey,
  eventTranslationKey,
} from "@/lib/notifications/event-labels";
import { preferenceCellEnabled } from "@/lib/notifications/event-default-rule";
import { NOTIFICATION_TAP_PATHS } from "@/lib/notifications/tap-target";
import {
  ADMIN_ONLY_EVENT_TYPES,
  EVENT_DEFAULT_ENABLED,
  eventTypesForRole,
} from "@/lib/notifications/types";
import { SYNC_STALLED_EVENT } from "@/lib/sync-stall/notice";

import { readSource } from "./helpers/source-files";

const ALERTS_HEADING = 't("settings.sections.notifications.alerts.heading")';
const SECTION = readSource(
  "src/components/settings/notifications-section.tsx",
  [ALERTS_HEADING, "<EventSwitchCard"],
);

/** The JSX of the `<section>` whose heading is the Alerts heading. */
function alertsGroup(): string {
  const heading = SECTION.indexOf(ALERTS_HEADING);
  expect(heading).toBeGreaterThan(0);
  const start = SECTION.lastIndexOf("<section", heading);
  const end = SECTION.indexOf("</section>", heading);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(heading);
  return SECTION.slice(start, end);
}

describe("SYNC_STALLED", () => {
  it("sits in the Alerts group as a switch card", () => {
    const group = alertsGroup();
    const card = group.match(
      /<EventSwitchCard[^>]*eventType="SYNC_STALLED"[^>]*\/>/,
    );
    expect(
      card,
      "no EventSwitchCard for SYNC_STALLED in Alerts",
    ).not.toBeNull();
    expect(card![0]).toMatch(/anchor="sync-stalled"/);
    // Once, nowhere else on the page.
    expect(SECTION.split('eventType="SYNC_STALLED"')).toHaveLength(2);
  });

  it("is on by default, offered to everyone, and switchable per channel", () => {
    expect(SYNC_STALLED_EVENT).toBe("SYNC_STALLED");
    expect(EVENT_DEFAULT_ENABLED.SYNC_STALLED).toBe(true);
    expect(ADMIN_ONLY_EVENT_TYPES).not.toContain("SYNC_STALLED");
    expect(eventTypesForRole("USER")).toContain("SYNC_STALLED");
    expect(NOTIFICATION_TAP_PATHS.SYNC_STALLED).toBe("/settings/integrations");

    const payload = {
      channels: [{ id: "c1", enabled: true, globallyEnabled: true }],
      preferences: [] as Array<{
        channelId: string;
        eventType: string;
        enabled: boolean;
      }>,
      eventTypes: eventTypesForRole("USER"),
      eventDefaults: { ...EVENT_DEFAULT_ENABLED },
    };
    // No row yet: the default, on.
    expect(preferenceCellEnabled(payload, "c1", "SYNC_STALLED")).toBe(true);
    // A row the switch wrote: off.
    payload.preferences.push({
      channelId: "c1",
      eventType: "SYNC_STALLED",
      enabled: false,
    });
    expect(preferenceCellEnabled(payload, "c1", "SYNC_STALLED")).toBe(false);
  });

  it("has its name, description and notice copy in every locale", () => {
    const keys = [
      eventTranslationKey("SYNC_STALLED"),
      eventDescriptionTranslationKey("SYNC_STALLED"),
      "notifications.syncStalled.title",
      "notifications.syncStalled.appleYesterday",
      "notifications.syncStalled.appleSince",
      "notifications.syncStalled.sourceYesterday",
      "notifications.syncStalled.sourceSince",
    ];
    for (const locale of locales) {
      for (const key of keys) {
        expect(
          typeof resolveKey(allMessages[locale], key),
          `${locale}: ${key}`,
        ).toBe("string");
      }
    }
  });
});
