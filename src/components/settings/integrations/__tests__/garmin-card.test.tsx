/**
 * Garmin on the shared integration card.
 *
 *   1. Not connected: the key form, the link to Garmin Connect's key page,
 *      the validity choice and Connect, inside the shared card.
 *   2. Connected: the same menu as Nightscout, a refused key opens the form,
 *      and disconnect asks first and invalidates the envelope.
 *   3. The key's end: a sentence in the body while it is close, past or
 *      unknown, and the date in the details while it is comfortably valid.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { queryKeys } from "@/lib/query-keys";

const invalidateSpy = vi.fn();
const capturedDisconnectOnSuccess: { fn: (() => void) | null } = { fn: null };

vi.mock("@tanstack/react-query", () => ({
  useMutation: ({ onSuccess }: { onSuccess?: () => void }) => {
    capturedDisconnectOnSuccess.fn = onSuccess ?? null;
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
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

import { I18nProvider } from "@/lib/i18n/context";
import type { GarminKeyExpiry } from "@/lib/garmin/key-expiry";
import type { IntegrationCardProps } from "../integration-card";
import { GarminCard, GARMIN_KEY_SETTINGS_URL } from "../garmin-card";
import type { IntegrationStatusViewModel } from "../shared";
import { healthFixture } from "./health-fixture";

function render(viewModel?: Partial<IntegrationStatusViewModel>) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <GarminCard
        viewModel={
          viewModel
            ? ({
                integration: "garmin",
                ...viewModel,
              } as IntegrationStatusViewModel)
            : undefined
        }
      />
    </I18nProvider>,
  );
}

function connected(keyExpiry: GarminKeyExpiry | null) {
  return render({
    connected: true,
    configured: true,
    health: healthFixture(),
    keyExpiry,
    metricFreshness: [],
  });
}

describe("GarminCard on the shared card", () => {
  it("lists the imported cycle days in the details", () => {
    const html = render({
      connected: true,
      configured: true,
      health: healthFixture(),
      keyExpiry: null,
      metricFreshness: [
        {
          type: "CYCLE_DAYS",
          lastSeenAt: "2026-10-20T12:00:00.000Z",
          count: 42,
          stale: false,
        },
      ],
    });
    expect(html).toContain('data-metric="CYCLE_DAYS"');
    expect(html).toContain("Cycle days (42)");
  });

  it("shows the key form inside the shared card while not connected", () => {
    const html = render({ connected: false, configured: false, health: null });
    expect(html).toContain('data-slot="integration-card"');
    expect(html).toContain('data-state="not_connected"');
    expect(html).toContain('id="garmin-api-key"');
    expect(html).toContain('id="garmin-key-validity"');
    expect(html).toContain(`href="${GARMIN_KEY_SETTINGS_URL}"`);
    expect(html).toContain('data-testid="garmin-connect"');
    expect(html).toContain(
      'href="https://docs.healthlog.dev/guides/connect-garmin/"',
    );
    // The service: Garmin Connect (global) first, China second.
    expect(html).toContain('id="garmin-region"');
    expect(html).toMatch(
      /<option value="global"[^>]*>Garmin Connect \(global\)<\/option><option value="china"/,
    );
    // Two services, then 30, 90, 180 and 365 days plus "I don't know".
    expect(html.match(/<option /g)).toHaveLength(7);
  });

  it("keeps the sibling menu and opens the form for a new key", () => {
    render({
      connected: true,
      configured: true,
      health: healthFixture({
        state: "action_required",
        reason: "reauth_required",
        action: "reconnect",
      }),
    });
    expect((lastCardProps?.menu ?? []).map((i) => i.id)).toEqual([
      "sync",
      "test",
      "view-data",
      "credentials",
      "validity",
      "setup-guide",
      "disconnect",
    ]);
    expect(lastCardProps?.primary?.onReconnect).toBeTypeOf("function");
    const disconnect = lastCardProps?.menu?.find((i) => i.id === "disconnect");
    expect(disconnect?.destructive).toBe(true);
    expect(disconnect?.confirm?.title).toBe("Disconnect Garmin?");
    invalidateSpy.mockClear();
    capturedDisconnectOnSuccess.fn?.();
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.integrationsStatus(),
    });
  });

  it("warns in the body when the key is about to expire", () => {
    const html = connected({
      state: "expiring",
      expiresAt: "2026-11-08T00:00:00.000Z",
      daysLeft: 3,
    });
    expect(html).toMatch(
      /data-testid="garmin-key-expiry"[^>]*data-state="expiring"/,
    );
    expect(html).toContain("Your Garmin key expires on");
    expect(html).not.toContain('data-testid="garmin-key-valid-until"');
  });

  it("says when the key expires today and when it has expired", () => {
    expect(
      connected({
        state: "expiring",
        expiresAt: "2026-11-04T20:00:00.000Z",
        daysLeft: 0,
      }),
    ).toContain("Your Garmin key expires today.");
    expect(
      connected({
        state: "expired",
        expiresAt: "2026-11-01T00:00:00.000Z",
        daysLeft: null,
      }),
    ).toContain("Your Garmin key expired on");
  });

  it("asks for the validity when the end is unknown", () => {
    expect(
      connected({ state: "unknown", expiresAt: null, daysLeft: null }),
    ).toContain("Garmin does not say when this key expires.");
  });

  it("keeps a valid key's date in the details, not the body", () => {
    const html = connected({
      state: "ok",
      expiresAt: "2027-01-30T00:00:00.000Z",
      daysLeft: 87,
    });
    expect(html).not.toContain('data-testid="garmin-key-expiry"');
    const details = html.slice(html.indexOf('data-slot="integration-details"'));
    expect(details).toContain('data-testid="garmin-key-valid-until"');
  });
});

describe("GarminCard — resources Garmin does not provide", () => {
  it("lists them in the details and the copied diagnostics, never the body", () => {
    const html = render({
      connected: true,
      configured: true,
      health: healthFixture(),
      keyExpiry: {
        state: "ok",
        expiresAt: "2027-01-30T00:00:00.000Z",
        daysLeft: 87,
      },
      unavailableResources: ["cycle"],
    });
    const details = html.slice(html.indexOf('data-slot="integration-details"'));
    expect(details).toContain('data-testid="garmin-unavailable"');
    expect(details).toContain(
      "Garmin does not provide this data for your account: menstrual cycle.",
    );
    expect(lastCardProps?.diagnosticsExtra).toContain(
      "Garmin does not provide this data for your account: menstrual cycle.",
    );
    expect(html).toMatch(/data-state="ok"/);
  });
});
