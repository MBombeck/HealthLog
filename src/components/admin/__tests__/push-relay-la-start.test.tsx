/**
 * The relay card's one line when a medication has Live Activity on and the
 * server cannot start it on one of the admin's iPhones: the state is the
 * diagnostic's `liveActivityStart`, shown as one sentence, and nothing when
 * it is `ready`, null, or the relay is not what delivers.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import deMessages from "../../../../messages/de.json";
import { I18nProvider } from "@/lib/i18n/context";
import type { AdminPushRelayStatus } from "../use-push-relay";

const diag = vi.hoisted(() => ({
  devices: [] as Array<{ liveActivityStart: string | null }>,
  enabledSeen: [] as boolean[],
}));

vi.mock("../use-push-relay", () => ({
  useAdminDiagnosticDevices: ({ enabled }: { enabled: boolean }) => {
    diag.enabledSeen.push(enabled);
    return { data: { devices: diag.devices } };
  },
}));

import { LiveActivityStartLine } from "../push-relay-check";

const BASE = {
  offered: true,
  ownApnsKey: false,
} as unknown as AdminPushRelayStatus;

function render(
  devices: Array<{ liveActivityStart: string | null }>,
  status: Partial<AdminPushRelayStatus> = {},
  locale: "en" | "de" = "en",
) {
  diag.devices = devices;
  return renderToStaticMarkup(
    <I18nProvider
      initialLocale={locale}
      initialMessages={locale === "de" ? deMessages : undefined}
    >
      <LiveActivityStartLine status={{ ...BASE, ...status }} />
    </I18nProvider>,
  );
}

describe("<LiveActivityStartLine>", () => {
  it("names the operator switch", () => {
    const html = render([{ liveActivityStart: "switch_off" }]);
    expect(html).toContain('data-slot="push-relay-la-start"');
    expect(html).toContain("PUSH_RELAY_LIVE_ACTIVITY is off");
  });

  it("names the first device that is held up", () => {
    const html = render([
      { liveActivityStart: "ready" },
      { liveActivityStart: null },
      { liveActivityStart: "no_start_token" },
    ]);
    expect(html).toContain("no start token");
  });

  it("says it in German too", () => {
    const html = render([{ liveActivityStart: "no_consent" }], {}, "de");
    expect(html).toContain("nicht erlaubt");
  });

  it("shows nothing when every device is ready or the question does not arise", () => {
    expect(
      render([{ liveActivityStart: "ready" }, { liveActivityStart: null }]),
    ).toBe("");
  });

  it("does not ask while the server's own APNs key delivers", () => {
    diag.enabledSeen = [];
    expect(
      render([{ liveActivityStart: "switch_off" }], { ownApnsKey: true }),
    ).toBe("");
    expect(diag.enabledSeen).toEqual([false]);
  });
});
