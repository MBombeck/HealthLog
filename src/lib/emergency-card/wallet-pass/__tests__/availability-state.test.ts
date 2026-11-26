/**
 * `emergencyCard.wallet.apple.state` and `relayAction`: the one resolved
 * answer the web card and the app render for "Add to Apple Wallet", one
 * case per state. The relay gate is the point: a server without its own
 * `WALLET_APPLE_*` signs over the relay, so a relay that is off is a state
 * of its own, with an action that depends on who is asking.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  apiOn: true,
  mode: { kind: "relay" } as
    | { kind: "relay" }
    | { kind: "invalid"; problem: string }
    | {
        kind: "local";
        identity: { passTypeIdentifier: string; teamIdentifier: string };
      },
  relayAvailable: true,
  registration: null as null | {
    instanceId: string | null;
    state: string;
    relayStatus: unknown;
  },
  walletSign: true,
}));

vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: async () => env.apiOn,
}));
vi.mock("@/lib/push-relay/config", () => ({
  relayConfig: () => ({ available: env.relayAvailable }),
  WALLET_RELAY_CONSENT_TEXT_VERSION: "2026-11-01",
}));
vi.mock("@/lib/push-relay/registration", () => ({
  loadRegistration: async () => env.registration,
}));
vi.mock("@/lib/push-relay/relay-status", () => ({
  storedRelayStatus: (value: unknown) =>
    value
      ? {
          wallet: {
            sign: env.walletSign,
            passTypeIdentifier: "pass.example.relay",
            teamIdentifier: "TEAM123456",
          },
        }
      : null,
}));
vi.mock("../sign", () => ({ walletSigningMode: () => env.mode }));
vi.mock("../service", () => ({
  latestWalletPass: async () => null,
  toWalletPassSummary: () => null,
}));

import { resolveEmergencyWalletApple } from "../availability";

const HTTPS = "https://health.example.test";

function resolve(
  over: Partial<Parameters<typeof resolveEmergencyWalletApple>[0]> = {},
) {
  return resolveEmergencyWalletApple({
    recordUserId: "record-1",
    allowed: true,
    origin: HTTPS,
    authMethod: "cookie",
    callerIsAdmin: false,
    relayHintDismissed: false,
    ...over,
  });
}

const RELAY_READY = {
  instanceId: "inst-1",
  state: "ok",
  relayStatus: { at: "2026-11-26T00:00:00Z" },
};

beforeEach(() => {
  env.apiOn = true;
  env.mode = { kind: "relay" };
  env.relayAvailable = true;
  env.registration = null;
  env.walletSign = true;
});

describe("emergencyCard.wallet.apple.state", () => {
  it("is available over the relay once it signs passes", async () => {
    env.registration = RELAY_READY;
    expect(await resolve()).toMatchObject({
      available: true,
      reason: "ok",
      state: "available",
      signer: "relay",
      relayAction: null,
    });
  });

  it("is available with the operator's own signer, and never asks for the relay", async () => {
    env.mode = {
      kind: "local",
      identity: {
        passTypeIdentifier: "pass.example.local",
        teamIdentifier: "LOCAL12345",
      },
    };
    // The relay is off and could be switched on: irrelevant here.
    expect(await resolve({ callerIsAdmin: true })).toMatchObject({
      available: true,
      state: "available",
      signer: "local",
      relayAction: null,
    });
  });

  it("is relay_off for an admin, who can switch it on here", async () => {
    expect(await resolve({ callerIsAdmin: true })).toMatchObject({
      available: false,
      reason: "relay_not_ready",
      state: "relay_off",
      relayAction: "enable",
      relayHintDismissed: false,
    });
  });

  it("is relay_off for anybody else, who asks the admin", async () => {
    expect(await resolve()).toMatchObject({
      available: false,
      state: "relay_off",
      relayAction: "ask_admin",
    });
  });

  it("carries the caller's dismissal and keeps the action", async () => {
    expect(await resolve({ relayHintDismissed: true })).toMatchObject({
      state: "relay_off",
      relayAction: "ask_admin",
      relayHintDismissed: true,
    });
  });

  it("is relay_off while a registration has no instance yet", async () => {
    env.registration = {
      instanceId: null,
      state: "pending",
      relayStatus: null,
    };
    expect(await resolve({ callerIsAdmin: true })).toMatchObject({
      state: "relay_off",
      relayAction: "enable",
    });
  });

  it("is relay_not_ready when the relay is on but does not sign yet", async () => {
    env.registration = { ...RELAY_READY, relayStatus: null };
    expect(await resolve({ callerIsAdmin: true })).toMatchObject({
      available: false,
      reason: "relay_not_ready",
      state: "relay_not_ready",
      relayAction: null,
    });
    env.registration = RELAY_READY;
    env.walletSign = false;
    expect((await resolve()).state).toBe("relay_not_ready");
  });

  it("is not_configured without a usable relay or a valid own signer", async () => {
    env.relayAvailable = false;
    expect(await resolve({ callerIsAdmin: true })).toMatchObject({
      reason: "signer_off",
      state: "not_configured",
      relayAction: null,
    });
    env.relayAvailable = true;
    env.mode = { kind: "invalid", problem: "cert" };
    expect((await resolve({ callerIsAdmin: true })).state).toBe(
      "not_configured",
    );
  });

  it("is api_disabled and no_https_origin before anything about the signer", async () => {
    env.apiOn = false;
    expect((await resolve({ callerIsAdmin: true })).state).toBe("api_disabled");
    env.apiOn = true;
    env.registration = RELAY_READY;
    expect((await resolve({ origin: "http://lan.example" })).state).toBe(
      "no_https_origin",
    );
  });

  it("is not_allowed for a delegate on an adult's record", async () => {
    expect(
      await resolve({ allowed: false, callerIsAdmin: true }),
    ).toMatchObject({ state: "not_allowed", relayAction: null });
  });

  it("answers a guardian on a ward's record by the guardian's own role", async () => {
    // The record is the ward's; who may switch the relay on is the caller.
    expect(
      await resolve({ recordUserId: "ward-1", callerIsAdmin: true }),
    ).toMatchObject({ state: "relay_off", relayAction: "enable" });
    expect(
      await resolve({ recordUserId: "ward-1", callerIsAdmin: false }),
    ).toMatchObject({ state: "relay_off", relayAction: "ask_admin" });
  });
});
