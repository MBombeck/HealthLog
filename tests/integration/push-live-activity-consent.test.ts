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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// A switch that makes ending the relay-started Activities throw, the way a
// database error inside it would. A withdrawal must land regardless.
const endFailure = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/push-relay/live-activity-relay-end", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/push-relay/live-activity-relay-end")
    >();
  return {
    ...actual,
    endRelayStartedActivities: (deviceId: string) =>
      endFailure.on
        ? Promise.reject(new Error("end failed"))
        : actual.endRelayStartedActivities(deviceId),
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
  endFailure.on = false;
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

type StartEntry = {
  startId: string;
  medicationId: string;
  slotInstant: string;
  startedAt: string;
  state: "pending" | "accepted";
};

/**
 * The two start fields as `push.device` carries them, with the contract the
 * app relies on checked on every read: the list is always present, and the
 * last start, when named, is one of its entries and accepted.
 */
function checkedStarts(
  device: {
    liveActivityStarted: StartEntry | null;
    liveActivityStarts: StartEntry[];
  } | null,
) {
  expect(device).not.toBeNull();
  const { liveActivityStarted: started, liveActivityStarts: starts } = device!;
  expect(Array.isArray(starts)).toBe(true);
  if (started) {
    expect(started.state).toBe("accepted");
    expect(starts).toContainEqual(started);
  }
  return { started, starts };
}

/** The device's start fields on `/api/auth/me`, checked. */
async function startsOn(session: SessionFixture) {
  const { GET } = await import("@/app/api/auth/me/route");
  const me = await callRoute<{
    push: {
      device: {
        liveActivityStarted: StartEntry | null;
        liveActivityStarts: StartEntry[];
      } | null;
    };
  }>(GET, {
    method: "GET",
    route: "/api/auth/me",
    auth: session,
    headers: { "x-device-id": `device-${TOKEN.slice(0, 6)}` },
    contract: {
      skip: "the account payload's features block predates this check",
    },
  });
  return checkedStarts(me.data.push.device);
}

async function startedOnMe(session: SessionFixture) {
  return (await startsOn(session)).started;
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
  const startField = (iat = now(), startToken = START_TOKEN) => {
    const statement = {
      instanceId,
      tokenTag: base.tokenTag,
      laTokenTag: tokenTagHex(startToken) as string,
      iat,
    };
    return {
      token: startToken,
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

/**
 * A time zone in which the real clock reads 23:xx, so a dose an hour ahead
 * falls on the next local day.
 */
function lateZone(): string {
  const offset = ((23 - new Date().getUTCHours() + 36) % 24) - 12;
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
 * slot unless `row` is false (no read has put the day on the list yet),
 * and, when given, a stored dose window around it (minutes relative to the
 * slot) and the legacy weekday cadence (`daysOfWeek`, 0 = Sunday). Without one the band is the daily default. The medication has
 * the Live Activity opt-in unless `liveActivityEnabled` says otherwise.
 */
async function dueDose(
  userId: string,
  minutesFromNow: number,
  window?: { start: number; end: number },
  {
    liveActivityEnabled = true,
    tz = noonZone(),
    row = true,
    daysOfWeek,
  }: {
    liveActivityEnabled?: boolean;
    tz?: string;
    row?: boolean;
    daysOfWeek?: string;
  } = {},
) {
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
    {
      createdAt: new Date(slot.getTime() - 2 * 24 * 3600_000),
      liveActivityEnabled,
    },
    [
      {
        windowStart: time,
        windowEnd: time,
        timesOfDay: [time],
        ...(daysOfWeek !== undefined && { daysOfWeek }),
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
  if (row) {
    await getPrismaClient().medicationIntakeEvent.create({
      data: { userId, medicationId: medication.id, scheduledFor: slot },
    });
  }
  return { medication, slot, at: minutes };
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

const laPushes = () => fake.apns.filter((a) => a.pushClass === "liveactivity");

/** The device's last Live Activity start: the server's record of it. */
const lastStart = () =>
  getPrismaClient().pushRelayDelivery.findFirst({
    where: { eventType: "LIVE_ACTIVITY_START" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

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

describe("the start fields on the device block", () => {
  it("are always present: an empty list and no last start when nothing was started", async () => {
    const t = await setUp();
    const registered = await t.reg({});
    expect(
      checkedStarts(
        registered.data.push as Parameters<typeof checkedStarts>[0],
      ),
    ).toEqual({ started: null, starts: [] });
    expect(await startsOn(t.session)).toEqual({ started: null, starts: [] });
    // With the consent and the operator's switch off as well.
    vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "off");
    await t.reg({ liveActivityConsent: t.consent() });
    expect(await startsOn(t.session)).toEqual({ started: null, starts: [] });
  });
});

describe("the token flags on the device block", () => {
  type Flags = {
    liveActivityStartToken: boolean;
    liveActivityPushToken: boolean;
  };

  it("say whether the server holds each token, never the token", async () => {
    const t = await setUp();
    const bare = await t.reg({});
    expect(bare.data.push as unknown as Flags).toMatchObject({
      liveActivityStartToken: false,
      liveActivityPushToken: false,
    });
    const held = await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
      liveActivityPushToken: LA_TOKEN,
    });
    expect(held.data.push as unknown as Flags).toMatchObject({
      liveActivityStartToken: true,
      liveActivityPushToken: true,
    });
    const wire = JSON.stringify(held.data);
    expect(wire).not.toContain(START_TOKEN);
    expect(wire).not.toContain(LA_TOKEN);
  });
});

describe("the push-to-start token", () => {
  // Apple documents no fixed token length; a 256 character push-to-start
  // token failed the whole registration against a cap of 200.
  it("takes a 256 character token and never fails the registration on a bad statement", async () => {
    const t = await setUp();
    const long = "a7".repeat(128);
    const taken = await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(now(), long),
    });
    expect(taken.status).toBe(201);
    expect(taken.data.ignored).toBeUndefined();
    const row = () =>
      getPrismaClient().device.findFirstOrThrow({
        where: { apnsToken: TOKEN },
        select: { laStartToken: true, appVersion: true },
      });
    expect((await row()).laStartToken).toBe(long);

    const stale = await t.reg({
      appVersion: "9.9.9",
      liveActivityStart: t.startField(now() - 40 * 24 * 3600),
    });
    expect(stale.status).toBe(201);
    expect(stale.data.ignored).toEqual([
      { field: "liveActivityStart", code: "devices.push.statement_stale" },
    ]);
    expect(await row()).toEqual({ laStartToken: long, appVersion: "9.9.9" });

    const oversized = await t.reg({
      liveActivityStart: t.startField(now(), "b8".repeat(300)),
    });
    expect(oversized.status).toBe(201);
    expect(oversized.data.ignored).toEqual([
      { field: "liveActivityStart", code: "devices.register.invalid_field" },
    ]);
    expect((await row()).laStartToken).toBe(long);
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
      startId: (await lastStart())?.ref,
      startedAt: (await lastStart())?.createdAt.toISOString(),
      state: "accepted",
    };
    expect(
      checkedStarts(registered.data.push as Parameters<typeof checkedStarts>[0])
        .started,
    ).toEqual(started);
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

describe("a running Activity ends when the consent or the switch goes", () => {
  // A fixed noon: the dose, its band and every statement sit on one day
  // whatever the hour the suite runs at.
  const ANCHOR = new Date("2026-11-25T12:00:00Z");
  const APP_LA_TOKEN = "9e".repeat(32);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: ANCHOR });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A relay-started Activity and an app-started one, both running. */
  async function running() {
    const t = await setUp();
    await t.reg({ liveActivityConsent: t.consent() });
    const relayDose = await dueDose(t.session.userId, 30);
    const appDose = await dueDose(t.session.userId, 45);
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({
          relayStart: true,
          medicationId: relayDose.medication.id,
          slotInstant: relayDose.slot.toISOString(),
        }),
        t.activityEntry(
          {
            medicationId: appDose.medication.id,
            slotInstant: appDose.slot.toISOString(),
          },
          APP_LA_TOKEN,
        ),
      ],
    });
    return t;
  }

  const ends = () =>
    laPushes()
      .filter((p) => (p.payload.aps as { event: string }).event === "end")
      .map((p) => p.token);
  const tokensLeft = async () =>
    (
      await getPrismaClient().liveActivityToken.findMany({
        select: { pushToken: true },
      })
    ).map((r) => r.pushToken);

  it("ends the relay-started one at once when the device withdraws its Live Activity consent", async () => {
    const t = await running();
    const withdrawn = await t.reg({ liveActivityWithdraw: t.withdraw() });
    expect(withdrawn.data.push.liveActivityConsent).toBe(false);
    expect(ends()).toEqual([LA_TOKEN]);
    // The app's own Activity is the app's: it stays.
    expect(await tokensLeft()).toEqual([APP_LA_TOKEN]);
  });

  it("ends the relay-started one at once when the device withdraws its relay consent", async () => {
    const t = await running();
    await t.reg({
      relayConsent: { granted: false, textVersion: "2026-11-21" },
    });
    expect(ends()).toEqual([LA_TOKEN]);
    expect(await tokensLeft()).toEqual([APP_LA_TOKEN]);
  });

  it("stores a Live Activity withdrawal even when ending the Activities throws", async () => {
    const t = await running();
    endFailure.on = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const withdrawn = await t.reg({ liveActivityWithdraw: t.withdraw() });
    expect(withdrawn.status).toBe(201);
    expect(withdrawn.data.push.liveActivityConsent).toBe(false);
    const device = await getPrismaClient().device.findFirstOrThrow({
      select: { liveActivityConsentAt: true, liveActivityConsentVersion: true },
    });
    expect(device).toEqual({
      liveActivityConsentAt: null,
      liveActivityConsentVersion: null,
    });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("live_activity_withdraw_end_failed"),
      expect.anything(),
    );
    errors.mockRestore();
  });

  it("stores a relay withdrawal even when ending the Activities throws", async () => {
    const t = await running();
    endFailure.on = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const withdrawn = await t.reg({
      relayConsent: { granted: false, textVersion: "2026-11-21" },
    });
    expect(withdrawn.status).toBe(201);
    const device = await getPrismaClient().device.findFirstOrThrow({
      select: {
        relayState: true,
        relayConsentAt: true,
        liveActivityConsentAt: true,
      },
    });
    expect(device).toEqual({
      relayState: "none",
      relayConsentAt: null,
      liveActivityConsentAt: null,
    });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("live_activity_withdraw_end_failed"),
      expect.anything(),
    );
    errors.mockRestore();
  });

  it("ends the relay-started one on the next pass once the operator's switch is off", async () => {
    await running();
    vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "off");
    expect(await runLiveActivityRelayPass()).toMatchObject({
      started: 0,
      updated: 0,
    });
    expect(ends()).toEqual([LA_TOKEN]);
    expect(await tokensLeft()).toEqual([APP_LA_TOKEN]);
  });

  it("still ends a missed dose's Activity after the consent is gone", async () => {
    const t = await setUp();
    // Past the daily band's late tail (four hours after the slot): missed.
    const { medication, slot } = await dueDose(t.session.userId, -(4 * 60 + 5));
    await t.reg({
      liveActivityTokens: [
        t.activityEntry(
          { medicationId: medication.id, slotInstant: slot.toISOString() },
          APP_LA_TOKEN,
        ),
      ],
    });
    await runLiveActivityRelayPass();
    expect(ends()).toEqual([APP_LA_TOKEN]);
    expect(await tokensLeft()).toEqual([]);
  });
});

describe("a start or update counts once the relay accepted it", () => {
  async function retryOutbox() {
    // The outbox's next attempt, due now.
    await getPrismaClient().pushRelayDelivery.updateMany({
      where: { status: "pending" },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const { runRelayMaintenance } =
      await import("@/lib/push-relay/maintenance");
    await runRelayMaintenance();
  }

  const startsOnWire = () =>
    fake.wire.filter(
      (i) =>
        i.class === "liveactivity" &&
        (i.activity as { event?: string } | undefined)?.event === "start",
    ).length;

  it("marks a waiting start only once the relay accepts it", async () => {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    const { medication, slot } = await dueDose(t.session.userId, 30);
    // Apple is unreachable for the relay: the start waits in the outbox.
    fake.itemAnswer = (item) =>
      item.class === "liveactivity"
        ? { status: 503, error: "apns_unavailable", retryAfter: 5 }
        : null;
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    // Listed as pending from the moment the server recorded it, so an
    // Activity that shows up before the relay's answer has its name; the
    // field for builds without start ids waits for the acceptance.
    const pending = await startsOn(t.session);
    expect(pending.started).toBeNull();
    expect(pending.starts).toEqual([
      {
        startId: (await lastStart())?.ref,
        medicationId: medication.id,
        slotInstant: slot.toISOString(),
        startedAt: (await lastStart())?.createdAt.toISOString(),
        state: "pending",
      },
    ]);
    expect(await lastStart()).toMatchObject({
      status: "pending",
      acceptedAt: null,
      medicationId: medication.id,
    });
    // Held while in flight: the next pass does not start the dose twice.
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(startsOnWire()).toBe(1);

    // The retry gets through: now it counts.
    fake.itemAnswer = null;
    await retryOutbox();
    expect(laPushes()).toHaveLength(1);
    expect(await startedOnMe(t.session)).toMatchObject({
      medicationId: medication.id,
      slotInstant: slot.toISOString(),
      startId: (await lastStart())?.ref,
    });
    expect((await lastStart())?.status).toBe("accepted");
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
  });

  it("lists a start while the relay has not answered, and drops it once the relay refuses it", async () => {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    await dueDose(t.session.userId, 30);
    fake.itemAnswer = (item) =>
      item.class === "liveactivity"
        ? { status: 503, error: "apns_unavailable", retryAfter: 5 }
        : null;
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect((await startsOn(t.session)).starts).toMatchObject([
      { state: "pending" },
    ]);
    // The retry is refused for good: the start began nothing on the device,
    // so no Activity can carry its id, and it leaves the list.
    fake.itemAnswer = (item) =>
      item.class === "liveactivity"
        ? { status: 403, error: "activity_refused" }
        : null;
    await retryOutbox();
    expect((await lastStart())?.status).toBe("failed");
    expect(await startsOn(t.session)).toEqual({ started: null, starts: [] });
  });

  it("forgets a refused start and tries it again after the cool-down", async () => {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    await dueDose(t.session.userId, 30);
    fake.itemAnswer = (item) =>
      item.class === "liveactivity"
        ? { status: 403, error: "activity_refused" }
        : null;
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect((await lastStart())?.status).toBe("failed");
    expect(await startedOnMe(t.session)).toBeNull();

    // Within the cool-down nothing is tried again.
    fake.itemAnswer = null;
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(startsOnWire()).toBe(1);
    // After it, the dose starts.
    await getPrismaClient().pushRelayDelivery.updateMany({
      data: { createdAt: new Date(Date.now() - 31 * 60_000) },
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(startsOnWire()).toBe(2);
    expect(await startedOnMe(t.session)).not.toBeNull();
  });

  it("stores an update's state only once the relay accepts it", async () => {
    const t = await setUp();
    await t.reg({ liveActivityConsent: t.consent() });
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
    fake.itemAnswer = (item) =>
      item.class === "liveactivity"
        ? { status: 503, error: "apns_unavailable", retryAfter: 5 }
        : null;
    expect(await runLiveActivityRelayPass()).toMatchObject({ updated: 0 });
    const lastState = async () =>
      (await getPrismaClient().liveActivityToken.findFirstOrThrow({}))
        .lastRelayState;
    expect(await lastState()).toBeNull();
    // In flight: not sent a second time.
    await runLiveActivityRelayPass();
    expect(fake.wire.filter((i) => i.class === "liveactivity").length).toBe(1);

    fake.itemAnswer = null;
    await retryOutbox();
    expect(await lastState()).toMatchObject({ status: "overdue" });
    expect(await runLiveActivityRelayPass()).toMatchObject({ updated: 0 });
    expect(laPushes()).toHaveLength(1);
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

describe("the dose a start picks", () => {
  const startsOnWire = () =>
    laPushes().filter(
      (p) => (p.payload.aps as { event?: string }).event === "start",
    );

  async function consented() {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    return t;
  }

  it("is never a dose whose medication has the opt-in off", async () => {
    const t = await consented();
    await dueDose(t.session.userId, 30, undefined, {
      liveActivityEnabled: false,
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(laPushes()).toHaveLength(0);
    expect(await lastStart()).toBeNull();
  });

  it("is never a dose already overdue or answered", async () => {
    const t = await consented();
    // Past the daily band's on-time hour after the slot.
    await dueDose(t.session.userId, -90);
    const taken = await dueDose(t.session.userId, 20);
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: taken.medication.id },
      data: { takenAt: new Date() },
    });
    const skipped = await dueDose(t.session.userId, 25);
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: skipped.medication.id },
      data: { skipped: true },
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(laPushes()).toHaveLength(0);
  });

  it("closes where the resolver turns the dose overdue", async () => {
    const t = await consented();
    // The daily band: on time until an hour after the slot.
    const { at } = await dueDose(t.session.userId, -30);
    expect(
      await runLiveActivityRelayPass(new Date(at(60).getTime() + 1000)),
    ).toMatchObject({ started: 0 });
    expect(await runLiveActivityRelayPass(at(60))).toMatchObject({
      started: 1,
    });
  });

  it("is the earliest of several, and the next one once that is answered", async () => {
    const t = await consented();
    const later = await dueDose(t.session.userId, 70);
    const sooner = await dueDose(t.session.userId, 20);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(await lastStart()).toMatchObject({
      medicationId: sooner.medication.id,
      slotInstant: sooner.slot,
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });

    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: sooner.medication.id },
      data: { takenAt: new Date() },
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(await lastStart()).toMatchObject({
      medicationId: later.medication.id,
      slotInstant: later.slot,
    });
    expect(startsOnWire()).toHaveLength(2);
  });

  it("after a fresh consent, starts the opted-in due dose and ends the wrong one", async () => {
    // The first pass after the consent: one medication's evening dose, its
    // window an hour from the slot and its opt-in off, stands about an hour
    // and a half past that window; another medication's dose, opted in, is
    // due. The pass used to start the first and leave the second.
    const t = await consented();
    const behind = await dueDose(
      t.session.userId,
      -146,
      { start: 0, end: 60 },
      { liveActivityEnabled: false },
    );
    const due = await dueDose(t.session.userId, 6, { start: -30, end: 60 });

    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(startsOnWire()).toHaveLength(1);
    expect(
      (startsOnWire()[0]!.payload.aps as Record<string, unknown>)[
        "content-state"
      ],
    ).toMatchObject({ status: "due" });
    expect(await lastStart()).toMatchObject({
      medicationId: due.medication.id,
      slotInstant: due.slot,
    });

    // The Activity the old rule started for the wrong dose, registered by
    // the app as server-started: the pass ends it and forgets its token.
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({
          relayStart: true,
          medicationId: behind.medication.id,
          slotInstant: behind.slot.toISOString(),
        }),
      ],
    });
    const before = laPushes().length;
    await runLiveActivityRelayPass();
    expect(
      laPushes()
        .slice(before)
        .map((p) => [p.token, (p.payload.aps as { event: string }).event]),
    ).toEqual([[LA_TOKEN, "end"]]);
    expect(await getPrismaClient().liveActivityToken.count()).toBe(0);
    expect(startsOnWire()).toHaveLength(1);
  });

  it("ends a server-started Activity once its dose is gone from the schedule", async () => {
    const t = await setUp();
    await t.reg({ liveActivityConsent: t.consent() });
    const { medication, slot } = await dueDose(t.session.userId, 10);
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
    const events = (from: number) =>
      laPushes()
        .slice(from)
        .map((p) => (p.payload.aps as { event: string }).event);

    // A slot whose row is gone but which the schedule still has keeps its
    // Activity: the next today read mints the row again.
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: medication.id, scheduledFor: slot },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });
    let before = laPushes().length;
    await runLiveActivityRelayPass();
    expect(events(before)).toEqual([]);

    // The dose time is edited away, to one five hours on: nothing is due
    // at the slot any more.
    const later = hhmm(new Date(slot.getTime() + 5 * 3600_000), noonZone());
    const { PUT } = await import("@/app/api/medications/[id]/route");
    const edited = await callRoute(PUT, {
      method: "PUT",
      route: "/api/medications/{id}",
      params: { id: medication.id },
      auth: t.session,
      body: {
        schedules: [
          {
            windowStart: later,
            windowEnd: later,
            timesOfDay: [later],
            rrule: "FREQ=DAILY",
          },
        ],
      },
    });
    expect(edited.status).toBe(200);
    before = laPushes().length;
    await runLiveActivityRelayPass();
    expect(events(before)).toEqual(["end"]);
    expect(await getPrismaClient().liveActivityToken.count()).toBe(0);
  });

  it("ends a server-started Activity once its opt-in is turned off", async () => {
    const t = await setUp();
    await t.reg({ liveActivityConsent: t.consent() });
    const { medication, slot } = await dueDose(t.session.userId, 10);
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
    await getPrismaClient().medication.update({
      where: { id: medication.id },
      data: { liveActivityEnabled: false },
    });
    const before = laPushes().length;
    await runLiveActivityRelayPass();
    expect(
      laPushes()
        .slice(before)
        .map((p) => (p.payload.aps as { event: string }).event),
    ).toEqual(["end"]);
    expect(await getPrismaClient().liveActivityToken.count()).toBe(0);
  });
});

describe("who started the Activity", () => {
  const APP_LA_TOKEN = "7c".repeat(32);

  it("updates only the one the server started, and ends both", async () => {
    const t = await setUp();
    await t.reg({ liveActivityConsent: t.consent() });
    // Past the daily band's on-time hour after the slot: overdue.
    const { medication, slot, at } = await dueDose(t.session.userId, -90);
    const other = await dueDose(t.session.userId, -90);
    const dose = {
      medicationId: medication.id,
      slotInstant: slot.toISOString(),
    };
    // The app's own Activity of another dose, its own attributes type (one
    // of the same dose would end the relay one: "one owner per dose").
    const appDose = {
      medicationId: other.medication.id,
      slotInstant: other.slot.toISOString(),
    };
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({ ...dose, relayStart: true }),
        t.activityEntry(appDose, APP_LA_TOKEN),
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
        t.activityEntry(appDose, APP_LA_TOKEN),
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

    // Missed (the daily band's late tail ends four hours after the slot):
    // both end, whoever started them. Inside the statements' 12-hour life.
    const ended = laPushes().length;
    await runLiveActivityRelayPass(at(4 * 60 + 5));
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

describe("one owner per dose", () => {
  const APP_LA_TOKEN = "7c".repeat(32);
  const events = (from = 0) =>
    laPushes()
      .slice(from)
      .map((p) => [p.token, (p.payload.aps as { event: string }).event]);

  async function consented() {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    return t;
  }

  async function fresh() {
    await truncateAllTables(getPrismaClient());
    fake = new FakeRelay();
    relay.current = fake;
  }

  /** The app's own Activity of a dose, its slot `offsetS` from the stored one. */
  const appEntry = (
    t: Awaited<ReturnType<typeof setUp>>,
    medicationId: string,
    slot: Date,
    offsetS = 0,
  ) =>
    t.activityEntry(
      {
        medicationId,
        slotInstant: new Date(slot.getTime() + offsetS * 1000).toISOString(),
      },
      APP_LA_TOKEN,
    );

  it("starts nothing beside the app's own Activity of the dose", async () => {
    for (const offsetS of [0, 59, -59]) {
      await fresh();
      const t = await consented();
      const { medication, slot } = await dueDose(t.session.userId, 30);
      await t.reg({
        liveActivityTokens: [appEntry(t, medication.id, slot, offsetS)],
      });
      expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
      expect(laPushes()).toHaveLength(0);
    }
  });

  it("starts when the app's Activity shows another slot or medication", async () => {
    for (const variant of ["61s", "-61s", "other"] as const) {
      await fresh();
      const t = await consented();
      const { medication, slot } = await dueDose(t.session.userId, 30);
      const other = await dueDose(t.session.userId, 100, undefined, {
        liveActivityEnabled: false,
      });
      const entry =
        variant === "other"
          ? appEntry(t, other.medication.id, slot)
          : appEntry(t, medication.id, slot, variant === "61s" ? 61 : -61);
      await t.reg({ liveActivityTokens: [entry] });
      expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
      expect(events()).toEqual([[START_TOKEN, "start"]]);
    }
  });

  it("ends the relay one once the app's own Activity of the dose follows", async () => {
    const t = await consented();
    const { medication, slot } = await dueDose(t.session.userId, 30);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    // The app registers the relay-started Activity, then starts its own.
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true })],
    });
    const before = laPushes().length;
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({ relayStart: true }),
        appEntry(t, medication.id, slot, 30),
      ],
    });
    // Ended at once, on the registration: the relay one, never the app's.
    expect(events(before)).toEqual([[LA_TOKEN, "end"]]);
    expect(
      await getPrismaClient().liveActivityToken.findMany({
        select: { pushToken: true, relayStarted: true },
      }),
    ).toEqual([{ pushToken: APP_LA_TOKEN, relayStarted: false }]);

    // Idempotent: the next pass and the next post of the set send nothing,
    // and no second start follows.
    const after = laPushes().length;
    expect(await runLiveActivityRelayPass()).toMatchObject({
      started: 0,
      updated: 0,
    });
    await t.reg({ liveActivityTokens: [appEntry(t, medication.id, slot, 30)] });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(events(after)).toEqual([]);
  });

  it("the pass ends it when the registration's end did not go out", async () => {
    const t = await consented();
    const { medication, slot } = await dueDose(t.session.userId, 30);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true })],
    });
    // The app's row as a registration whose end never reached the relay
    // would leave it beside the relay one.
    const device = await getPrismaClient().device.findFirstOrThrow({});
    await getPrismaClient().liveActivityToken.create({
      data: {
        deviceId: device.id,
        pushToken: APP_LA_TOKEN,
        medicationId: medication.id,
        slotInstant: slot,
      },
    });
    const before = laPushes().length;
    await runLiveActivityRelayPass();
    expect(events(before)).toEqual([[LA_TOKEN, "end"]]);
    const after = laPushes().length;
    await runLiveActivityRelayPass();
    expect(events(after)).toEqual([]);
    expect(await getPrismaClient().liveActivityToken.count()).toBe(1);
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
    const other = await dueDose(t.session.userId, 10);
    // Two doses: one Activity of each kind on one dose would end the relay
    // one at once ("one owner per dose").
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({
          medicationId: medication.id,
          slotInstant: slot.toISOString(),
          relayStart: true,
        }),
        t.activityEntry(
          {
            medicationId: other.medication.id,
            slotInstant: other.slot.toISOString(),
          },
          APP_LA_TOKEN,
        ),
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

describe("a dose no read has put on the list", () => {
  async function arm() {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    return t;
  }

  it("still starts: the pass puts the dose's row in place itself", async () => {
    const t = await arm();
    const { medication, slot } = await dueDose(
      t.session.userId,
      30,
      undefined,
      {
        row: false,
      },
    );
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    const rows = await getPrismaClient().medicationIntakeEvent.findMany({
      where: { medicationId: medication.id, deletedAt: null },
    });
    expect(rows.map((r) => r.scheduledFor.getTime())).toEqual([slot.getTime()]);
    // Idempotent: the next pass mints nothing more and starts nothing again.
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(
      await getPrismaClient().medicationIntakeEvent.count({
        where: { medicationId: medication.id },
      }),
    ).toBe(1);
  });

  it("mints and starts nothing on a day the schedule skips", async () => {
    const t = await arm();
    const tz = noonZone();
    const slot = new Date(Date.now() + 30 * 60_000);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
        .format(slot)
        .slice(0, 3),
    );
    const { medication } = await dueDose(t.session.userId, 30, undefined, {
      tz,
      row: false,
      daysOfWeek: `${(weekday + 2) % 7},${(weekday + 4) % 7}`,
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(
      await getPrismaClient().medicationIntakeEvent.count({
        where: { medicationId: medication.id },
      }),
    ).toBe(0);
  });

  it("mints no second row beside a dose already taken, and starts nothing", async () => {
    const t = await arm();
    const { medication } = await dueDose(t.session.userId, 30);
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: medication.id },
      data: { takenAt: new Date() },
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(
      await getPrismaClient().medicationIntakeEvent.count({
        where: { medicationId: medication.id },
      }),
    ).toBe(1);
  });

  it("starts a dose just past local midnight from the evening before", async () => {
    const t = await arm();
    const { medication, slot } = await dueDose(
      t.session.userId,
      60,
      undefined,
      {
        tz: lateZone(),
        row: false,
      },
    );
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    // Beside today's own slot, which the day's projection puts in place too.
    const rows = await getPrismaClient().medicationIntakeEvent.findMany({
      where: { medicationId: medication.id, deletedAt: null },
    });
    expect(rows.map((r) => r.scheduledFor.getTime())).toContain(slot.getTime());
  });
});

describe("once per dose, from the server's own start record", () => {
  const startsOnWire = () =>
    laPushes().filter(
      (p) => (p.payload.aps as { event?: string }).event === "start",
    );

  async function consented() {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    return t;
  }

  it("starts a dose at its lead time and never again before the device reports it", async () => {
    const t = await consented();
    const dose = await dueDose(t.session.userId, 100);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    // Pending turns due at the slot, then five and twenty minutes on: the
    // device has reported no Activity token, and nothing starts twice.
    for (const minutes of [0, 5, 20]) {
      expect(await runLiveActivityRelayPass(dose.at(minutes))).toMatchObject({
        started: 0,
      });
    }
    expect(startsOnWire()).toHaveLength(1);
  });

  it("gives a dose back when a start for an earlier dose ended its Activity, and starts it again once that one is done", async () => {
    const t = await consented();
    // The first dose starts at its lead time.
    const first = await dueDose(t.session.userId, 30, { start: -30, end: 90 });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    // A dose with an earlier slot shows up due (its row written late): it
    // is the earliest now. The first one's Activity is not registered yet,
    // so it cannot be ended, and nothing starts beside it.
    const earlier = await dueDose(t.session.userId, -20);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    // Once the app registered it, the pass ends it and starts the earlier
    // dose, which becomes the device's last start.
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true })],
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(await lastStart()).toMatchObject({
      medicationId: earlier.medication.id,
    });
    // The first dose's Activity was ended to make room, not because there
    // was nothing left to show: its start gave the dose back. Once the
    // earlier one is overdue, the first is the earliest startable again and
    // starts anew, once.
    expect(await runLiveActivityRelayPass(earlier.at(61))).toMatchObject({
      started: 1,
    });
    expect(await lastStart()).toMatchObject({
      medicationId: first.medication.id,
    });
    for (const minutes of [66, 81]) {
      expect(await runLiveActivityRelayPass(earlier.at(minutes))).toMatchObject(
        { started: 0 },
      );
    }
    expect(startsOnWire()).toHaveLength(3);
    expect(first.slot.getTime()).toBeGreaterThan(earlier.slot.getTime());
  });

  it("starts a dose again once its take is undone while it is still in its window", async () => {
    const t = await consented();
    const dose = await dueDose(t.session.userId, 20);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true })],
    });
    const prisma = getPrismaClient();
    const row = await prisma.medicationIntakeEvent.findFirstOrThrow({
      where: { medicationId: dose.medication.id, deletedAt: null },
    });

    // Taken on the web: the Activity of the dose ends.
    const { POST } = await import("@/app/api/medications/intake/route");
    const taken = await callRoute(POST, {
      method: "POST",
      route: "/api/medications/intake",
      auth: t.session,
      body: { intakeId: row.id, status: "taken" },
    });
    expect(taken.status).toBe(200);
    await vi.waitFor(
      async () => expect(await prisma.liveActivityToken.count()).toBe(0),
      { timeout: 10_000 },
    );
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });

    // The take was a mistake and is deleted: the dose is open and in its
    // window again, so its Activity comes back.
    const { DELETE } =
      await import("@/app/api/medications/[id]/intake/[eventId]/route");
    const undone = await callRoute(DELETE, {
      method: "DELETE",
      route: "/api/medications/{id}/intake/{eventId}",
      params: { id: dose.medication.id, eventId: row.id },
      auth: t.session,
    });
    expect(undone.status).toBe(200);
    // The web reads its today list again, which brings the slot back as
    // pending beside the tombstone.
    const { GET } = await import("@/app/api/medications/intake/route");
    const today = await callRoute(GET, {
      method: "GET",
      route: "/api/medications/intake",
      query: { scope: "today" },
      auth: t.session,
    });
    expect(today.status).toBe(200);
    await vi.waitFor(
      async () =>
        expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 }),
      { timeout: 10_000 },
    );
    expect(startsOnWire()).toHaveLength(2);
  });

  it("holds the dose across a restart, and starts a different dose", async () => {
    const t = await consented();
    const dose = await dueDose(t.session.userId, 20);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });

    // A fresh process: no module state survives, only the database.
    vi.resetModules();
    const fresh = await import("@/lib/push-relay/live-activity");
    expect(await fresh.runLiveActivityRelayPass(dose.at(0))).toMatchObject({
      started: 0,
    });
    expect(startsOnWire()).toHaveLength(1);

    // The dose is answered; the next one is a different dose and starts.
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: dose.medication.id },
      data: { takenAt: new Date() },
    });
    const next = await dueDose(t.session.userId, 40);
    expect(await fresh.runLiveActivityRelayPass()).toMatchObject({
      started: 1,
    });
    expect(
      await getPrismaClient().pushRelayDelivery.findMany({
        where: { eventType: "LIVE_ACTIVITY_START" },
        select: { medicationId: true },
        orderBy: { createdAt: "asc" },
      }),
    ).toEqual([
      { medicationId: dose.medication.id },
      { medicationId: next.medication.id },
    ]);
  });
});

describe("one relay-started Activity per device", () => {
  const B_TOKEN = "8d".repeat(32);
  const events = (from = 0) =>
    laPushes()
      .slice(from)
      .map((p) => [p.token, (p.payload.aps as { event: string }).event]);
  const tokens = () =>
    getPrismaClient().liveActivityToken.findMany({
      orderBy: { pushToken: "asc" },
      select: { pushToken: true, medicationId: true, slotInstant: true },
    });

  async function consented() {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    return t;
  }

  /** The end path a take runs (`medication-intake-sync.ts`), for one device. */
  async function endAnswered(userId: string) {
    const { ACTIVITY_DEVICE_SELECT, endAnsweredActivities, memoEndState } =
      await import("@/lib/notifications/live-activity-answered");
    const { loadPushContext } = await import("@/lib/push-relay/route-device");
    const device = await getPrismaClient().device.findFirstOrThrow({
      where: { apnsToken: TOKEN },
      select: ACTIVITY_DEVICE_SELECT,
    });
    return endAnsweredActivities(
      device,
      { ctx: await loadPushContext(), bundleId: null },
      memoEndState(userId),
    );
  }

  it("ends the running one before it starts the next dose, and names each token's own dose", async () => {
    const t = await consented();
    // C is due now and turns overdue an hour after its slot; B comes 90
    // minutes after C.
    const c = await dueDose(t.session.userId, -50);
    const b = await dueDose(t.session.userId, 40);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(events()).toEqual([[START_TOKEN, "start"]]);
    // The app registers C's Activity without its dose: the one relay start
    // running is C's.
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true })],
    });
    expect(await tokens()).toEqual([
      {
        pushToken: LA_TOKEN,
        medicationId: c.medication.id,
        slotInstant: c.slot,
      },
    ]);

    // C overdue, B startable: C ends first, then B starts, in one pass.
    const before = laPushes().length;
    expect(await runLiveActivityRelayPass(c.at(61))).toMatchObject({
      started: 1,
    });
    expect(events(before)).toEqual([
      [LA_TOKEN, "end"],
      [START_TOKEN, "start"],
    ]);
    expect(await tokens()).toEqual([]);

    // B's Activity, registered without its dose, is B's.
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true }, B_TOKEN)],
    });
    expect(await tokens()).toEqual([
      {
        pushToken: B_TOKEN,
        medicationId: b.medication.id,
        slotInstant: b.slot,
      },
    ]);

    // Taking C ends nothing of B's.
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: c.medication.id },
      data: { takenAt: new Date() },
    });
    const afterC = laPushes().length;
    expect((await endAnswered(t.session.userId)).activityIds).toEqual([]);
    expect(await runLiveActivityRelayPass(c.at(62))).toMatchObject({
      started: 0,
    });
    expect(events(afterC).filter(([, e]) => e === "end")).toEqual([]);
    // Taking B ends B's.
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: b.medication.id },
      data: { takenAt: new Date() },
    });
    expect((await endAnswered(t.session.userId)).activityIds).toHaveLength(1);
    expect(events(afterC).filter(([, e]) => e === "end")).toEqual([
      [B_TOKEN, "end"],
    ]);
  });

  it("starts nothing new while the running one's end is not taken", async () => {
    const t = await consented();
    const c = await dueDose(t.session.userId, -50);
    await dueDose(t.session.userId, 40);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true })],
    });
    // The relay refuses the end (a statement it no longer accepts): C keeps
    // running, so B does not start beside it.
    await getPrismaClient().liveActivityToken.updateMany({
      data: { activitySignature: Buffer.alloc(64, 1).toString("base64url") },
    });
    const before = laPushes().length;
    expect(await runLiveActivityRelayPass(c.at(61))).toMatchObject({
      started: 0,
    });
    expect(events(before)).toEqual([]);
    expect(await getPrismaClient().liveActivityToken.count()).toBe(1);
  });

  it("names no dose when the records show more than one relay start", async () => {
    const t = await consented();
    const c = await dueDose(t.session.userId, -50);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    // Two relay-started Activities posted without their dose, as a device
    // left from before this rule reports them: neither is guessed.
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({ relayStart: true }),
        t.activityEntry({ relayStart: true }, B_TOKEN),
      ],
    });
    expect(await tokens()).toEqual([
      { pushToken: LA_TOKEN, medicationId: null, slotInstant: null },
      { pushToken: B_TOKEN, medicationId: null, slotInstant: null },
    ]);
    // One registered for C, and a last start for another dose on record:
    // a third token without its dose is not guessed either.
    const other = await dueDose(t.session.userId, 30);
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({
          relayStart: true,
          medicationId: c.medication.id,
          slotInstant: c.slot.toISOString(),
        }),
      ],
    });
    await getPrismaClient().pushRelayDelivery.create({
      data: {
        deviceId: (
          await getPrismaClient().device.findFirstOrThrow({
            where: { apnsToken: TOKEN },
          })
        ).id,
        ref: "las-other",
        pushClass: "liveactivity",
        eventType: "LIVE_ACTIVITY_START",
        status: "accepted",
        expiresAt: new Date(Date.now() + 15 * 60_000),
        acceptedAt: new Date(),
        medicationId: other.medication.id,
        slotInstant: other.slot,
      },
    });
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({
          relayStart: true,
          medicationId: c.medication.id,
          slotInstant: c.slot.toISOString(),
        }),
        t.activityEntry({ relayStart: true }, B_TOKEN),
      ],
    });
    expect((await tokens()).find((r) => r.pushToken === B_TOKEN)).toMatchObject(
      { medicationId: null },
    );

    // The pass ends what it cannot name, and both relay-started ones go
    // before anything new starts.
    const before = laPushes().length;
    await runLiveActivityRelayPass();
    expect(events(before)).toContainEqual([B_TOKEN, "end"]);
    expect(
      await getPrismaClient().liveActivityToken.count({
        where: { medicationId: null },
      }),
    ).toBe(0);
  });

  /** The state the resolver gives the open dose of `medicationId` at `at`. */
  async function stateAt(userId: string, medicationId: string, at: Date) {
    const { openActivityDoses } =
      await import("@/lib/push-relay/live-activity");
    const [dose] = await openActivityDoses(userId, at, medicationId);
    return dose?.resolved.state ?? null;
  }

  it("lets an upgraded device start again: a last start past its dose's window holds nothing", async () => {
    const t = await consented();
    // As a server upgraded across migrations 0560 and 0566 finds it: the
    // device's last relay start was for B, accepted hours ago and never
    // registered, its dose never answered and now past its window but not
    // yet missed; the app no longer registers any Activity; and the start
    // rows from before 0560 carry no dose.
    const b = await dueDose(t.session.userId, -100, { start: -30, end: 30 });
    const c = await dueDose(t.session.userId, 4);
    const db = getPrismaClient();
    const device = await db.device.findFirstOrThrow({
      where: { apnsToken: TOKEN },
    });
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
    for (const [ref, at] of [
      ["las-legacy-b", hoursAgo(4)],
      ["las-legacy-2", hoursAgo(4.3)],
      ["las-legacy-3", hoursAgo(7.5)],
      ["las-legacy-4", hoursAgo(18)],
    ] as const) {
      await db.pushRelayDelivery.create({
        data: {
          deviceId: device.id,
          ref,
          pushClass: "liveactivity",
          eventType: "LIVE_ACTIVITY_START",
          status: "accepted",
          expiresAt: at,
          acceptedAt: at,
          createdAt: at,
          ...(ref === "las-legacy-b" && {
            medicationId: b.medication.id,
            slotInstant: b.slot,
          }),
        },
      });
    }
    expect(await db.liveActivityToken.count()).toBe(0);
    expect(await stateAt(t.session.userId, b.medication.id, new Date())).toBe(
      "overdue",
    );

    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(await lastStart()).toMatchObject({
      medicationId: c.medication.id,
      slotInstant: c.slot,
    });
  });

  it("holds a second dose while an unreported start's dose is in its window, then starts it", async () => {
    const t = await consented();
    const a = await dueDose(t.session.userId, 30, { start: -30, end: 30 });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    // B is the earliest startable dose now, but A's Activity is not
    // registered: it cannot be ended, so B waits.
    const b = await dueDose(t.session.userId, 20, { start: -30, end: 90 });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(await runLiveActivityRelayPass(a.at(25))).toMatchObject({
      started: 0,
    });
    // Past A's window nothing more is to be expected of that start: B goes.
    expect(await stateAt(t.session.userId, a.medication.id, a.at(31))).toBe(
      "overdue",
    );
    expect(await runLiveActivityRelayPass(a.at(31))).toMatchObject({
      started: 1,
    });
    // Once per dose still holds for both.
    expect(await runLiveActivityRelayPass(a.at(36))).toMatchObject({
      started: 0,
    });
    const starts = await getPrismaClient().pushRelayDelivery.findMany({
      where: { eventType: "LIVE_ACTIVITY_START" },
      orderBy: { createdAt: "asc" },
      select: { medicationId: true },
    });
    expect(starts).toEqual([
      { medicationId: a.medication.id },
      { medicationId: b.medication.id },
    ]);
  });

  it("holds nothing once the app no longer registers the started Activity", async () => {
    const t = await consented();
    const a = await dueDose(t.session.userId, 30, { start: -30, end: 30 });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true })],
    });
    expect(await tokens()).toEqual([
      {
        pushToken: LA_TOKEN,
        medicationId: a.medication.id,
        slotInstant: a.slot,
      },
    ]);
    // The person dismissed it: the app's next post lists no Activity.
    await t.reg({ liveActivityTokens: [] });
    const b = await dueDose(t.session.userId, 20, { start: -30, end: 90 });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(await lastStart()).toMatchObject({ medicationId: b.medication.id });
  });

  it("holds nothing past the system's Live Activity lifetime", async () => {
    const t = await consented();
    // A dose with a long window, started more than eight hours ago and never
    // registered: the system has ended that Activity by now.
    const a = await dueDose(t.session.userId, -500, { start: -30, end: 600 });
    await getPrismaClient().pushRelayDelivery.create({
      data: {
        deviceId: (
          await getPrismaClient().device.findFirstOrThrow({
            where: { apnsToken: TOKEN },
          })
        ).id,
        ref: "las-old",
        pushClass: "liveactivity",
        eventType: "LIVE_ACTIVITY_START",
        status: "accepted",
        expiresAt: a.at(-20),
        acceptedAt: a.at(-20),
        createdAt: a.at(-20),
        medicationId: a.medication.id,
        slotInstant: a.slot,
      },
    });
    expect(await stateAt(t.session.userId, a.medication.id, new Date())).toBe(
      "due",
    );
    // B, earlier still and due, is the dose the pass picks.
    const b = await dueDose(t.session.userId, -510, { start: -30, end: 600 });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(await lastStart()).toMatchObject({ medicationId: b.medication.id });
  });

  it("is not held back by a registered Activity the relay can no longer end", async () => {
    const t = await consented();
    const a = await dueDose(t.session.userId, -50);
    await dueDose(t.session.userId, 40);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true })],
    });
    // Registered more than twelve hours ago: past the relay's statement
    // window and the system's lifetime, it cannot be ended and is over.
    const db = getPrismaClient();
    const [row] = await db.liveActivityToken.findMany();
    await db.liveActivityToken.update({
      where: { id: row!.id },
      data: {
        activityStatement: {
          ...(row!.activityStatement as Record<string, unknown>),
          iat: now() - 13 * 3600,
        },
      },
    });
    expect(await runLiveActivityRelayPass(a.at(61))).toMatchObject({
      started: 1,
    });
  });

  it("names no dose when no relay start is on record", async () => {
    const t = await consented();
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true })],
    });
    expect(await tokens()).toEqual([
      { pushToken: LA_TOKEN, medicationId: null, slotInstant: null },
    ]);
    await runLiveActivityRelayPass();
    expect(events()).toEqual([[LA_TOKEN, "end"]]);
    expect(await tokens()).toEqual([]);
  });
});

describe("one Live Activity per dose, named by its start id", () => {
  const A_TOKEN = "7c".repeat(32);
  const B_TOKEN = "9e".repeat(32);
  const starts = () =>
    laPushes().filter(
      (p) => (p.payload.aps as { event?: string }).event === "start",
    );
  /** The start id the relay wrote into the n-th start's attributes. */
  const startIdOf = (n: number) =>
    (starts()[n]!.payload.aps as { attributes: { s?: string } }).attributes.s;
  const ends = (from = 0) =>
    laPushes()
      .slice(from)
      .filter((p) => (p.payload.aps as { event?: string }).event === "end")
      .map((p) => p.token);
  const tokens = () =>
    getPrismaClient().liveActivityToken.findMany({
      orderBy: { pushToken: "asc" },
      select: {
        pushToken: true,
        medicationId: true,
        slotInstant: true,
        relayStarted: true,
      },
    });
  const device = () =>
    getPrismaClient().device.findFirstOrThrow({ where: { apnsToken: TOKEN } });

  const startsOnMe = async (session: SessionFixture) =>
    (await startsOn(session)).starts;

  /** The end path a take runs (`medication-intake-sync.ts`), for one device. */
  async function endAnswered(userId: string) {
    const { ACTIVITY_DEVICE_SELECT, endAnsweredActivities, memoEndState } =
      await import("@/lib/notifications/live-activity-answered");
    const { loadPushContext } = await import("@/lib/push-relay/route-device");
    const row = await getPrismaClient().device.findFirstOrThrow({
      where: { apnsToken: TOKEN },
      select: ACTIVITY_DEVICE_SELECT,
    });
    return endAnsweredActivities(
      row,
      { ctx: await loadPushContext(), bundleId: null },
      memoEndState(userId),
    );
  }

  async function consented() {
    const t = await setUp();
    await t.reg({
      liveActivityConsent: t.consent(),
      liveActivityStart: t.startField(),
    });
    fake.startIds = true;
    return t;
  }

  /** Two doses five minutes apart, both started and registered by id. */
  async function bothRunning() {
    const t = await consented();
    const a = await dueDose(t.session.userId, 20);
    const b = await dueDose(t.session.userId, 25);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    // The app reads the start id off the Activity and reports it.
    await t.reg({
      liveActivityTokens: [t.activityEntry({ startId: startIdOf(0) }, A_TOKEN)],
    });
    expect((await device()).laStartIdsAt).not.toBeNull();
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(ends()).toEqual([]);
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({ startId: startIdOf(0) }, A_TOKEN),
        t.activityEntry({ startId: startIdOf(1) }, B_TOKEN),
      ],
    });
    return { t, a, b };
  }

  it("gives two doses five minutes apart an Activity each, named by its start", async () => {
    const { t, a, b } = await bothRunning();
    expect(starts()).toHaveLength(2);
    expect(startIdOf(0)).toMatch(/^las-[A-Za-z0-9_-]{22}$/);
    expect(startIdOf(1)).not.toBe(startIdOf(0));
    expect(await tokens()).toEqual([
      {
        pushToken: A_TOKEN,
        medicationId: a.medication.id,
        slotInstant: a.slot,
        relayStarted: true,
      },
      {
        pushToken: B_TOKEN,
        medicationId: b.medication.id,
        slotInstant: b.slot,
        relayStarted: true,
      },
    ]);
    expect(await startsOnMe(t.session)).toEqual([
      {
        startId: startIdOf(0),
        medicationId: a.medication.id,
        slotInstant: a.slot.toISOString(),
        startedAt: expect.any(String),
        state: "accepted",
      },
      {
        startId: startIdOf(1),
        medicationId: b.medication.id,
        slotInstant: b.slot.toISOString(),
        startedAt: expect.any(String),
        state: "accepted",
      },
    ]);
    // Each dose once: no further start, while both run.
    expect(await runLiveActivityRelayPass(a.at(0))).toMatchObject({
      started: 0,
    });
    expect(ends()).toEqual([]);
  });

  it("names the dose from the start, whatever dose the app sends with it", async () => {
    const t = await consented();
    const a = await dueDose(t.session.userId, 20);
    const other = await dueDose(t.session.userId, 90);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    await t.reg({
      liveActivityTokens: [
        t.activityEntry(
          {
            startId: startIdOf(0),
            relayStart: true,
            medicationId: other.medication.id,
            slotInstant: other.slot.toISOString(),
          },
          A_TOKEN,
        ),
      ],
    });
    expect(await tokens()).toEqual([
      {
        pushToken: A_TOKEN,
        medicationId: a.medication.id,
        slotInstant: a.slot,
        relayStarted: true,
      },
    ]);
  });

  it("ends one dose's Activity without touching the other's", async () => {
    const { t, a, b } = await bothRunning();
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: a.medication.id },
      data: { takenAt: new Date() },
    });
    const before = laPushes().length;
    expect((await endAnswered(t.session.userId)).activityIds).toHaveLength(1);
    expect(ends(before)).toEqual([A_TOKEN]);
    expect((await tokens()).find((r) => r.pushToken === B_TOKEN)).toMatchObject(
      { medicationId: b.medication.id },
    );
    // The pass leaves B running: it is due now, and it updates.
    const pass = await runLiveActivityRelayPass(b.at(0));
    expect(pass).toMatchObject({ started: 0, updated: 1 });
    expect(ends(before)).toEqual([A_TOKEN]);
    expect(await startsOnMe(t.session)).toEqual([
      expect.objectContaining({
        startId: startIdOf(1),
        medicationId: b.medication.id,
      }),
    ]);
  });

  it("keeps every start and its dose across a restart and the app's next report", async () => {
    const { t, a, b } = await bothRunning();
    const named = await tokens();

    // A fresh process: only the database is left.
    vi.resetModules();
    const fresh = await import("@/lib/push-relay/live-activity");
    expect(await fresh.runLiveActivityRelayPass(a.at(0))).toMatchObject({
      started: 0,
    });
    // The app relaunches and posts its set again, by start id.
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({ startId: startIdOf(1) }, B_TOKEN),
        t.activityEntry({ startId: startIdOf(0) }, A_TOKEN),
      ],
    });
    expect(await tokens()).toEqual(named);
    expect(await fresh.runLiveActivityRelayPass(b.at(0))).toMatchObject({
      started: 0,
    });
    expect(starts()).toHaveLength(2);
    expect(ends()).toEqual([]);
  });

  it("starts no more than four Activities on a device at once", async () => {
    const t = await consented();
    await getPrismaClient().device.updateMany({
      data: { laStartIdsAt: new Date() },
    });
    for (const minutes of [10, 12, 14, 16, 18]) {
      await dueDose(t.session.userId, minutes);
    }
    for (let pass = 0; pass < 6; pass++) {
      await runLiveActivityRelayPass();
    }
    // Four started and not reported yet: the fifth dose waits.
    expect(starts()).toHaveLength(4);
    expect(ends()).toEqual([]);
  });

  it("keeps an app that sends no start id to one relay-started Activity", async () => {
    const t = await consented();
    const a = await dueDose(t.session.userId, 20);
    await dueDose(t.session.userId, 25);
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    // A build that reads no `s` registers the Activity without it.
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true }, A_TOKEN)],
    });
    expect((await device()).laStartIdsAt).toBeNull();
    expect(await tokens()).toMatchObject([
      { pushToken: A_TOKEN, medicationId: a.medication.id },
    ]);
    // The later dose does not start beside it, and nothing ends A for it.
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(ends()).toEqual([]);

    // A device that reported start ids before and now reports a
    // relay-started Activity without one goes back to that rule too.
    await t.reg({
      liveActivityTokens: [t.activityEntry({ startId: startIdOf(0) }, A_TOKEN)],
    });
    expect((await device()).laStartIdsAt).not.toBeNull();
    await t.reg({
      liveActivityTokens: [t.activityEntry({ relayStart: true }, A_TOKEN)],
    });
    expect((await device()).laStartIdsAt).toBeNull();
    expect(await tokens()).toMatchObject([
      { pushToken: A_TOKEN, medicationId: a.medication.id },
    ]);
  });

  it("names no dose for a start id it does not hold, and the pass ends that Activity", async () => {
    const t = await consented();
    await t.reg({
      liveActivityTokens: [
        t.activityEntry({ startId: "las-01KAAAAAAAAAAAAAAAAAAAAAAA" }, A_TOKEN),
      ],
    });
    expect(await tokens()).toEqual([
      {
        pushToken: A_TOKEN,
        medicationId: null,
        slotInstant: null,
        relayStarted: true,
      },
    ]);
    await runLiveActivityRelayPass();
    expect(ends()).toEqual([A_TOKEN]);
    expect(await tokens()).toEqual([]);
  });
});
