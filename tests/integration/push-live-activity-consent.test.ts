/**
 * The second, separate consent to Live Activity start and update over the
 * relay: its own field, refused without the relay consent, withdrawn with
 * it, and published as `push.device.liveActivityConsent`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { FakeRelay, RELAY_PUBLIC_KEY, RELAY_URL } from "./push-relay-fake";

const relay = vi.hoisted(() => ({
  current: null as null | {
    handle: (url: string | URL, init?: RequestInit) => Promise<Response>;
  },
}));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: (url: string | URL, init?: RequestInit) => {
      if (!relay.current) throw new Error("no fake relay");
      return relay.current.handle(url, init);
    },
  };
});

import { getPrismaClient, truncateAllTables } from "./setup";
import { callRoute } from "../kit/call-route";
import { makeSession, makeUser, type SessionFixture } from "../kit/factories";
import { deviceBody, enableRelay, registerDevice } from "./push-relay-kit";

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  await truncateAllTables(getPrismaClient());
  relay.current = new FakeRelay();
});

const CONSENT = { granted: true, textVersion: "2026-11-21" };

async function relayBlock(session: SessionFixture) {
  const { GET } = await import("@/app/api/auth/me/route");
  const me = await callRoute<{
    push: {
      relay: { liveActivity: string[]; liveActivityConsentTextVersion: string };
    };
  }>(GET, {
    method: "GET",
    route: "/api/auth/me",
    auth: session,
    contract: {
      skip: "the account payload's features block predates this check",
    },
  });
  return me.data.push.relay;
}

describe("Live Activity consent", () => {
  it("is refused without the relay consent", async () => {
    await enableRelay();
    const session = await makeSession(await makeUser());
    const { POST } = await import("@/app/api/devices/route");
    const res = await callRoute(POST, {
      method: "POST",
      route: "/api/devices",
      auth: session,
      body: {
        token: "device-la0001",
        bundleId: "dev.healthlog.app",
        apnsToken: "a0".repeat(32),
        apnsEnvironment: "production",
        liveActivityConsent: CONSENT,
      },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain(
      "devices.push.relay_consent_required",
    );
  });

  it("is stored beside the relay consent and withdrawn with it", async () => {
    const { instanceId } = await enableRelay();
    const session = await makeSession(await makeUser());
    const token = "a1".repeat(32);
    const { body } = deviceBody(instanceId, token);
    const bound = await registerDevice(session, body);
    expect(bound.data.push.liveActivityConsent).toBe(false);

    const granted = await registerDevice(session, {
      token: body.token,
      bundleId: body.bundleId,
      apnsToken: token,
      apnsEnvironment: "production",
      liveActivityConsent: CONSENT,
    });
    expect(granted.data.push.liveActivityConsent).toBe(true);
    const row = await getPrismaClient().device.findFirstOrThrow({
      where: { token: body.token },
    });
    expect(row.liveActivityConsentVersion).toBe("2026-11-21");

    const withdrawn = await registerDevice(session, {
      token: body.token,
      bundleId: body.bundleId,
      apnsToken: token,
      apnsEnvironment: "production",
      relayConsent: { granted: false, textVersion: "2026-11-21" },
    });
    expect(withdrawn.data.push.liveActivityConsent).toBe(false);
    const after = await getPrismaClient().device.findFirstOrThrow({
      where: { token: body.token },
    });
    expect(after.liveActivityConsentAt).toBeNull();
  });
});

describe("the account payload", () => {
  it("names the consent text version and carries only end", async () => {
    await enableRelay();
    const session = await makeSession(await makeUser());
    const block = await relayBlock(session);
    expect(block.liveActivity).toEqual(["end"]);
    expect(block.liveActivityConsentTextVersion).toBe("2026-11-21");
  });
});
