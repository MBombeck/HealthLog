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
  const activityEntry = (
    extra: Record<string, unknown>,
    activityToken: string = LA_TOKEN,
  ) => {
    const statement = {
      instanceId,
      tokenTag: base.tokenTag,
      laTokenTag: tokenTagHex(activityToken) as string,
      iat: now(),
    };
    return {
      token: activityToken,
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

/**
 * A time zone in which the real clock reads about noon, so every slot and
 * window of a test lands on one local day whenever the suite runs.
 */
function noonZone(): string {
  const offset = 12 - new Date().getUTCHours();
  if (offset === 0) return "UTC";
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

function hhmm(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/**
 * A daily medication with a dose `minutesFromNow` away, its open row on that
 * slot, and, when given, a stored dose window around it (minutes relative to
 * the slot). Without one the band is the daily default.
 */
async function dueDose(
  userId: string,
  minutesFromNow: number,
  window?: { start: number; end: number },
) {
  const tz = noonZone();
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { timezone: tz },
  });
  const slot = new Date(Date.now() + minutesFromNow * 60_000);
  slot.setUTCSeconds(0, 0);
  const time = hhmm(slot, tz);
  const minutes = (m: number) => new Date(slot.getTime() + m * 60_000);
  const medication = await makeMedication(
    { id: userId },
    { createdAt: new Date(slot.getTime() - 2 * 24 * 3600_000) },
    [
      {
        windowStart: time,
        windowEnd: time,
        timesOfDay: [time],
        ...(window && {
          doseWindows: [
            {
              timeOfDay: time,
              start: hhmm(minutes(window.start), tz),
              end: hhmm(minutes(window.end), tz),
            },
          ],
        }),
      },
    ],
  );
  await getPrismaClient().medicationIntakeEvent.create({
    data: { userId, medicationId: medication.id, scheduledFor: slot },
  });
  return { medication, slot, at: minutes };
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

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
    const { medication, slot } = await dueDose(t.session.userId, 90);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    const [start] = laPushes();
    const aps = start!.payload.aps as Record<string, unknown>;
    expect(start!.token).toBe(START_TOKEN);
    expect(aps.event).toBe("start");
    expect(aps.attributes).toEqual({ v: 1 });
    expect(aps["content-state"]).toEqual({
      // Counts to the window's opening: the daily band opens an hour early.
      status: "pending",
      countdownTarget: unix(slot) - 3600,
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
    // Past the daily band's on-time hour after the slot.
    const { medication, slot } = await dueDose(t.session.userId, -90);
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({
          relayStart: true,
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

describe("the dose state", () => {
  const contentState = (push: (typeof fake.apns)[number] | undefined) =>
    (push!.payload.aps as Record<string, unknown>)["content-state"];

  it("follows the medication's stored dose window, not a fixed grace", async () => {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    // On time from the slot to three hours after it.
    const { at } = await dueDose(t.session.userId, 5, { start: 0, end: 180 });
    // 45 minutes past the slot: a fixed 30-minute grace called it overdue.
    expect(await runLiveActivityRelayPass(at(45))).toMatchObject({
      started: 1,
    });
    expect(contentState(laPushes()[0])).toEqual({
      status: "due",
      countdownTarget: unix(at(180)),
      isOverdue: false,
      confirmed: false,
      pendingConfirm: false,
      timeFormatRaw: "AUTO",
    });
  });

  it("starts no earlier than the app's lead before the slot", async () => {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    const { at } = await dueDose(t.session.userId, 150);
    expect(await runLiveActivityRelayPass(at(-121))).toMatchObject({
      started: 0,
    });
    expect(await runLiveActivityRelayPass(at(-120))).toMatchObject({
      started: 1,
    });
  });

  it("updates exactly at the band's boundaries and ends when missed", async () => {
    const t = await setUp();
    await t.reg({ liveActivityConsent: t.consent() });
    // Due from 30 minutes before the slot to 90 after; missed three hours
    // later (the daily late tail).
    const { medication, slot, at } = await dueDose(t.session.userId, 40, {
      start: -30,
      end: 90,
    });
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({
          relayStart: true,
          medicationId: medication.id,
          slotInstant: slot.toISOString(),
        }),
      ],
    });
    const second = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
    const dueAt = at(-30);
    const overdueSince = at(90);
    const missedAfter = at(270);
    const pass = async (now: Date) => {
      const before = laPushes().length;
      await runLiveActivityRelayPass(now);
      return laPushes().slice(before);
    };

    let pushes = await pass(second(dueAt, -1));
    expect(pushes.map(contentState)).toEqual([
      expect.objectContaining({
        status: "pending",
        countdownTarget: unix(dueAt),
      }),
    ]);
    expect(await pass(second(dueAt, -1))).toEqual([]);

    pushes = await pass(dueAt);
    expect(pushes.map(contentState)).toEqual([
      expect.objectContaining({
        status: "due",
        countdownTarget: unix(overdueSince),
        isOverdue: false,
      }),
    ]);
    expect(await pass(overdueSince)).toEqual([]);

    pushes = await pass(second(overdueSince, 1));
    expect(pushes.map(contentState)).toEqual([
      expect.objectContaining({
        status: "overdue",
        countdownTarget: unix(overdueSince),
        isOverdue: true,
      }),
    ]);
    expect(await pass(missedAfter)).toEqual([]);

    // Missed: nothing left to show, the Activity ends and its token goes.
    pushes = await pass(second(missedAfter, 1));
    expect(pushes).toEqual([
      expect.objectContaining({
        token: LA_TOKEN,
        payload: { aps: { event: "end" } },
      }),
    ]);
    expect(await getPrismaClient().liveActivityToken.count()).toBe(0);
    expect(await pass(second(missedAfter, 301))).toEqual([]);
  });
});

describe("who started the Activity", () => {
  const APP_LA_TOKEN = "7c".repeat(32);

  it("updates only the one the server started, and ends both", async () => {
    const t = await setUp();
    await t.reg({ liveActivityConsent: t.consent() });
    // Past the daily band's on-time hour after the slot: overdue.
    const { medication, slot, at } = await dueDose(t.session.userId, -90);
    const dose = {
      medicationId: medication.id,
      slotInstant: slot.toISOString(),
    };
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({ ...dose, relayStart: true }),
        // The app's own Activity of the same dose, its own attributes type.
        t.activityEntry(dose, APP_LA_TOKEN),
      ],
    });
    const rows = await getPrismaClient().liveActivityToken.findMany({
      orderBy: { pushToken: "asc" },
      select: { pushToken: true, relayStarted: true },
    });
    expect(rows).toEqual([
      { pushToken: LA_TOKEN, relayStarted: true },
      { pushToken: APP_LA_TOKEN, relayStarted: false },
    ]);

    expect(await runLiveActivityRelayPass()).toMatchObject({ updated: 1 });
    expect(laPushes().map((p) => [p.token, p.payload.aps])).toEqual([
      [LA_TOKEN, expect.objectContaining({ event: "update" })],
    ]);

    // A later post of the set that names the dose and leaves `relayStart`
    // out keeps the mark: it belongs to the Activity, not to the post.
    await t.reg({
      liveActivityTokens: [
        t.activityEntry(dose),
        t.activityEntry(dose, APP_LA_TOKEN),
      ],
    });
    expect(
      await getPrismaClient().liveActivityToken.count({
        where: { relayStarted: true },
      }),
    ).toBe(1);
    await getPrismaClient().medication.update({
      where: { id: medication.id },
      data: { snoozedUntil: new Date(Date.now() + 20 * 60_000) },
    });
    const before = laPushes().length;
    expect(await runLiveActivityRelayPass()).toMatchObject({ updated: 1 });
    expect(
      laPushes()
        .slice(before)
        .map((p) => p.token),
    ).toEqual([LA_TOKEN]);

    // Missed: both end, whoever started them.
    const ended = laPushes().length;
    await runLiveActivityRelayPass(at(24 * 60));
    expect(
      laPushes()
        .slice(ended)
        .map((p) => [p.token, (p.payload.aps as { event: string }).event])
        .sort(),
    ).toEqual(
      [
        [APP_LA_TOKEN, "end"],
        [LA_TOKEN, "end"],
      ].sort(),
    );
    expect(await getPrismaClient().liveActivityToken.count()).toBe(0);
  });
});

describe("a device leaving the account", () => {
  const APP_LA_TOKEN = "8d".repeat(32);
  const endedTokens = (from: number) =>
    laPushes()
      .slice(from)
      .filter((p) => (p.payload.aps as { event?: string }).event === "end")
      .map((p) => p.token)
      .sort();

  async function twoActivities() {
    const t = await setUp();
    await t.reg({ liveActivityConsent: t.consent() });
    const { medication, slot } = await dueDose(t.session.userId, 10);
    const dose = {
      medicationId: medication.id,
      slotInstant: slot.toISOString(),
    };
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({ ...dose, relayStart: true }),
        t.activityEntry(dose, APP_LA_TOKEN),
      ],
    });
    return t;
  }

  it("ends its running Activities when its sign-in ends", async () => {
    const t = await twoActivities();
    const deviceToken = `device-${TOKEN.slice(0, 6)}`;
    await getPrismaClient().refreshToken.create({
      data: {
        userId: t.session.userId,
        tokenHash: "sign-out-test-hash",
        deviceId: deviceToken,
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: new Date(),
      },
    });
    const before = laPushes().length;
    const { afterRefreshRevocation } =
      await import("@/lib/devices/signed-out-push");
    await afterRefreshRevocation(t.session.userId);
    expect(endedTokens(before)).toEqual([APP_LA_TOKEN, LA_TOKEN].sort());
    expect(await getPrismaClient().liveActivityToken.count()).toBe(0);
  });

  it("ends its running Activities when another account takes it over", async () => {
    await twoActivities();
    const other = await makeSession(await makeUser());
    const before = laPushes().length;
    const taken = await registerDevice(other, {
      token: `device-${TOKEN.slice(0, 6)}`,
      bundleId: "dev.healthlog.app",
      apnsToken: TOKEN,
      apnsEnvironment: "production",
    });
    expect(taken.status).toBe(201);
    expect(endedTokens(before)).toEqual([APP_LA_TOKEN, LA_TOKEN].sort());
    expect(await getPrismaClient().liveActivityToken.count()).toBe(0);
  });
});
