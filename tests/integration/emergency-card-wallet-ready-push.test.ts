/**
 * "Your emergency card is ready for Wallet" (`EMERGENCY_CARD_WALLET_READY`)
 * against real Postgres: sent once per pass and at most twice per person,
 * only while every condition holds, claimed atomically, never for a managed
 * profile, and silenced for good by the person's no.
 *
 * The dispatcher is replaced by a recorder for the condition cases; one case
 * runs the real dispatcher so the event reaches the `push_attempts` ledger.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const dispatch = vi.hoisted(() => ({
  real: false,
  calls: [] as Array<{ eventType: string; userId: string; title: string }>,
}));
vi.mock("@/lib/notifications/dispatcher", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/notifications/dispatcher")>();
  return {
    ...actual,
    dispatchNotification: async (
      payload: Parameters<typeof actual.dispatchNotification>[0],
    ) => {
      if (dispatch.real) return actual.dispatchNotification(payload);
      dispatch.calls.push({
        eventType: payload.eventType,
        userId: payload.userId,
        title: payload.title,
      });
      return { dispatched: true, channelsAttempted: 1, channelsSucceeded: 1 };
    },
  };
});

import {
  RELAY_SPEC_DIR,
  relayReference,
} from "@/lib/emergency-card/wallet-pass/__tests__/fixture";
import {
  runWalletReadyPushPass,
  sendWalletReadyPush,
  WALLET_READY_EVENT,
} from "@/lib/emergency-card/wallet-pass/ready-push";
import { WALLET_RELAY_CONSENT_TEXT_VERSION } from "@/lib/push-relay/config";
import { writeEmergencyProfile } from "@/lib/profile/emergency-profile";
import { createManagedProfile } from "@/lib/managed-profiles/create";

import { callRoute, type RouteAuth } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const HTTPS = { "x-forwarded-proto": "https", host: "health.example.test" };
const ROUTE = "/api/emergency-card/wallet/apple";

const vectors = JSON.parse(
  readFileSync(join(RELAY_SPEC_DIR, "wallet-v1.json"), "utf8"),
) as {
  seeds: { pass: string };
  certificates: { pass: string; intermediate: string };
  passTypeIdentifier: string;
  teamIdentifier: string;
};

/** The operator's own signer, so Wallet is `available` without a relay. */
async function localEnv() {
  const { deriveRSAKey } = await relayReference();
  const key = deriveRSAKey(Buffer.from(vectors.seeds.pass, "hex")).privateKey;
  const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64");
  vi.stubEnv("WALLET_APPLE_PASS_TYPE_ID", vectors.passTypeIdentifier);
  vi.stubEnv("WALLET_APPLE_TEAM_ID", vectors.teamIdentifier);
  vi.stubEnv(
    "WALLET_APPLE_CERT_B64",
    b64(Buffer.from(vectors.certificates.pass, "base64url")),
  );
  vi.stubEnv(
    "WALLET_APPLE_KEY_B64",
    b64(key.export({ type: "pkcs8", format: "pem" }) as string),
  );
  vi.stubEnv(
    "WALLET_APPLE_WWDR_B64",
    b64(Buffer.from(vectors.certificates.intermediate, "base64url")),
  );
}

const routes = async () => ({
  status: await import("@/app/api/emergency-card/wallet/apple/route"),
  dismiss:
    await import("@/app/api/emergency-card/wallet/apple/ready-push/dismiss/route"),
});

async function makePass(
  auth: RouteAuth,
  fields: string[] = ["NAME", "BLOOD_TYPE"],
) {
  const { status } = await routes();
  const res = await callRoute(status.POST, {
    method: "POST",
    route: ROUTE,
    auth,
    body: { fields, consentTextVersion: WALLET_RELAY_CONSENT_TEXT_VERSION },
    headers: HTTPS,
  });
  expect(res.status).toBe(201);
}

async function withdraw(auth: RouteAuth) {
  const { status } = await routes();
  const res = await callRoute(status.DELETE, {
    method: "DELETE",
    route: ROUTE,
    auth,
  });
  expect(res.status).toBe(200);
}

async function iphone(userId: string) {
  await prisma.device.create({
    data: {
      userId,
      platform: "ios",
      token: `dev-${userId}-${Math.random()}`,
      bundleId: "dev.healthlog.app",
      apnsToken: "ab".repeat(32),
      apnsEnvironment: "sandbox",
    },
  });
}

/** An owner with a card, a live pass and an iPhone: every condition holds. */
async function ready() {
  const owner = await makeUser();
  await prisma.user.update({
    where: { id: owner.id },
    data: { fullName: "Alex Example", timezone: "Europe/Berlin" },
  });
  await writeEmergencyProfile(owner.id, { bloodType: "O_NEG" });
  const session = await makeSession(owner);
  await makePass(session);
  await iphone(owner.id);
  return { owner, session };
}

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_MODE", "off");
  await truncateAllTables(prisma);
  await localEnv();
  dispatch.real = false;
  dispatch.calls = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the Wallet ready push", () => {
  it("is sent once when every condition holds", async () => {
    const { owner } = await ready();
    expect(await sendWalletReadyPush(owner.id)).toEqual({ result: "sent" });
    expect(dispatch.calls).toEqual([
      expect.objectContaining({
        eventType: WALLET_READY_EVENT,
        userId: owner.id,
      }),
    ]);
    expect(await sendWalletReadyPush(owner.id)).toEqual({
      result: "skipped",
      reason: "already_sent",
    });
    expect(dispatch.calls).toHaveLength(1);
  });

  it("waits for a card that shows something", async () => {
    const owner = await makeUser();
    const session = await makeSession(owner);
    await makePass(session, ["BLOOD_TYPE"]);
    await iphone(owner.id);
    expect(await sendWalletReadyPush(owner.id)).toEqual({
      result: "skipped",
      reason: "empty_card",
    });
    expect(dispatch.calls).toHaveLength(0);
  });

  it("waits while Wallet is not available", async () => {
    const { owner } = await ready();
    vi.stubEnv("WALLET_APPLE_KEY_B64", "");
    expect(await sendWalletReadyPush(owner.id)).toEqual({
      result: "skipped",
      reason: "not_available",
    });
  });

  it("is not sent once a device registered the pass", async () => {
    const { owner } = await ready();
    const pass = await prisma.walletPass.findFirstOrThrow({
      where: { userId: owner.id },
    });
    await prisma.walletPassRegistration.create({
      data: {
        walletPassId: pass.id,
        deviceLibraryIdHash: "h".repeat(64),
        pushTokenEncrypted: "x",
      },
    });
    expect(await sendWalletReadyPush(owner.id)).toEqual({
      result: "skipped",
      reason: "registered",
    });
  });

  it("is not sent without an iPhone that takes pushes", async () => {
    const owner = await makeUser();
    await prisma.user.update({
      where: { id: owner.id },
      data: { fullName: "Alex Example" },
    });
    await makePass(await makeSession(owner));
    expect(await sendWalletReadyPush(owner.id)).toEqual({
      result: "skipped",
      reason: "no_ios_device",
    });
  });

  it("respects the person's no, reported by the app, for good", async () => {
    const { owner, session } = await ready();
    const { dismiss } = await routes();
    const res = await callRoute<{ dismissed: boolean }>(dismiss.POST, {
      method: "POST",
      route: `${ROUTE}/ready-push/dismiss`,
      auth: session,
    });
    expect(res.status).toBe(200);
    expect(await sendWalletReadyPush(owner.id)).toEqual({
      result: "skipped",
      reason: "dismissed",
    });
    // Not even after the pass is made again.
    await withdraw(session);
    await makePass(session);
    expect((await sendWalletReadyPush(owner.id)).result).toBe("skipped");
    expect(dispatch.calls).toHaveLength(0);
  });

  it("is sent once more after a withdrawn pass was made again, then never", async () => {
    const { owner, session } = await ready();
    expect((await sendWalletReadyPush(owner.id)).result).toBe("sent");
    await withdraw(session);
    expect(await sendWalletReadyPush(owner.id)).toEqual({
      result: "skipped",
      reason: "no_pass",
    });
    await makePass(session);
    expect((await sendWalletReadyPush(owner.id)).result).toBe("sent");
    await withdraw(session);
    await makePass(session);
    expect(await sendWalletReadyPush(owner.id)).toEqual({
      result: "skipped",
      reason: "limit",
    });
    expect(dispatch.calls).toHaveLength(2);
  });

  it("sends once when many workers race the same pass", async () => {
    const { owner } = await ready();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => sendWalletReadyPush(owner.id)),
    );
    expect(results.filter((r) => r.result === "sent")).toHaveLength(1);
    expect(dispatch.calls).toHaveLength(1);
  });

  it("is never sent for a managed profile", async () => {
    const guardian = await makeUser();
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const session = await makeSession(guardian);
    await switchSessionTo(session.sessionId, profile.id);
    await makePass(session, ["NAME"]);
    await iphone(guardian.id);
    expect(await sendWalletReadyPush(profile.id)).toEqual({
      result: "skipped",
      reason: "managed",
    });
    expect((await runWalletReadyPushPass()).sent).toBe(0);
    expect(dispatch.calls).toHaveLength(0);
  });

  it("finds stragglers in the sweep", async () => {
    const { owner } = await ready();
    expect(await runWalletReadyPushPass()).toMatchObject({ sent: 1 });
    expect(await runWalletReadyPushPass()).toMatchObject({ sent: 0 });
    expect(dispatch.calls.map((c) => c.userId)).toEqual([owner.id]);
  });

  it("goes through the dispatcher's ledger as its own event", async () => {
    const { owner } = await ready();
    const { encrypt } = await import("@/lib/crypto");
    await prisma.notificationChannel.create({
      data: {
        userId: owner.id,
        type: "APNS",
        enabled: true,
        config: encrypt("{}"),
      },
    });
    dispatch.real = true;
    await sendWalletReadyPush(owner.id);
    // The ledger row is written beside the send, not awaited by it.
    await expect
      .poll(() =>
        prisma.pushAttempt.count({
          where: { userId: owner.id, eventType: WALLET_READY_EVENT },
        }),
      )
      .toBeGreaterThan(0);
  });
});
