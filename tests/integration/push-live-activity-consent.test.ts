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
 * the slot). Without one the band is the daily default. The medication has
 * the Live Activity opt-in unless `liveActivityEnabled` says otherwise.
 */
async function dueDose(
  userId: string,
  minutesFromNow: number,
  window?: { start: number; end: number },
  { liveActivityEnabled = true }: { liveActivityEnabled?: boolean } = {},
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
    {
      createdAt: new Date(slot.getTime() - 2 * 24 * 3600_000),
      liveActivityEnabled,
    },
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
    expect(await startedOnMe(t.session)).toBeNull();
    const held = await getPrismaClient().device.findFirstOrThrow({
      where: { apnsToken: TOKEN },
    });
    expect(held.laStartedAt).toBeNull();
    expect(held.laStartRef).not.toBeNull();
    // Held while in flight: the next pass does not start the dose twice.
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
    expect(startsOnWire()).toBe(1);

    // The retry gets through: now it counts.
    fake.itemAnswer = null;
    await retryOutbox();
    expect(laPushes()).toHaveLength(1);
    expect(await startedOnMe(t.session)).toEqual({
      medicationId: medication.id,
      slotInstant: slot.toISOString(),
    });
    const started = await getPrismaClient().device.findFirstOrThrow({
      where: { apnsToken: TOKEN },
    });
    expect(started.laStartedAt).not.toBeNull();
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });
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
    const cleared = await getPrismaClient().device.findFirstOrThrow({
      where: { apnsToken: TOKEN },
    });
    expect(cleared).toMatchObject({
      laStartedMedicationId: null,
      laStartedSlot: null,
      laStartedAt: null,
      laStartRef: null,
    });
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
  const deviceRow = () =>
    getPrismaClient().device.findFirstOrThrow({ where: { apnsToken: TOKEN } });
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
    expect((await deviceRow()).laStartedMedicationId).toBeNull();
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
    expect(await deviceRow()).toMatchObject({
      laStartedMedicationId: sooner.medication.id,
      laStartedSlot: sooner.slot,
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 0 });

    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { medicationId: sooner.medication.id },
      data: { takenAt: new Date() },
    });
    expect(await runLiveActivityRelayPass()).toMatchObject({ started: 1 });
    expect(await deviceRow()).toMatchObject({
      laStartedMedicationId: later.medication.id,
      laStartedSlot: later.slot,
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
    expect(await deviceRow()).toMatchObject({
      laStartedMedicationId: due.medication.id,
      laStartedSlot: due.slot,
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

  it("keeps a dose started once when a start for another dose replaced the device's record", async () => {
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
    expect(
      await getPrismaClient().device.findFirstOrThrow({
        where: { apnsToken: TOKEN },
      }),
    ).toMatchObject({ laStartedMedicationId: earlier.medication.id });
    // Once that one is overdue, the first is the earliest startable again.
    // It already runs: no second start, at the turn or later.
    for (const minutes of [61, 66, 81]) {
      expect(await runLiveActivityRelayPass(earlier.at(minutes))).toMatchObject(
        { started: 0 },
      );
    }
    expect(startsOnWire()).toHaveLength(2);
    expect(first.slot.getTime()).toBeGreaterThan(earlier.slot.getTime());
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
    await getPrismaClient().device.updateMany({
      data: {
        laStartedMedicationId: other.medication.id,
        laStartedSlot: other.slot,
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
