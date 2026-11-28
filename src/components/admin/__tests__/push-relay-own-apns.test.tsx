/**
 * The relay card on a server with an APNs key of its own: it says the key
 * is in use and every push goes directly to Apple, how to use the relay
 * instead, and offers no switch that would change nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import deMessages from "../../../../messages/de.json";
import { I18nProvider } from "@/lib/i18n/context";
import type { AdminPushRelayStatus } from "../use-push-relay";

const relay = vi.hoisted(() => ({
  status: null as AdminPushRelayStatus | null,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("../use-push-relay", () => ({
  usePushRelayStatus: () => ({
    data: relay.status,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSetPushRelay: () => ({ mutate: vi.fn(), isPending: false }),
  useSendPushRelayTest: () => ({ mutate: vi.fn(), isPending: false }),
  useRotatePushRelayKey: () => ({ mutate: vi.fn(), isPending: false }),
  useAdminDiagnosticDevices: () => ({ data: undefined }),
}));

import { PushRelaySection } from "../push-relay-section";

const BASE = {
  allowed: true,
  available: true,
  unavailableReason: null,
  relayHost: "push.healthlog.dev",
  offered: false,
  state: "off",
  since: null,
  reason: null,
  instanceId: null,
  tier: null,
  notice: null,
  lastSuccessAt: null,
  devices: { bound: 0, consented: 0 },
  relayCheck: null,
  termsVersion: "1",
  termsConfirmationNeeded: false,
  unbindsPending: 0,
  unreachableRegistrations: [],
  termsUrl: null,
  privacyUrl: null,
  docsUrl: "https://docs.healthlog.dev/guides/push-relay/",
  ownApnsKey: false,
  summaryState: "off",
  operatorDecision: "undecided",
} satisfies AdminPushRelayStatus;

function render(
  status: Partial<AdminPushRelayStatus>,
  locale: "en" | "de" = "en",
) {
  relay.status = { ...BASE, ...status };
  return renderToStaticMarkup(
    <I18nProvider
      initialLocale={locale}
      initialMessages={locale === "de" ? deMessages : undefined}
    >
      <PushRelaySection />
    </I18nProvider>,
  );
}

describe("<PushRelaySection> with the server's own APNs key", () => {
  it("says pushes go directly to Apple and offers no switch", () => {
    const html = render({
      ownApnsKey: true,
      summaryState: "own_apns_key",
      operatorDecision: "off",
    });
    expect(html).toContain('data-slot="push-relay-own-apns"');
    expect(html).toContain(
      "Pushes go straight to Apple with this server&#x27;s own APNs key; remove the APNS_* variables to use the relay.",
    );
    // The state is the pill, as the server resolved it.
    expect(html).toMatch(
      /<span data-slot="push-relay-status"[^>]*data-state="own_apns_key"[^>]*>.*?Own APNs key<\/span>/,
    );
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("Offer to this server");
  });

  it("says it in German too", () => {
    const html = render(
      { ownApnsKey: true, summaryState: "own_apns_key" },
      "de",
    );
    expect(html).toContain("direkt an Apple");
    expect(html).toContain("APNS_*-Variablen");
    expect(html).toContain("Eigener APNs-Schlüssel");
  });

  it("keeps the switch to leave a relay that was turned on before the key", () => {
    const html = render({
      ownApnsKey: true,
      summaryState: "own_apns_key",
      offered: true,
      state: "ok",
      instanceId: "6f1c2a4e-1b9d-4c3e-8a7f-000000000001",
    });
    expect(html).toContain('data-slot="push-relay-own-apns"');
    expect(html).toContain('role="switch"');
    expect(html).toContain("so the relay carries nothing.");
  });

  it("offers the switch without a key of the server's own", () => {
    const html = render({});
    expect(html).not.toContain('data-slot="push-relay-own-apns"');
    expect(html).toContain('role="switch"');
    expect(html).toMatch(/data-slot="push-relay-status"[^>]*data-state="off"/);
  });
});
