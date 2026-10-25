/**
 * Settings → Integrations: one status display per card.
 *
 * v1.4.19 consolidated three and four status surfaces per card into one pill.
 * v1.42.4 replaces the pill with the shared card's badge, rendered from the
 * server's `health`, and removes what had grown back around it: the raw
 * provider error line, the failure counter, the per-provider banners.
 *
 * The tests pin, on the whole section:
 *   1. one badge per connected card, and nothing else that states a status;
 *   2. the stored provider error text never reaches the page;
 *   3. a paused connection offers exactly one Resume;
 *   4. no card paints a divider under its header;
 *   5. every not-connected card links its setup guide.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/integrations",
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

// v1.12.1 — the four cards now read every field off the single
// /api/integrations/status envelope; the per-card /api/<provider>/status
// queries are gone. The test mock only needs the consolidated payload.
let integrationStatusPayload: unknown = null;
function setIntegrationStatus(payload: unknown) {
  integrationStatusPayload = payload;
}

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = Array.isArray(queryKey) ? queryKey.join("/") : "";
    if (key === "integrations/status") {
      return { data: integrationStatusPayload, isLoading: false };
    }
    if (key === "settings/global-services") {
      return {
        data: {
          telegramGlobal: true,
          ntfyGlobal: true,
          webPushGlobal: true,
          apiGlobal: true,
        },
        isLoading: false,
      };
    }
    return { data: null, isLoading: false, refetch: vi.fn() };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { IntegrationsSection } from "../integrations-section";

const CALLBACK_URLS = {
  withings: "https://app.example/api/withings/callback",
  whoop: "https://app.example/api/whoop/callback",
  fitbit: "https://app.example/api/fitbit/callback",
  "google-health": "https://app.example/api/google-health/callback",
  polar: "https://app.example/api/polar/callback",
  oura: "https://app.example/api/oura/callback",
  strava: "https://app.example/api/strava/callback",
};

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <IntegrationsSection callbackUrls={CALLBACK_URLS} />
    </I18nProvider>,
  );
}

/** Count occurrences of a substring in the rendered HTML. */
function count(html: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = html.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

const PROVIDERS = [
  "withings",
  "whoop",
  "fitbit",
  "google-health",
  "polar",
  "oura",
  "strava",
  "nightscout",
] as const;

function health(overrides: Record<string, unknown> = {}) {
  return {
    state: "ok",
    reason: "data_arriving",
    since: null,
    action: null,
    unavailable: [],
    lastSuccessAt: "2026-05-09T18:00:00.000Z",
    lastDataAt: "2026-05-09T17:00:00.000Z",
    diagnostics: {
      ledgerState: "connected",
      failingLegs: [],
      failingSince: null,
      lastAttemptAt: "2026-05-09T18:00:00.000Z",
      verdict: "fresh",
      recentCalls: [],
    },
    ...overrides,
  };
}

function disconnected(integration: string) {
  return {
    integration,
    lastError: null,
    connected: false,
    configured: false,
    available: false,
    health: null,
  };
}

/** The Withings card's markup, up to the next card. */
function withingsCard(html: string): string {
  const start = html.indexOf('data-testid="withings-card"');
  const next = html.indexOf('data-slot="integration-card"', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

/** Withings as given, every other provider present and not connected. */
function envelopeWith(withings: Record<string, unknown>) {
  return {
    threshold: 3,
    integrations: [
      {
        integration: "withings",
        lastError: null,
        connected: true,
        configured: true,
        ...withings,
      },
      ...PROVIDERS.filter((p) => p !== "withings").map(disconnected),
    ],
  };
}

describe("IntegrationsSection — one status display per card", () => {
  beforeEach(() => {
    integrationStatusPayload = null;
  });

  it("renders exactly one badge for the connected card and no other status surface", () => {
    setIntegrationStatus(envelopeWith({ health: health() }));

    const html = render();
    expect(count(html, 'data-slot="integration-health-badge"')).toBe(1);
    expect(html).not.toContain('data-testid="integration-status-pill"');
    expect(html).not.toContain('data-testid="integration-status-banner"');
    expect(html).not.toContain("Last successful sync");
    expect(html).not.toContain("Last attempt");
    // The seven other providers and Apple Health are not connected and say so
    // once each.
    expect(count(html, ">Not connected.<")).toBe(8);
  });

  it("never shows the stored provider error or a failure counter", () => {
    setIntegrationStatus(
      envelopeWith({
        lastError: "Withings refresh error: 503 - upstream",
        consecutiveFailuresByKind: {
          transient: 2,
          reauth_required: 0,
          persistent: 0,
        },
        health: health({
          state: "degraded",
          reason: "provider_errors",
          since: "2026-05-09T08:00:00.000Z",
        }),
      }),
    );

    const html = render();
    expect(html).toMatch(
      /data-slot="integration-health-badge"[^>]*data-state="degraded"/,
    );
    expect(html).not.toContain("Withings refresh error");
    expect(html).not.toContain("2/3 consecutive failures");
    // Not the user's to fix: the Withings card offers no button.
    expect(withingsCard(html)).toContain('data-testid="withings-menu"');
    expect(withingsCard(html)).not.toContain(
      'data-slot="integration-primary-action"',
    );
  });

  it("a paused connection offers exactly one Resume", () => {
    setIntegrationStatus(
      envelopeWith({
        lastError: "Withings activity error: 293",
        health: health({
          state: "action_required",
          reason: "paused_after_errors",
          since: "2026-05-09T18:00:00.000Z",
          action: "resume",
        }),
      }),
    );

    const html = render();
    expect(html).toMatch(
      /data-slot="integration-health-badge"[^>]*data-state="action_required"/,
    );
    expect(html).toContain('data-testid="withings-resume-button"');
    expect(count(html, 'data-action="resume"')).toBe(1);
    expect(html).not.toContain('data-testid="withings-parked-banner"');
    expect(html).not.toContain("Withings activity error: 293");
  });

  it("no integration card paints a divider under its header", () => {
    setIntegrationStatus(envelopeWith({ health: health() }));
    expect(count(render(), 'data-testid="integration-card-divider"')).toBe(0);
  });

  // Every card that is not connected yet carries the same discreet "Setup
  // guide" link to its runbook under the single shared docs base. Once
  // connected, the link moves into the card's menu.
  it("every not-connected integration card carries the shared Setup-guide link", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: PROVIDERS.map(disconnected),
    });

    const html = render();
    expect(count(html, 'data-slot="integration-setup-guide"')).toBe(8);
    for (const provider of PROVIDERS) {
      expect(html).toContain(`data-testid="${provider}-setup-guide"`);
      expect(html).toContain(
        `href="https://docs.healthlog.dev/guides/connect-${provider}/"`,
      );
    }
    // Garmin has no connector; its note goes straight to the section of the
    // Google Health guide that explains the route, not through a redirect.
    expect(html).toContain(
      'href="https://docs.healthlog.dev/guides/connect-google-health/#garmin-owners"',
    );
  });
});
