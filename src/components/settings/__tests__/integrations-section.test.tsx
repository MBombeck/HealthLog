/**
 * v1.4.19 Phase A5 — Settings → Integrations status consolidation.
 *
 * the maintainer's verbatim concern (paraphrased):
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
 *   5. Mood Log card has the visual divider that Withings always had
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

let integrationStatusPayload: unknown = null;
let withingsStatusPayload: unknown = { connected: false, configured: false };
let moodLogStatusPayload: unknown = {
  configured: false,
  enabled: false,
  lastSyncedAt: null,
  entryCount: 0,
  webhookSecret: null,
};
function setIntegrationStatus(payload: unknown) {
  integrationStatusPayload = payload;
}
function setWithingsStatus(payload: unknown) {
  withingsStatusPayload = payload;
}
function setMoodLogStatus(payload: unknown) {
  moodLogStatusPayload = payload;
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
          moodLogGlobal: true,
        },
        isLoading: false,
      };
    }
    if (key === "withings/status") {
      return { data: withingsStatusPayload, isLoading: false };
    }
    if (key === "moodlog-status") {
      return {
        data: moodLogStatusPayload,
        isLoading: false,
        refetch: vi.fn(),
      };
    }
    return { data: null, isLoading: false, refetch: vi.fn() };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { IntegrationsSection } from "../integrations-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <IntegrationsSection />
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
    withingsStatusPayload = { connected: false, configured: false };
    moodLogStatusPayload = {
      configured: false,
      enabled: false,
      lastSyncedAt: null,
      entryCount: 0,
      webhookSecret: null,
    };
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
          consecutiveFailures: 0,
        },
        {
          integration: "moodlog",
          state: "connected",
          lastSuccessAt: "2026-05-09T17:00:00.000Z",
          lastAttemptAt: "2026-05-09T17:00:00.000Z",
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
    });
    setWithingsStatus({
      connected: true,
      configured: true,
      lastSyncedAt: "2026-05-09T18:00:00.000Z",
    });
    setMoodLogStatus({
      configured: true,
      enabled: true,
      lastSyncedAt: "2026-05-09T17:00:00.000Z",
      entryCount: 42,
      webhookSecret: "secret123",
    });

    const html = render();
    // Exactly one pill per card → 2 pills total.
    expect(count(html, 'data-testid="integration-status-pill"')).toBe(2);
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
          consecutiveFailures: 2,
        },
        {
          integration: "moodlog",
          state: "connected",
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
    });
    setWithingsStatus({
      connected: true,
      configured: true,
      lastSyncedAt: "2026-05-09T08:00:00.000Z",
    });

    const html = render();
    // Pill carries the "Error — reconnect" copy via the pill's
    // `data-state="error"` marker.
    expect(html).toContain('data-state="error"');
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
          consecutiveFailures: 1,
        },
        {
          integration: "moodlog",
          state: "connected",
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
    });
    setWithingsStatus({
      connected: true,
      configured: true,
      lastSyncedAt: "2026-05-08T12:00:00.000Z",
      tokenExpired: true,
    });

    const html = render();
    expect(html).toContain('data-state="error"');
    // Old "Reconnect required" banner is gone — the pill is now
    // the canonical surface.
    expect(html).not.toContain('data-testid="integration-status-banner"');
  });

  it("Mood Log disconnected state shows 'Not connected' on the pill, no extra status surfaces", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "connected",
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
          consecutiveFailures: 0,
        },
        {
          integration: "moodlog",
          state: "disconnected",
          lastSuccessAt: "2026-05-08T10:00:00.000Z",
          lastAttemptAt: "2026-05-08T10:00:00.000Z",
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
    });

    const html = render();
    expect(html).toContain("Not connected");
    expect(html).not.toContain('data-testid="integration-status-banner"');
    // Mood Log card no longer has a trailing "letzter Sync" line.
    expect(html).not.toContain("Last sync:");
  });

  // v1.4.43 W14 — parked-state surface check.
  // The pill flips to `data-state="parked"` and the resume banner
  // renders with the reconnect CTA. The legacy `error` reconnect text
  // (red) must NOT appear because the user-facing copy is the lighter
  // "Paused — reconnect manually" string, not "Error — reconnect".
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
          consecutiveFailures: 30,
        },
        {
          integration: "moodlog",
          state: "connected",
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
    });
    setWithingsStatus({
      connected: true,
      configured: true,
      lastSyncedAt: "2026-05-08T12:00:00.000Z",
    });

    const html = render();
    expect(html).toContain('data-state="parked"');
    expect(html).toContain("Paused");
    expect(html).toContain("reconnect manually");
    expect(html).toContain('data-testid="withings-parked-banner"');
    expect(html).toContain('data-testid="withings-resume-button"');
    // The lastError is surfaced under the pill so the operator sees
    // the contract-mismatch reason without opening Audit Log.
    expect(html).toContain("Withings activity error: 293");
  });

  it("Mood Log card carries the visual divider Withings has (consistency)", () => {
    setIntegrationStatus({
      threshold: 3,
      integrations: [
        {
          integration: "withings",
          state: "connected",
          lastSuccessAt: "2026-05-09T18:00:00.000Z",
          lastAttemptAt: "2026-05-09T18:00:00.000Z",
          lastError: null,
          consecutiveFailures: 0,
        },
        {
          integration: "moodlog",
          state: "connected",
          lastSuccessAt: "2026-05-09T17:00:00.000Z",
          lastAttemptAt: "2026-05-09T17:00:00.000Z",
          lastError: null,
          consecutiveFailures: 0,
        },
      ],
    });
    setWithingsStatus({
      connected: true,
      configured: true,
      lastSyncedAt: "2026-05-09T18:00:00.000Z",
    });
    setMoodLogStatus({
      configured: true,
      enabled: true,
      lastSyncedAt: "2026-05-09T17:00:00.000Z",
      entryCount: 42,
      webhookSecret: "secret123",
    });

    const html = render();
    // Both cards include the section divider data-testid so the
    // header → body separation is visually consistent.
    expect(count(html, 'data-testid="integration-card-divider"')).toBe(2);
  });
});
