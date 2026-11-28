/**
 * The shared integration card, one test per state the server can publish.
 *
 * Every assertion reads the markup's data attributes or the bundle's own
 * sentence, never a computed state: the card renders `health` and nothing
 * else, so what is checked here is that each `health` lands on the right
 * badge, sentence and (at most one) button.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

let lastCardProps: IntegrationCardProps | null = null;
vi.mock("../integration-card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../integration-card")>();
  return {
    ...actual,
    IntegrationCard: (props: IntegrationCardProps) => {
      lastCardProps = props;
      return createElement(actual.IntegrationCard, props);
    },
  };
});

import type { Locale } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/context";
import type { ConnectionHealth } from "@/lib/integrations/connection-health";

import type { IntegrationCardProps } from "../integration-card";
import {
  OAUTH_INTEGRATIONS,
  OAuthIntegrationCard,
  type OAuthIntegrationKey,
} from "../oauth-integration-card";
import type { IntegrationStatusViewModel } from "../shared";
import { healthFixture } from "./health-fixture";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

// "Last data: today" only holds when the fixture's hours-ago stays on the same
// local day, so the clock is pinned to midday rather than the wall clock.
const PINNED_NOW = new Date("2026-10-08T12:00:00.000Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const NOW = PINNED_NOW.getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function render(
  provider: OAuthIntegrationKey,
  viewModel: Partial<IntegrationStatusViewModel> | undefined,
  locale: Locale = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <OAuthIntegrationCard
        config={OAUTH_INTEGRATIONS[provider]}
        viewModel={
          viewModel
            ? ({
                integration: provider,
                lastError: null,
                ...viewModel,
              } as IntegrationStatusViewModel)
            : undefined
        }
        callbackUrl={`https://app.example/api/${provider}/callback`}
      />
    </I18nProvider>,
  );
}

function connected(health: ConnectionHealth, extra = {}) {
  return {
    connected: true,
    configured: true,
    available: true,
    health,
    ...extra,
  };
}

function badgeState(html: string): string | null {
  return (
    html.match(
      /data-slot="integration-health-badge"[^>]*data-state="(\w+)"/,
    )?.[1] ?? null
  );
}

function primaryActions(html: string): string[] {
  return [
    ...html.matchAll(
      /data-slot="integration-primary-action"[^>]*data-action="(\w+)"/g,
    ),
  ].map((m) => m[1]);
}

describe("<IntegrationCard> per state", () => {
  it("ok: Active, one sentence, last data, no button", () => {
    const html = render(
      "oura",
      connected(healthFixture({ lastDataAt: hoursAgo(1) })),
    );
    expect(html).toMatch(/data-slot="integration-card"[^>]*data-state="ok"/);
    expect(badgeState(html)).toBe("ok");
    expect(html).toContain(">Active<");
    expect(html).toContain("Data is arriving.");
    expect(html).toContain('data-slot="integration-last-data"');
    expect(html).toContain("Last data: today,");
    expect(primaryActions(html)).toEqual([]);
    // Details are always there, collapsed.
    expect(html).toContain('data-slot="integration-details-toggle"');
    expect(html).toMatch(
      /data-slot="integration-details"[^>]*data-state="closed"/,
    );
    expect(html).toMatch(
      /<div[^>]*hidden=""[^>]*data-slot="integration-details"/,
    );
  });

  it("ok while older history loads: the sentence says so", () => {
    const html = render(
      "whoop",
      connected(healthFixture(), { backfillCompleted: false }),
    );
    expect(html).toContain(
      "Data is arriving. Older history is loading in the background.",
    );
  });

  it("history ended short: no longer loading, and says where it ends and why", () => {
    const html = render(
      "google-health",
      connected(healthFixture(), {
        backfillCompleted: true,
        backfillEnded: [
          {
            type: "PULSE",
            endsAt: "2024-05-11T08:00:00.000Z",
            reason: "no_progress",
          },
          {
            type: "WEIGHT",
            endsAt: "2006-10-17T12:00:00.000Z",
            reason: "horizon",
          },
        ],
      }),
    );
    expect(html).not.toContain("Older history is loading");
    expect(html).toContain('data-testid="google-health-history-ends"');
    expect(html).toMatch(
      /data-reason="no_progress"[^>]*>Pulse: imported back to [^<]*2024[^<]*\. Google stopped returning older readings/,
    );
    expect(html).toMatch(
      /data-reason="horizon"[^>]*>Weight: imported back to [^<]*2006[^<]*\. Older readings lie beyond the import limit\./,
    );
  });

  it("limited by plan: the sentence names up to three, counts the rest, no button", () => {
    const html = render(
      "withings",
      connected(
        healthFixture({
          state: "limited",
          reason: "plan_limited",
          unavailable: [
            { item: "spo2", cause: "plan" },
            { item: "vascularAge", cause: "plan" },
            { item: "pulseWaveVelocity", cause: "plan" },
            { item: "vo2Max", cause: "plan" },
            { item: "ecg", cause: "plan" },
          ],
        }),
      ),
    );
    expect(badgeState(html)).toBe("limited");
    expect(html).toContain(">Active<");
    expect(html).toContain(
      "Data is arriving. Your Withings plan does not include SpO2, vascular age, and 3 more.",
    );
    expect(primaryActions(html)).toEqual([]);
    // The full list lives in the details, with the plans page one tap away.
    const details = html.slice(html.indexOf('data-slot="integration-details"'));
    expect(details).toContain("ECG and AFib");
    expect(details).toContain('data-testid="withings-plan-link"');
  });

  it("limited by permission: the sentence names it and offers the one reconnect", () => {
    const html = render(
      "oura",
      connected(
        healthFixture({
          state: "limited",
          reason: "permission_limited",
          action: "reconnect",
          unavailable: [
            { item: "spo2", cause: "permission" },
            { item: "vo2max", cause: "permission" },
          ],
        }),
      ),
    );
    expect(badgeState(html)).toBe("limited");
    expect(html).toContain(
      "Data is arriving. Permission is missing for SpO2 and VO2 max.",
    );
    expect(primaryActions(html)).toEqual(["reconnect"]);
    expect(html).toContain(">Reconnect<");
  });

  it("degraded: Error, dated, reassuring, no button", () => {
    const html = render(
      "withings",
      connected(
        healthFixture({
          state: "degraded",
          reason: "provider_errors",
          since: hoursAgo(2),
        }),
      ),
    );
    expect(badgeState(html)).toBe("degraded");
    expect(html).toContain(">Error<");
    expect(html).toMatch(
      /Withings has not answered reliably since (today|yesterday), [^.]+\. HealthLog keeps trying; nothing to do on your side\./,
    );
    expect(primaryActions(html)).toEqual([]);
  });

  it("action required, reauth: Error and exactly one Reconnect", () => {
    const html = render(
      "google-health",
      connected(
        healthFixture({
          state: "action_required",
          reason: "reauth_required",
          action: "reconnect",
        }),
      ),
    );
    expect(badgeState(html)).toBe("action_required");
    expect(html).toContain(">Error<");
    expect(html).toContain(
      "The Google Health connection has expired. Reconnect to keep data coming.",
    );
    expect(primaryActions(html)).toEqual(["reconnect"]);
    // The re-consent banner it replaces is gone.
    expect(html).not.toContain("google-health-reauth-banner");
  });

  it("action required, paused: exactly one Resume, wired to the resume endpoint", () => {
    const html = render(
      "whoop",
      connected(
        healthFixture({
          state: "action_required",
          reason: "paused_after_errors",
          since: hoursAgo(30),
          action: "resume",
        }),
      ),
    );
    expect(badgeState(html)).toBe("action_required");
    expect(html).toContain("WHOOP is paused after failing since");
    expect(primaryActions(html)).toEqual(["resume"]);
    expect(html).toContain(">Resume<");
    expect(html).toContain('data-testid="whoop-resume-button"');
    expect(html).not.toContain("whoop-parked-banner");
  });

  it("not connected: no badge, one sentence, the BYO form and Connect", () => {
    const html = render("withings", {
      connected: false,
      configured: false,
      health: null,
    });
    expect(html).toMatch(
      /data-slot="integration-card"[^>]*data-state="not_connected"/,
    );
    expect(badgeState(html)).toBeNull();
    // The off chip says "not connected"; no sentence repeats it.
    expect(html).toMatch(/data-slot="status-chip"[^>]*data-tone="off"/);
    expect(html).not.toContain("Not connected.");
    expect(html).toContain('data-testid="withings-setup-guide"');
    expect(html).toContain('data-testid="withings-redirect-guide"');
    expect(html).toContain('id="withings-clientid"');
    // Connecting needs stored credentials first: no greyed-out button, the
    // card says what is missing instead.
    expect(html).not.toContain('data-testid="withings-connect"');
    expect(html).toContain('data-testid="integration-unavailable"');
    expect(html).not.toContain('data-slot="integration-details-toggle"');
  });

  it("loading: paints the card and its header, says nothing about state", () => {
    const html = render("polar", undefined);
    expect(html).toMatch(
      /data-slot="integration-card"[^>]*data-state="loading"/,
    );
    expect(badgeState(html)).toBeNull();
    expect(html).not.toContain("Not connected.");
  });

  it("speaks German with the maintainer's words", () => {
    const html = render(
      "oura",
      connected(
        healthFixture({
          state: "degraded",
          reason: "unexpected_silence",
          since: hoursAgo(50),
        }),
      ),
      "de",
    );
    expect(html).toContain(">Fehler<");
    expect(html).toContain("obwohl Oura sonst täglich liefert.");
    expect(html).toContain("Details für eine Fehlermeldung");
  });
});

describe("<IntegrationCard> menu and actions", () => {
  it("moves sync, full reload, test, data, credentials, guide and disconnect into the menu", () => {
    render("withings", connected(healthFixture()));
    const menu = lastCardProps?.menu ?? [];
    expect(menu.map((i) => i.id)).toEqual([
      "sync",
      "full-sync",
      "test",
      "view-data",
      "credentials",
      "setup-guide",
      "disconnect",
    ]);
    // The heavy and the destructive entries keep their confirmation.
    expect(menu.find((i) => i.id === "full-sync")?.confirm).toBeTruthy();
    const disconnect = menu.find((i) => i.id === "disconnect");
    expect(disconnect?.destructive).toBe(true);
    expect(disconnect?.confirm?.confirmLabel).toBe("Disconnect");
  });

  it("offers no full reload where the provider has none", () => {
    render("strava", connected(healthFixture()));
    expect((lastCardProps?.menu ?? []).map((i) => i.id)).not.toContain(
      "full-sync",
    );
  });

  it("names the menu trigger for screen readers and keeps the 44 px floor", () => {
    const html = render("oura", connected(healthFixture()));
    expect(html).toContain('aria-label="More actions for Oura"');
    const trigger = html.match(
      /<button[^>]*data-slot="integration-menu-trigger"[^>]*>/,
    )?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).toMatch(/\bmin-h-11\b/);
    expect(trigger).toMatch(/\bmin-w-11\b/);
    expect(trigger).toContain('aria-haspopup="menu"');
  });

  it("shows the badge word as readable text, not an icon or a hidden label", () => {
    const html = render(
      "oura",
      connected(healthFixture({ state: "degraded", reason: "no_new_data" })),
    );
    const badge = html.match(
      /<span[^>]*data-slot="integration-health-badge"[^>]*>([\s\S]*?)<\/span>(?=<\/div>)/,
    )?.[1];
    expect(badge).toContain("Error");
    expect(html).not.toMatch(
      /data-slot="integration-health-badge"[^>]*aria-hidden="true"/,
    );
  });
});

describe("<IntegrationCard> details for a bug report", () => {
  it("shows exactly the redacted diagnostics the copy button copies", () => {
    const secret = "Oura error: token=abc.def.ghi for user user-42";
    const html = render(
      "oura",
      connected(
        healthFixture({
          state: "degraded",
          reason: "provider_errors",
          since: "2026-10-14T18:40:00.000Z",
          lastSuccessAt: "2026-10-14T18:12:00.000Z",
          lastDataAt: "2026-10-14T07:55:00.000Z",
          diagnostics: {
            ledgerState: "error_transient",
            failingLegs: ["sleep"],
            failingSince: "2026-10-14T18:40:00.000Z",
            lastAttemptAt: "2026-10-15T09:15:00.000Z",
            verdict: "failing",
            recentCalls: [
              {
                endpoint: "sleep",
                status: "transient",
                at: "2026-10-15T09:15:00.000Z",
                errorCode: "503",
              },
            ],
          },
        }),
        {
          lastError: secret,
          consecutiveFailuresByKind: {
            transient: 2,
            reauth_required: 0,
            persistent: 0,
          },
          failureThreshold: 3,
        },
      ),
    );
    const pre = html.match(
      /<pre[^>]*data-slot="integration-diagnostics"[^>]*>([\s\S]*?)<\/pre>/,
    )?.[1];
    expect(pre).toBeDefined();
    expect(pre).toContain("HealthLog");
    expect(pre).toContain("Oura");
    expect(pre).toContain(
      "State: degraded / provider_errors since 2026-10-14 18:40 UTC",
    );
    expect(pre).toContain("Last sync: 2026-10-14 18:12 UTC");
    expect(pre).toContain("Ledger: error_transient, failing parts: sleep");
    expect(pre).toContain("Failure streak: 2 of 3");
    expect(pre).toMatch(/2026-10-15 09:15 {2}sleep {2}transient +503/);
    // The stored provider message, its token and the account never appear,
    // neither in the block nor anywhere else on the card.
    expect(html).not.toContain("token=abc");
    expect(html).not.toContain("user-42");
    expect(html).not.toContain("Oura error");
  });
});
