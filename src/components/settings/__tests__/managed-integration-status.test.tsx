/**
 * A managed record's connections on the shared integration card: a guardian
 * connects and disconnects the record's OAuth providers, the rest is status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConnectionHealth } from "@/lib/integrations/connection-health";

const NAMED_RECORD = {
  accountId: "record-1",
  recordKind: "managed",
  username: "managed-1",
  displayName: "Managed record" as string | null,
  fullName: null as string | null,
};
let activeRecord = NAMED_RECORD;
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "guardian",
      accountAccess: { active: activeRecord },
    },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

let payload: unknown;
let loading = false;
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: payload,
    isLoading: loading,
    isError: false,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ManagedIntegrationStatus } from "../managed-integration-status";
import { healthFixture } from "../integrations/__tests__/health-fixture";

const KEYS = [
  "withings",
  "whoop",
  "fitbit",
  "nightscout",
  "polar",
  "oura",
  "google-health",
  "strava",
];

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ManagedIntegrationStatus />
    </I18nProvider>,
  );
}

function withHealth(map: Record<string, ConnectionHealth | null>) {
  return {
    recordId: "record-1",
    integrations: KEYS.map((integration) => ({
      integration,
      // The legacy fields still ride the wire; the view must not use them.
      state: "connected",
      lastSuccessAt: null,
      lastAttemptAt: null,
      health: map[integration] ?? null,
    })),
  };
}

describe("<ManagedIntegrationStatus>", () => {
  beforeEach(() => {
    payload = undefined;
    loading = false;
    activeRecord = NAMED_RECORD;
  });

  it("renders one shared card per provider from health, with controls on the OAuth ones", () => {
    payload = withHealth({
      oura: healthFixture({
        state: "action_required",
        reason: "reauth_required",
        action: "reconnect",
      }),
      withings: healthFixture(),
    });
    const html = render();

    expect(html).toContain('data-record-settings-family="integrations"');
    expect(html).toContain(
      'aria-labelledby="managed-integration-status-title"',
    );
    expect(html).toContain('data-record-id="record-1"');
    expect(html.match(/data-slot="integration-card"/g)).toHaveLength(8);
    for (const key of KEYS) {
      expect(html).toContain(`data-testid="managed-integration-${key}"`);
    }
    expect(html).toMatch(
      /data-testid="managed-integration-oura"[\s\S]*?data-slot="integration-health-badge"[^>]*data-state="action_required"/,
    );
    // The reconnect a broken grant asks for, on the card that asks for it.
    expect(html).toContain('data-testid="oura-reconnect-button"');
    // A connected OAuth card carries the disconnect menu, and every OAuth card
    // says whose record it connects for.
    expect(html).toContain('data-testid="withings-menu"');
    expect(html.match(/Connects for Managed record/g)).toHaveLength(6);
    // Each unconnected OAuth provider offers one connect for the record;
    // Fitbit (retired) and Nightscout (no OAuth) stay status only.
    for (const key of ["whoop", "polar", "google-health", "strava"]) {
      expect(html).toContain(
        `data-testid="managed-integration-${key}-connect"`,
      );
    }
    expect(html).not.toContain(
      'data-testid="managed-integration-fitbit-connect"',
    );
    expect(html).not.toContain(
      'data-testid="managed-integration-nightscout-connect"',
    );
    expect(html.match(/>Connect for Managed record</g)).toHaveLength(4);
    // The legacy `state: "connected"` on every row does not make a card
    // connected; only `health` does.
    expect(html.match(/>Not connected\.</g)).toHaveLength(6);
  });

  it("says once where connected data goes, and links the explanation", () => {
    payload = withHealth({});
    const html = render();
    expect(html).toContain('data-slot="managed-integration-target"');
    expect(html).toContain(
      "Services you connect here send their data to Managed record&#x27;s record, not to yours.",
    );
    expect(html).toContain(
      'href="https://docs.healthlog.dev/guides/managed-profiles/#connected-services"',
    );
  });

  it("names a profile without a display name by its username", () => {
    activeRecord = { ...NAMED_RECORD, displayName: null };
    payload = withHealth({});
    const html = render();
    expect(html.match(/Connects for managed-1</g)).toHaveLength(6);
    expect(html.match(/>Connect for managed-1</g)).toHaveLength(6);
    expect(html).not.toMatch(/Connects? for </);
    expect(html).toContain('aria-label="managed-1"');
  });

  it("paints the cards while loading without claiming a state", () => {
    loading = true;
    const html = render();
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(
      'aria-labelledby="managed-integration-status-title"',
    );
    expect(html).not.toContain('data-slot="integration-health-badge"');
    expect(html).not.toContain("Not connected.");
  });
});
