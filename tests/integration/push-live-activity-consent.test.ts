/**
 * Live Activity start and update over the relay, against the fake relay of
 * `push-relay-fake.ts`, which checks what the relay checks:
 *
 * - the consent is the device's signed `hl-la-consent-v1`, checked here and
 *   passed on; a forged or stale one is refused; `hl-la-withdraw-v1` and
 *   the relay withdrawal both drop it;
 * - the operator's switch `PUSH_RELAY_LIVE_ACTIVITY` holds every start and
 *   update back and is what `push.relay.liveActivity` reports;
 * - a start goes once per dose with the push-to-start statement, an update
 *   only when the state changed, and every content state is the closed
 *   six-key template with nothing else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import {
  FakeRelay,
  RELAY_HOST,
  RELAY_PUBLIC_KEY,
  RELAY_URL,
} from "./push-relay-fake";

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
import {
  makeMedication,
  makeSession,
  makeUser,
  type SessionFixture,
} from "../kit/factories";
import { bindDevice, enableRelay, registerDevice } from "./push-relay-kit";
import { tokenTagHex } from "@/lib/push-relay/encoding";
import {
  activityText,
  laConsentText,
  laStartText,
  laWithdrawText,
  signText,
} from "@/lib/push-relay/statements";
import { runLiveActivityRelayPass } from "@/lib/push-relay/live-activity";

let fake: FakeRelay;
const TOKEN = "a1".repeat(32);
const START_TOKEN = "5a".repeat(32);
const LA_TOKEN = "6b".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "on");
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  relay.current = fake;
});

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

async function startedOnMe(session: SessionFixture) {
  const { GET } = await import("@/app/api/auth/me/route");
  const me = await callRoute<{
    push: { device: { liveActivityStarted: unknown } | null };
  }>(GET, {
    method: "GET",
    route: "/api/auth/me",
    auth: session,
    headers: { "x-device-id": `device-${TOKEN.slice(0, 6)}` },
    contract: {
      skip: "the account payload's features block predates this check",
    },
  });
  return me.data.push.device?.liveActivityStarted;
}

async function setUp() {
  const { instanceId } = await enableRelay();
  const bound = await bindDevice(instanceId, TOKEN);
  const seed = bound.binding.seed;
  const base = {
    host: RELAY_HOST,
    instanceId,
    tokenTag: tokenTagHex(TOKEN) as string,
  };
  const reg = (extra: Record<string, unknown>) =>
    registerDevice(bound.session, {
      token: `device-${TOKEN.slice(0, 6)}`,
      bundleId: "dev.healthlog.app",
      apnsToken: TOKEN,
      apnsEnvironment: "production",
      ...extra,
    });
  const consent = (iat = now(), key = seed) => ({
    textVersion: "2026-11-21",
    iat,
    signature: signText(
      key,
      laConsentText({ ...base, textVersion: "2026-11-21", iat }),
    ).toString("base64url"),
  });
  const withdraw = (iat = now()) => ({
    iat,
    signature: signText(seed, laWithdrawText({ ...base, iat })).toString(
      "base64url",
    ),
  });
  const startField = (iat = now()) => {
    const statement = {
      instanceId,
      tokenTag: base.tokenTag,
      laTokenTag: tokenTagHex(START_TOKEN) as string,
      iat,
    };
    return {
      token: START_TOKEN,
      statement,
      signature: signText(
        seed,
        laStartText({ ...base, startTokenTag: statement.laTokenTag, iat }),
      ).toString("base64url"),
    };
  };
  const activityEntry = (extra: Record<string, unknown>) => {
    const statement = {
      instanceId,
      tokenTag: base.tokenTag,
      laTokenTag: tokenTagHex(LA_TOKEN) as string,
      iat: now(),
    };
    return {
      token: LA_TOKEN,
      statement,
      signature: signText(
        seed,
        activityText({
          ...base,
          laTokenTag: statement.laTokenTag,
          iat: statement.iat,
        }),
      ).toString("base64url"),
      ...extra,
    };
  };
  return { ...bound, reg, consent, withdraw, startField, activityEntry };
}

async function dueDose(userId: string, minutesFromNow: number) {
  const medication = await makeMedication({ id: userId });
  const slot = new Date(Date.now() + minutesFromNow * 60_000);
  slot.setUTCSeconds(0, 0);
  await getPrismaClient().medicationIntakeEvent.create({
    data: { userId, medicationId: medication.id, scheduledFor: slot },
  });
  return { medication, slot };
}

const laPushes = () => fake.apns.filter((a) => a.pushClass === "liveactivity");

describe("the Live Activity consent", () => {
  it("is the device's signed statement, passed on to the relay", async () => {
    const t = await setUp();
    const granted = await t.reg({ liveActivityConsent: t.consent() });
    expect(granted.status).toBe(201);
    expect(granted.data.push.liveActivityConsent).toBe(true);
    expect(fake.laConsents.get(TOKEN)).toBe("2026-11-21");

    const withdrawn = await t.reg({ liveActivityWithdraw: t.withdraw() });
    expect(withdrawn.data.push.liveActivityConsent).toBe(false);
    expect(fake.laConsents.has(TOKEN)).toBe(false);
  });

  it("refuses a forged, a stale and an unbound consent", async () => {
    const t = await setUp();
    const forged = await t.reg({
      liveActivityConsent: t.consent(now(), Buffer.alloc(32, 7)),
    });
    expect(forged.status).toBe(422);
    expect(JSON.stringify(forged.body)).toContain("devices.push.bad_signature");
    const stale = await t.reg({ liveActivityConsent: t.consent(now() - 900) });
    expect(JSON.stringify(stale.body)).toContain(
      "devices.push.statement_stale",
    );
    const other = await makeSession(await makeUser());
    const unbound = await registerDevice(other, {
      token: "device-unbound",
      bundleId: "dev.healthlog.app",
      apnsToken: "c3".repeat(32),
      apnsEnvironment: "production",
      liveActivityConsent: t.consent(),
    });
    expect(JSON.stringify(unbound.body)).toContain(
      "devices.push.relay_consent_required",
    );
    expect(fake.laConsents.size).toBe(0);
  });

  it("goes with the relay consent", async () => {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    const off = await t.reg({
      relayConsent: { granted: false, textVersion: "2026-11-21" },
    });
    expect(off.data.push.liveActivityConsent).toBe(false);
    const row = await getPrismaClient().device.findFirstOrThrow({
      where: { apnsToken: TOKEN },
    });
    expect(row.liveActivityConsentAt).toBeNull();
    expect(row.laStartToken).toBeNull();
  });
});

describe("start and update", () => {
  it("are held back while the operator's switch is off", async () => {
    vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "");
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    await dueDose(t.session.userId, 30);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(laPushes()).toHaveLength(0);
    expect((await relayBlock(t.session)).liveActivity).toEqual(["end"]);
    vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "on");
    expect((await relayBlock(t.session)).liveActivity).toEqual([
      "end",
      "start",
      "update",
    ]);
  });

  it("need the device's own consent", async () => {
    const t = await setUp();
    await t.reg({ liveActivityStart: t.startField() });
    await dueDose(t.session.userId, 30);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(laPushes()).toHaveLength(0);
  });

  it("start the next dose once, with the closed template", async () => {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    const { medication, slot } = await dueDose(t.session.userId, 30);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    const [start] = laPushes();
    const aps = start!.payload.aps as Record<string, unknown>;
    expect(start!.token).toBe(START_TOKEN);
    expect(aps.event).toBe("start");
    expect(aps.attributes).toEqual({ v: 1 });
    expect(aps["content-state"]).toEqual({
      status: "pending",
      countdownTarget: Math.floor(slot.getTime() / 1000),
      isOverdue: false,
      confirmed: false,
      pendingConfirm: false,
      timeFormatRaw: "AUTO",
    });
    expect(JSON.stringify(start!.payload)).not.toContain(medication.name);

    // Once per dose.
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(laPushes()).toHaveLength(1);

    // The app registers the started Activity without knowing its dose.
    const registered = await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true })],
    });
    const row = await getPrismaClient().liveActivityToken.findFirstOrThrow({});
    expect(row.medicationId).toBe(medication.id);
    expect(row.slotInstant?.getTime()).toBe(slot.getTime());
    // The dose reaches the app over the authenticated channel only: in the
    // registration answer and on /api/auth/me for the calling device.
    const started = {
      medicationId: medication.id,
      slotInstant: slot.toISOString(),
    };
    expect(registered.data.push.liveActivityStarted).toEqual(started);
    expect(await startedOnMe(t.session)).toEqual(started);
    // Once the slot is answered there is nothing left to show.
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: medication.id, scheduledFor: slot },
      data: { takenAt: new Date() },
    });
    expect(await startedOnMe(t.session)).toBeNull();
  });

  it("never start a dose of a paused medication", async () => {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    const { medication } = await dueDose(t.session.userId, 30);
    await getPrismaClient().medication.update({
      where: { id: medication.id },
      data: { pausedAt: new Date() },
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(laPushes()).toHaveLength(0);
    expect(await startedOnMe(t.session)).toBeNull();
  });

  it("update a running Activity only when its state changed", async () => {
    const t = await setUp();
    await t.reg({ liveActivityConsent: t.consent() });
    const { medication, slot } = await dueDose(t.session.userId, -45);
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({
          medicationId: medication.id,
          slotInstant: slot.toISOString(),
        }),
      ],
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ updated: 1 });
    const [update] = laPushes();
    const aps = update!.payload.aps as Record<string, unknown>;
    expect(update!.token).toBe(LA_TOKEN);
    expect(aps.event).toBe("update");
    expect(aps["content-state"]).toMatchObject({
      status: "overdue",
      isOverdue: true,
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ updated: 0 });

    await getPrismaClient().medication.update({
      where: { id: medication.id },
      data: { snoozedUntil: new Date(Date.now() + 20 * 60_000) },
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ updated: 1 });
    expect(
      (laPushes().at(-1)!.payload.aps as Record<string, unknown>)[
        "content-state"
      ],
    ).toMatchObject({ status: "snoozed" });
  });
});
