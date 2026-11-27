/**
 * Settings > Notifications > Alerts: one notification kind as a card, visible
 * and explained before any delivery channel exists (so "Lasting change in a
 * vital", off by default, can be found at all), and one switch across every
 * active channel once one does.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Activity } from "lucide-react";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { AlertsNoChannelNote, EventSwitchCard } from "../event-switch-card";

function render(payload: unknown): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.notificationsPreferences(), payload);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <EventSwitchCard
          eventType="MEASUREMENT_ANOMALY"
          anchor="lasting-change"
          icon={Activity}
          isAuthenticated
        />
        <AlertsNoChannelNote isAuthenticated />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const KINDS = ["MEASUREMENT_ANOMALY", "SECURITY_ALERT"];

describe("EventSwitchCard", () => {
  it("names the kind and says once where channels are set up when there is none", () => {
    const html = render({ channels: [], preferences: [], eventTypes: KINDS });
    expect(html).toContain("Lasting change in a vital");
    expect(html).toContain('id="lasting-change"');
    expect(html).toContain('data-slot="event-switch-no-channel"');
    expect(html).toContain('href="/settings/integrations#channels"');
    // Once for the group, never once per card.
    expect(html.split('data-slot="event-switch-no-channel"')).toHaveLength(2);
    // The switch waits: nothing could deliver it.
    expect(html).toMatch(/role="switch"[^>]*disabled/);
  });

  it("reads one switch across the active channels", () => {
    const html = render({
      channels: [
        { id: "c1", enabled: true, globallyEnabled: true },
        { id: "c2", enabled: true, globallyEnabled: true },
      ],
      preferences: [
        { channelId: "c2", eventType: "MEASUREMENT_ANOMALY", enabled: true },
      ],
      eventTypes: KINDS,
      eventDefaults: { MEASUREMENT_ANOMALY: false },
    });
    expect(html).not.toContain('data-slot="event-switch-no-channel"');
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
  });

  it("renders nothing for a kind this account is not offered", () => {
    const html = render({
      channels: [],
      preferences: [],
      eventTypes: ["SECURITY_ALERT"],
    });
    expect(html).not.toContain("event-switch-lasting-change");
  });
});
