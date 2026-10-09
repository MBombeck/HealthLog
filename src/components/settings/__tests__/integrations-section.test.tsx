/**
 * v1.4.19 Phase A5 — Settings → Integrations status consolidation.
 *
 * The maintainer's verbatim concern (paraphrased):
 *   - Withings card had 3 status displays — top-right "connected"
 *     badge, mid-card "connected / last successful / last attempt"
 *     trio container, and the badge inside that container.
 *   - Mood Log card had 4 — same as Withings PLUS a "letzter Sync"
 *     line at the very bottom.
 *
 * After A5: each card has EXACTLY ONE status display (the pill, top
 * right). Error context (the failure message itself, when actionable)
 * is allowed to surface below the pill since it carries information
 * the pill can't fit. Timestamp repetition is gone.
 *
 * The tests pin:
 *   1. Healthy Withings + Mood Log: ONE pill per card, no banner.
 *   2. Withings transient error: ONE pill per card + error message,
 *      NO redundant "{n}/{threshold} consecutive failures" badge,
 *      NO "Last successful sync / Last attempt" trio.
 *   3. Withings reauth: pill carries the "Error — reconnect" label.
 *   4. Mood Log disconnected: pill says "Not connected", no other
 *      status display surfaces.
 *   5. no card paints a divider under its header
 *      — consistency the maintainer explicitly called out.
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

describe("IntegrationsSection — single-status-display contract (A5)", () => {
  beforeEach(() => {
    integrationStatusPayload = null;
  });

  it("renders exactly ONE status pill per card when both integrations are healthy", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "connected",
          lastSuccessAt: "2026-05-09T18:00:00.000Z",
          lastAttemptAt: "2026-05-09T18:00:00.000Z",
          lastError: null,
          connected: true,
          configured: true,
          legacyLastSyncedAt: "2026-05-09T18:00:00.000Z",
          hasActivityScope: true,
          syncHealth: { verdict: "fresh", since: null },
        },
      ],
    });

    const html = render();
    // Exactly one pill per card → 8 (Withings, WHOOP, Fitbit, Google Health,
    // Polar, Oura, Strava, Nightscout). The Garmin info note carries no pill;
    // the Apple Health card's pill keeps its own testid.
    expect(count(html, 'data-testid="integration-status-pill"')).toBe(8);
    // The redundant banner from v1.4.15 is gone.
    expect(html).not.toContain('data-testid="integration-status-banner"');
    // Card-body "letzter Sync" repetition is gone — no
    // "Last sync:" label outside the pill.
    expect(html).not.toContain("Last sync:");
    // No "Last successful sync" / "Last attempt" trio.
    expect(html).not.toContain("Last successful sync");
    expect(html).not.toContain("Last attempt");
  });

  it("Withings transient error keeps the pill + error text but drops the {n}/{threshold} duplicate badge", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "error_transient",
          lastSuccessAt: "2026-05-09T08:00:00.000Z",
          lastAttemptAt: "2026-05-09T18:00:00.000Z",
          lastError: "Withings refresh error: 503 - upstream",
          connected: true,
          configured: true,
          legacyLastSyncedAt: "2026-05-09T08:00:00.000Z",
          hasActivityScope: true,
          syncHealth: { verdict: "failing", since: "2026-05-09T08:00:00.000Z" },
        },
      ],
    });

    const html = render();
    // A 503 is not the user's to fix, so the pill carries the warning tone —
    // red is reserved for "reconnect actually helps".
    expect(html).toContain('data-state="warning"');
    expect(html).not.toContain('data-state="error"');
    // Actionable error message still surfaces (we kept it because
    // the pill can't fit "Withings refresh error: 503 - upstream").
    expect(html).toContain("Withings refresh error: 503 - upstream");
    // …but the consecutive-failure badge that doubled the pill's
    // signal is gone.
    expect(html).not.toContain("2/3 consecutive failures");
    expect(html).not.toContain("Last successful sync");
    expect(html).not.toContain("Last attempt");
  });

  it("Withings reauth state surfaces 'Error — reconnect' on the pill (the maintainer's wording)", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "error_reauth",
          lastSuccessAt: "2026-05-08T12:00:00.000Z",
          lastAttemptAt: "2026-05-09T18:00:00.000Z",
          lastError: "Withings refresh error: 100 - invalid_grant",
          connected: true,
          configured: true,
          legacyLastSyncedAt: "2026-05-08T12:00:00.000Z",
          tokenExpired: true,
          hasActivityScope: true,
          syncHealth: {
            verdict: "reauth_required",
            since: "2026-05-09T18:00:00.000Z",
          },
        },
      ],
    });

    const html = render();
    expect(html).toContain('data-state="error"');
    // Old "Reconnect required" banner is gone — the pill is now
    // the canonical surface.
    expect(html).not.toContain('data-testid="integration-status-banner"');
  });

  it("disconnected state shows 'Not connected' on the pill, no extra status surfaces", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "disconnected",
          lastSuccessAt: "2026-05-08T10:00:00.000Z",
          lastAttemptAt: "2026-05-08T10:00:00.000Z",
          lastError: null,
          syncHealth: { verdict: "disconnected", since: null },
        },
      ],
    });

    const html = render();
    expect(html).toContain("Not connected");
    expect(html).not.toContain('data-testid="integration-status-banner"');
    // No trailing "letzter Sync" line outside the pill.
    expect(html).not.toContain("Last sync:");
  });

  // v1.4.43 W14 — parked-state surface check.
  // The pill flips to `data-state="parked"` and the resume banner
  // renders with the reconnect CTA. The legacy `error` reconnect text
  // (red) must NOT appear because the user-facing copy is the lighter
  // "Paused: reconnect" string, not "Error — reconnect".
  it("Withings parked state surfaces the parked pill + resume CTA", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "parked",
          lastSuccessAt: "2026-05-08T12:00:00.000Z",
          lastAttemptAt: "2026-05-09T18:00:00.000Z",
          lastError: "Withings activity error: 293",
          connected: true,
          configured: true,
          legacyLastSyncedAt: "2026-05-08T12:00:00.000Z",
          hasActivityScope: true,
          syncHealth: { verdict: "parked", since: "2026-05-09T18:00:00.000Z" },
        },
      ],
    });

    const html = render();
    expect(html).toContain('data-state="parked"');
    expect(html).toContain("Paused");
    expect(html).toContain("Paused: reconnect");
    expect(html).toContain('data-testid="withings-parked-banner"');
    expect(html).toContain('data-testid="withings-resume-button"');
    // The lastError is surfaced under the pill so the operator sees
    // the contract-mismatch reason without opening Audit Log.
    expect(html).toContain("Withings activity error: 293");
  });

  it("no integration card paints a divider under its header", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "connected",
          lastSuccessAt: "2026-05-09T18:00:00.000Z",
          lastAttemptAt: "2026-05-09T18:00:00.000Z",
          lastError: null,
          connected: true,
          configured: true,
          legacyLastSyncedAt: "2026-05-09T18:00:00.000Z",
          hasActivityScope: true,
          syncHealth: { verdict: "fresh", since: null },
        },
      ],
    });

    const html = render();
    // The `<hr>` under the header existed only in `integrations/` — nine
    // cards carrying a rule no other Settings card has. The card's own gap
    // does the separating now, identically here and everywhere else.
    expect(count(html, 'data-testid="integration-card-divider"')).toBe(0);
  });

  // v1.17.1 — every integration card carries the same discreet "Setup guide"
  // doc-link pointing at its runbook under the single shared docs base. The
  // affordance is one family across all six providers.
  it("every integration card carries the shared Setup-guide doc-link", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "connected",
          lastSuccessAt: "2026-05-09T18:00:00.000Z",
          lastAttemptAt: "2026-05-09T18:00:00.000Z",
          lastError: null,
          connected: true,
          configured: true,
          legacyLastSyncedAt: "2026-05-09T18:00:00.000Z",
          hasActivityScope: true,
        },
      ],
    });

    const html = render();
    // One setup-guide link per card → eight providers (the Garmin info note is
    // not an OAuth card and carries its own docs link, not a setup-guide).
    expect(count(html, 'data-slot="integration-setup-guide"')).toBe(8);
    for (const provider of [
      "withings",
      "whoop",
      "fitbit",
      "google-health",
      "polar",
      "oura",
      "strava",
      "nightscout",
    ]) {
      expect(html).toContain(`data-testid="${provider}-setup-guide"`);
      expect(html).toContain(
        `href="https://docs.healthlog.dev/integrations/${provider}"`,
      );
    }
  });
});
