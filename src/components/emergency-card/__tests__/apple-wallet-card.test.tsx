/**
 * The Apple Wallet card renders the server's answer and nothing of its own:
 * no card for a delegate, the reason when the server cannot make passes,
 * the form with the name ticked when it can, and the pass's state as a pill.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { EmergencyWalletApple } from "@/lib/emergency-card/wallet-pass/availability";

const auth = vi.hoisted(() => ({ apple: null as unknown }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    profileLoaded: true,
    user: {
      id: "u1",
      emergencyCard: auth.apple ? { wallet: { apple: auth.apple } } : null,
    },
  }),
}));

import { AppleWalletCard } from "../apple-wallet-card";

const BASE: EmergencyWalletApple = {
  available: true,
  reason: "ok",
  state: "available",
  relayAction: null,
  relayHintDismissed: false,
  signer: "relay",
  passTypeIdentifier: "pass.dev.healthlog.emergency",
  canCreate: true,
  createPath: "/emergency-card#wallet",
  consentTextVersion: "2026-11-24",
  pass: null,
};

const PASS = {
  serialNumber: "6f1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b",
  state: "live" as const,
  fields: ["NAME", "BLOOD_TYPE"] as NonNullable<
    EmergencyWalletApple["pass"]
  >["fields"],
  createdAt: "2026-11-24T08:00:00.000Z",
  contentChangedAt: "2026-11-24T08:00:00.000Z",
  expiresAt: null,
  voidedAt: null,
  voidReason: null,
  lastFetchedAt: null,
  downloadPath: "/api/emergency-card/wallet/apple/pass" as const,
};

function render(apple: EmergencyWalletApple | null): string {
  auth.apple = apple;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <AppleWalletCard />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<AppleWalletCard>", () => {
  it("shows nothing without the server's answer or to a delegate", () => {
    expect(render(null)).toBe("");
    expect(
      render({
        ...BASE,
        available: false,
        reason: "not_allowed",
        state: "not_allowed",
      }),
    ).toBe("");
  });

  it("names the reason when this server makes no passes", () => {
    const html = render({
      ...BASE,
      available: false,
      reason: "signer_off",
      state: "not_configured",
    });
    expect(html).toContain('data-slot="wallet-unavailable"');
    expect(html).toContain("This server does not sign Wallet passes.");
    expect(html).not.toContain('data-slot="wallet-create"');
  });

  it("offers the form with the name ticked and one line of text", () => {
    const html = render(BASE);
    expect(html).toContain('id="wallet"');
    expect(html).toContain('data-slot="wallet-create"');
    // What the pass shows is one row with a count; the list opens in a sheet.
    expect(html).toContain('data-slot="wallet-fields-row"');
    expect(html).toContain("8 of 12");
    expect(html).toContain("Learn more");
  });

  it("shows a live pass with its pill, the add and the withdraw", () => {
    const html = render({ ...BASE, pass: PASS });
    expect(html).toMatch(/data-slot="wallet-pass-state"[^>]*data-state="live"/);
    expect(html).toContain('data-slot="wallet-add"');
    expect(html).toContain("Withdraw pass");
    expect(html).not.toContain('data-slot="wallet-create"');
  });

  it("keeps withdrawing secondary: outline, before the primary, never red", () => {
    const html = render({ ...BASE, pass: PASS });
    const withdraw = /<button(?=[^>]*data-slot="wallet-withdraw")[^>]*>/.exec(
      html,
    )?.[0];
    expect(withdraw).toContain('data-variant="outline"');
    expect(withdraw).not.toMatch(/bg-destructive|text-destructive/);
    const add = /<button(?=[^>]*data-slot="wallet-add")[^>]*>/.exec(html)?.[0];
    expect(add).toContain('data-variant="default"');
    expect(html.indexOf('data-slot="wallet-withdraw"')).toBeLessThan(
      html.indexOf('data-slot="wallet-add"'),
    );
  });

  it("offers another device once a device has the pass", () => {
    expect(render({ ...BASE, pass: PASS })).toContain(">Add to Apple Wallet<");
    const html = render({
      ...BASE,
      pass: { ...PASS, lastFetchedAt: "2026-11-24T09:00:00.000Z" },
    });
    expect(html).toContain(">Add to another device<");
  });

  it("says why a withdrawn pass ended and lists nothing of it", () => {
    const html = render({
      ...BASE,
      pass: {
        ...PASS,
        state: "voided",
        voidedAt: "2026-11-24T09:00:00.000Z",
        voidReason: "credential_reset",
      },
    });
    expect(html).toMatch(/data-state="voided"/);
    expect(html).toContain("after a password change");
    expect(html).not.toContain("Shows:");
    expect(html).toContain("Make a new pass");
  });

  describe("while the relay that would sign is off", () => {
    const OFF: EmergencyWalletApple = {
      ...BASE,
      available: false,
      reason: "relay_not_ready",
      state: "relay_off",
      relayAction: "ask_admin",
      canCreate: false,
    };

    it("keeps the action, enabled, with one line saying what it needs", () => {
      const html = render(OFF);
      const add = /<button(?=[^>]*data-slot="wallet-create")[^>]*>/.exec(
        html,
      )?.[0];
      expect(add).toBeDefined();
      expect(add).not.toMatch(/\sdisabled(=|\s|>)/);
      expect(html).toContain('data-slot="wallet-relay-hint"');
      expect(html).not.toContain('data-slot="wallet-unavailable"');
    });

    it("drops the line once the caller said no, not the action", () => {
      const html = render({ ...OFF, relayHintDismissed: true });
      expect(html).toContain('data-slot="wallet-create"');
      expect(html).not.toContain('data-slot="wallet-relay-hint"');
    });

    it("renders the same for an admin, whose tap opens the switch", () => {
      const html = render({ ...OFF, relayAction: "enable" });
      expect(html).toContain('data-slot="wallet-create"');
      expect(html).toContain('data-slot="wallet-relay-hint"');
    });

    it("names the wait while the relay is on but not signing yet", () => {
      const html = render({
        ...OFF,
        state: "relay_not_ready",
        relayAction: null,
      });
      expect(html).toContain('data-slot="wallet-unavailable"');
      expect(html).not.toContain('data-slot="wallet-create"');
    });
  });
});
