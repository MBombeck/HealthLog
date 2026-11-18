/**
 * Nothing on the envelope may render nowhere.
 *
 * A provider whose Settings card was removed kept its cron, its ledger row and
 * its block on the status envelope, and lost the only surface that could have
 * shown it dying. It then stopped syncing for a month and no screen anywhere
 * said so — every audit that went looking worked from the cards, so a provider
 * without a card appeared in no cohort at all.
 *
 * The panel's unit of coverage is therefore the envelope entry, not the card.
 * This is the acceptance test in executable form: render the panel with an
 * envelope carrying every integration key, and require that each configured
 * one surfaces either as a bespoke card or as a fallback row.
 *
 * That provider was retired in v1.32.33, so the card-less case no longer has a
 * live instance. It keeps a synthetic one — the fallback row has to be proven
 * working before the next card is dropped, not after.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/integrations",
}));

// The Dawarich card belongs to the opt-in environment module.
let environmentOn = true;
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER", modules: { environment: environmentOn } },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

let envelope: unknown = null;
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = Array.isArray(queryKey) ? queryKey.join("/") : "";
    if (key === "integrations/status") {
      return { data: envelope, isLoading: false };
    }
    return { data: null, isLoading: false, isError: false, refetch: vi.fn() };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ConnectionsPanel } from "../connections-panel";
import { INTEGRATION_DISPLAY_NAMES } from "../integration-fallback-row";
import { healthFixture } from "./health-fixture";

const MONTH_AGO = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

/**
 * A provider the server ships on the envelope that no card on the panel
 * claims. Every provider currently has a card, so the card-less case has to be
 * constructed — which is the point: the row must keep working before the next
 * card is dropped, not after. Deleting this fixture would retire the fallback
 * mechanism's only coverage.
 */
const CARD_LESS_KEY = "example-provider";

function entry(integration: string) {
  return {
    integration,
    lastError: null,
    configured: true,
    connected: true,
    available: true,
    health: healthFixture({
      state: "degraded",
      reason: "sync_stalled",
      since: MONTH_AGO,
      lastDataAt: MONTH_AGO,
    }),
    metricFreshness: [],
  };
}

/** Every key the server can ship, all configured, all a month silent. */
function fullEnvelope() {
  return {
    threshold: 3,
    integrations: Object.keys(INTEGRATION_DISPLAY_NAMES).map(entry),
  };
}

const CALLBACK_URLS = {
  withings: "https://app.example/api/withings/callback",
  whoop: "https://app.example/api/whoop/callback",
  "google-health": "https://app.example/api/google-health/callback",
  polar: "https://app.example/api/polar/callback",
  oura: "https://app.example/api/oura/callback",
  strava: "https://app.example/api/strava/callback",
};

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ConnectionsPanel callbackUrls={CALLBACK_URLS} />
    </I18nProvider>,
  );
}

describe("ConnectionsPanel — every envelope entry surfaces", () => {
  it("renders a card or a fallback row for every configured entry", () => {
    envelope = fullEnvelope();
    const html = render();

    for (const integration of Object.keys(INTEGRATION_DISPLAY_NAMES)) {
      const hasCard = html.includes(`data-testid="${integration}-card"`);
      const hasFallback = html.includes(`data-integration="${integration}"`);
      expect(
        hasCard || hasFallback,
        `${integration} renders nowhere on the connections panel`,
      ).toBe(true);
    }
  });

  it("gives a card-less provider the shared card, read-only, with its server state", () => {
    // The shape the mechanism exists for. With no display name registered the
    // row falls back to the raw key, which is still an honest surface — far
    // better than the provider rendering nowhere at all.
    envelope = {
      threshold: 3,
      integrations: [...fullEnvelope().integrations, entry(CARD_LESS_KEY)],
    };
    const html = render();

    expect(html).toContain('data-testid="integration-fallback-row"');
    expect(html).toContain(`data-integration="${CARD_LESS_KEY}"`);
    expect(html).toContain(CARD_LESS_KEY);
    const row = html.slice(
      html.indexOf('data-testid="integration-fallback-row"'),
    );
    expect(row).toMatch(
      /data-slot="integration-health-badge"[^>]*data-state="degraded"/,
    );
    expect(row).toContain("HealthLog has not synced since");
    // Read-only: no menu and no button for a dropped integration.
    expect(html).not.toContain(`data-testid="${CARD_LESS_KEY}-menu"`);
  });

  it("renders no fallback row when every entry is card-backed", () => {
    // The steady state: nothing unclaimed, so the panel adds no catch-all row.
    envelope = fullEnvelope();
    expect(render()).not.toContain('data-testid="integration-fallback-row"');
  });

  it("shows a stored Dawarich connection read-only while the environment module is off", () => {
    environmentOn = false;
    try {
      envelope = fullEnvelope();
      const html = render();
      expect(html).not.toContain('data-testid="dawarich-card"');
      expect(html).toContain('data-integration="dawarich"');
    } finally {
      environmentOn = true;
    }
  });

  it("renders no fallback row for a card-less provider that is not configured", () => {
    // Absence stays absence: an unconfigured provider is not a problem to
    // report, so the panel says nothing about it.
    envelope = {
      threshold: 3,
      integrations: [
        {
          ...entry(CARD_LESS_KEY),
          configured: false,
          connected: false,
          health: null,
        },
      ],
    };
    expect(render()).not.toContain('data-testid="integration-fallback-row"');
  });
});
