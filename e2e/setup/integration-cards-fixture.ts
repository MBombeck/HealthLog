import type { Page } from "@playwright/test";

/**
 * Settings → Integrations with one card per health state, all mocked.
 *
 * Each provider carries the `health` the server would publish for one
 * situation, so a single page shows every state the shared card can be in:
 *
 *   withings       limited / plan_limited        (no button)
 *   oura           limited / permission_limited  (one Reconnect)
 *   polar          degraded / provider_errors    (no button)
 *   whoop          action_required / paused      (one Resume)
 *   google-health  action_required / reauth      (one Reconnect)
 *   strava         ok / data_arriving            (no button)
 *   nightscout     not connected                 (address form)
 *   apple-health   degraded / no_new_data
 *
 * Timestamps are relative to now, so the sentences read the same on any day.
 */
const HOUR = 60 * 60 * 1000;

function ago(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString();
}

function health(overrides: Record<string, unknown> = {}) {
  return {
    state: "ok",
    reason: "data_arriving",
    since: null,
    action: null,
    unavailable: [],
    lastSuccessAt: ago(1),
    lastDataAt: ago(2),
    diagnostics: {
      ledgerState: "connected",
      failingLegs: [],
      failingSince: null,
      lastAttemptAt: ago(1),
      verdict: "fresh",
      recentCalls: [
        { endpoint: "measures", status: "ok", at: ago(1), errorCode: null },
      ],
    },
    ...overrides,
  };
}

function connected(integration: string, h: Record<string, unknown>) {
  return {
    integration,
    lastError: null,
    connected: true,
    configured: true,
    available: true,
    hasOwnCredentials: true,
    health: h,
    metricFreshness: [
      { type: "WEIGHT", lastSeenAt: ago(2), stale: false },
      { type: "PULSE", lastSeenAt: ago(80), stale: true },
    ],
  };
}

function disconnected(integration: string) {
  return {
    integration,
    lastError: null,
    connected: false,
    configured: false,
    available: true,
    hasOwnCredentials: false,
    health: null,
    metricFreshness: [],
  };
}

export const INTEGRATION_CARD_STATES = {
  withings: { state: "limited", primary: null },
  oura: { state: "limited", primary: "reconnect" },
  polar: { state: "degraded", primary: null },
  whoop: { state: "action_required", primary: "resume" },
  "google-health": { state: "action_required", primary: "reconnect" },
  strava: { state: "ok", primary: null },
  nightscout: { state: "not_connected", primary: "connect" },
  "apple-health": { state: "degraded", primary: null },
} as const;

export function integrationCardsEnvelope() {
  return {
    threshold: 3,
    metricFreshnessDegraded: false,
    integrations: [
      connected(
        "withings",
        health({
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
      {
        ...connected("whoop", {
          ...health({
            state: "action_required",
            reason: "paused_after_errors",
            since: ago(50),
            action: "resume",
            lastDataAt: ago(52),
          }),
          diagnostics: {
            ledgerState: "parked",
            failingLegs: ["recovery", "sleep"],
            failingSince: ago(50),
            lastAttemptAt: ago(3),
            verdict: "parked",
            recentCalls: [
              {
                endpoint: "recovery",
                status: "persistent",
                at: ago(3),
                errorCode: "500",
              },
              {
                endpoint: "sleep",
                status: "persistent",
                at: ago(3),
                errorCode: "500",
              },
            ],
          },
        }),
        consecutiveFailuresByKind: {
          transient: 0,
          reauth_required: 0,
          persistent: 4,
        },
      },
      connected(
        "google-health",
        health({
          state: "action_required",
          reason: "reauth_required",
          action: "reconnect",
          since: ago(30),
          lastDataAt: ago(31),
        }),
      ),
      connected(
        "polar",
        health({
          state: "degraded",
          reason: "provider_errors",
          since: ago(9),
          lastDataAt: ago(20),
          diagnostics: {
            ledgerState: "error_transient",
            failingLegs: ["sleep"],
            failingSince: ago(9),
            lastAttemptAt: ago(1),
            verdict: "failing",
            recentCalls: [
              {
                endpoint: "sleep",
                status: "transient",
                at: ago(1),
                errorCode: "503",
              },
              {
                endpoint: "sleep",
                status: "transient",
                at: ago(2),
                errorCode: "503",
              },
              {
                endpoint: "activity",
                status: "ok",
                at: ago(2),
                errorCode: null,
              },
            ],
          },
        }),
      ),
      connected(
        "oura",
        health({
          state: "limited",
          reason: "permission_limited",
          action: "reconnect",
          unavailable: [
            { item: "spo2", cause: "permission" },
            { item: "vo2max", cause: "permission" },
          ],
        }),
      ),
      connected("strava", health()),
      { ...disconnected("nightscout"), hasToken: false },
    ],
  };
}

export function appleHealthStatus() {
  return {
    entries: [],
    lastSyncedAt: ago(60),
    lastSyncTrigger: "foreground",
    lastBackgroundSyncAt: null,
    metricFreshness: [],
    syncProgress: { recordsAccepted: 48211, oldestMeasuredAt: ago(24 * 900) },
    health: health({
      state: "degraded",
      reason: "no_new_data",
      since: ago(60),
      lastDataAt: ago(60),
    }),
  };
}

/** Route every read the Integrations page makes onto the fixture. */
export async function mockIntegrationCards(page: Page): Promise<void> {
  await page.route("**/api/integrations/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: integrationCardsEnvelope(), error: null }),
    }),
  );
  await page.route("**/api/integrations/healthkit", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: appleHealthStatus(), error: null }),
    }),
  );
}
