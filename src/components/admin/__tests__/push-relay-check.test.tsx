/**
 * What the relay itself says, on the relay card: the reason of a state the
 * admin can read, the relay's notice, and the hourly status check with this
 * instance's bindings at the relay.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import deMessages from "../../../../messages/de.json";
import { I18nProvider } from "@/lib/i18n/context";
import { PushRelayCheck } from "../push-relay-check";
import type { AdminPushRelayStatus } from "../use-push-relay";

const BASE = {
  offered: true,
  instanceId: "6f1c2a4e-1b9d-4c3e-8a7f-000000000001",
  state: "ok",
  reason: null,
  notice: null,
  relayCheck: null,
} as unknown as AdminPushRelayStatus;

function render(
  status: Partial<AdminPushRelayStatus>,
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider
      initialLocale={locale}
      initialMessages={locale === "de" ? deMessages : undefined}
    >
      <PushRelayCheck status={{ ...BASE, ...status }} />
    </I18nProvider>,
  );
}

describe("<PushRelayCheck>", () => {
  it("says the relay refuses this server's signature", () => {
    const html = render({ state: "degraded", reason: "bad_signature" });
    expect(html).toContain("does not accept this server&#x27;s signature");
    expect(
      render({ state: "degraded", reason: "bad_signature" }, "de"),
    ).toContain("nimmt die Signatur dieses Servers nicht an");
  });

  it("names what the relay reports about itself", () => {
    expect(
      render({ state: "degraded", reason: "relay_maintenance" }),
    ).toContain("The relay is in maintenance.");
    // A reason without words of its own stays with the state badge.
    expect(render({ state: "degraded", reason: "paused" })).toBe("");
    // An ok state shows no reason line.
    expect(render({ state: "ok", reason: "bad_signature" })).toBe("");
  });

  it("shows the relay's notice with its level", () => {
    expect(
      render({ notice: { id: "planned_maintenance", level: "planned" } }),
    ).toContain("Notice from the relay (planned): planned_maintenance");
  });

  it("shows the last status check and the bindings at the relay", () => {
    const html = render({
      relayCheck: {
        checkedAt: "2026-11-22T12:00:00.000Z",
        answeredAt: "2026-11-22T12:00:00.000Z",
        state: "ok",
        devices: { active: 3, provisional: 1, limit: 50 },
      },
    });
    expect(html).toContain("running normally");
    expect(html).toContain(
      "At the relay: 3 active and 1 new bindings, limit 50.",
    );
    expect(
      render({
        relayCheck: {
          checkedAt: "2026-11-22T12:00:00.000Z",
          answeredAt: null,
          state: null,
          devices: null,
        },
      }),
    ).toContain("no answer yet");
  });

  it("stays hidden for an instance that is not registered", () => {
    expect(
      render({
        instanceId: null,
        state: "degraded",
        reason: "bad_signature",
      }),
    ).toBe("");
  });
});
