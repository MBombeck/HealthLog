/**
 * v1.17.1 (#22) — medication-intake cross-device sync dispatcher tests.
 *
 * Exercises the server half of iOS issue #22:
 *   1. Silent background push to the user's OTHER devices (origin skip).
 *   2. APNs-only: the dispatch never reaches the dispatcher cascade, so
 *      Telegram / ntfy / Web Push senders are never imported here.
 *   3. Payload hygiene: the silent push is a pure sync trigger — event
 *      type + timestamp, no medication id / name / dose instant.
 *   4. Coalescing: the first mutation in a burst dispatches immediately,
 *      everything else folds into ONE trailing dispatch per user.
 *   5. Live Activity end push only when a `liveActivityPushToken` is stored.
 *   6. Explicit APNS-channel opt-out suppresses the fan-out.
 *   7. Failure isolation: a broken flush never throws into the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rawSendMock = vi.fn();
const loadConfigMock = vi.fn();
const recordPushAttemptMock = vi.fn();
const annotateMock = vi.fn();
const addWarningMock = vi.fn();

vi.mock("@/lib/notifications/senders/apns", () => ({
  loadApnsConfig: () => loadConfigMock(),
  sendApnsRawPush: (...args: unknown[]) => rawSendMock(...args),
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: (...args: unknown[]) => recordPushAttemptMock(...args),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: (...args: unknown[]) => annotateMock(...args),
  getEvent: () => ({ addWarning: addWarningMock, addMeta: vi.fn() }),
}));

const deviceFindMany = vi.fn();
const channelFindUnique = vi.fn();
const deviceDeleteMany = vi.fn();
const userFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
    },
    device: {
      findMany: (...a: unknown[]) => deviceFindMany(...a),
      deleteMany: (...a: unknown[]) => deviceDeleteMany(...a),
    },
    notificationChannel: {
      findUnique: (...a: unknown[]) => channelFindUnique(...a),
    },
  },
}));

import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";

const APNS_CONFIG = { bundleId: "test.healthlog.ios" };

/**
 * The queue's fan-out is fire-and-forget; drain the microtask queue so
 * the leading / trailing flush promise chains settle before asserting.
 * (Fake timers do not fake microtasks, so plain awaits drain them.)
 */
async function drainFlush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Unique per-test user id so per-user coalescing windows never leak
 *  across tests (the window map is module state by design). */
let userSeq = 0;
function nextUserId(): string {
  userSeq += 1;
  return `u-${userSeq}`;
}

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: "d-other",
    token: "other-token",
    apnsToken: "bbbb2222",
    apnsEnvironment: "sandbox",
    liveActivityPushToken: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  loadConfigMock.mockReturnValue(APNS_CONFIG);
  channelFindUnique.mockResolvedValue({ enabled: true, preferences: [] });
  rawSendMock.mockResolvedValue({ ok: true, status: 200 });
  deviceDeleteMany.mockResolvedValue({ count: 0 });
  userFindUnique.mockResolvedValue({
    deletionRequestedAt: null,
    deletionPurgeAt: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("queueMedicationIntakeSync — an account pending deletion", () => {
  // The push does not go through the dispatcher, whose chokepoint refuses a
  // pending account; an import queued before the deletion reached it.
  it("sends nothing to the devices of an account pending deletion", async () => {
    deviceFindMany.mockResolvedValue([device()]);
    userFindUnique.mockResolvedValue({
      deletionRequestedAt: new Date("2026-10-20T00:00:00Z"),
      deletionPurgeAt: new Date("2026-11-03T00:00:00Z"),
    });
    queueMedicationIntakeSync({
      userId: nextUserId(),
      originDeviceToken: null,
    });
    await drainFlush();
    expect(rawSendMock).not.toHaveBeenCalled();
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "skipped",
        reason: "deletion_pending",
      }),
    );
  });
});

describe("queueMedicationIntakeSync — origin skip + other-devices-only", () => {
  it("dispatches immediately to every device EXCEPT the origin", async () => {
    deviceFindMany.mockResolvedValue([
      device({ id: "d-origin", token: "origin-token", apnsToken: "aaaa1111" }),
      device(),
    ]);
    const userId = nextUserId();

    queueMedicationIntakeSync({ userId, originDeviceToken: "origin-token" });
    await drainFlush();

    // Exactly one push — to the non-origin device, silent background.
    expect(rawSendMock).toHaveBeenCalledTimes(1);
    const call = rawSendMock.mock.calls[0][0];
    expect(call.deviceToken).toBe("bbbb2222");
    expect(call.pushType).toBe("background");
    expect(call.priority).toBe(5);
    expect(call.payload).toMatchObject({
      aps: { "content-available": 1 },
      eventType: "MEDICATION_INTAKE_SYNC",
    });
    expect(typeof call.payload.syncedAt).toBe("string");
    // Pure sync trigger — no health data, no alert/sound/badge keys.
    expect(call.payload.medicationId).toBeUndefined();
    expect(call.payload.scheduledFor).toBeUndefined();
    expect(call.payload.aps.alert).toBeUndefined();
    expect(call.payload.aps.sound).toBeUndefined();
  });

  it("skips nothing when the origin token has no matching device (web caller)", async () => {
    deviceFindMany.mockResolvedValue([
      device({ id: "d1", token: "tok-1", apnsToken: "aaaa1111" }),
    ]);

    queueMedicationIntakeSync({
      userId: nextUserId(),
      originDeviceToken: "no-such-token",
    });
    await drainFlush();

    expect(rawSendMock).toHaveBeenCalledTimes(1);
    expect(rawSendMock.mock.calls[0][0].deviceToken).toBe("aaaa1111");
  });

  it("records a skipped attempt when only the origin device exists", async () => {
    deviceFindMany.mockResolvedValue([
      device({ id: "d-origin", token: "origin-token", apnsToken: "aaaa1111" }),
    ]);
    const userId = nextUserId();

    queueMedicationIntakeSync({ userId, originDeviceToken: "origin-token" });
    await drainFlush();

    expect(rawSendMock).not.toHaveBeenCalled();
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "APNS",
        eventType: "MEDICATION_INTAKE_SYNC",
        result: "skipped",
        reason: "intake_sync_no_other_devices",
      }),
    );
  });
});

describe("queueMedicationIntakeSync — coalescing", () => {
  it("folds a rapid burst into ONE leading + ONE trailing fan-out", async () => {
    deviceFindMany.mockResolvedValue([device()]);
    const userId = nextUserId();

    queueMedicationIntakeSync({ userId, originDeviceToken: null });
    queueMedicationIntakeSync({ userId, originDeviceToken: null });
    queueMedicationIntakeSync({ userId, originDeviceToken: null });
    await drainFlush();

    // Leading fan-out only — the burst is still inside the window.
    expect(rawSendMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await drainFlush();

    // Trailing fan-out covering the two coalesced mutations.
    expect(rawSendMock).toHaveBeenCalledTimes(2);
    expect(recordPushAttemptMock).toHaveBeenCalledTimes(2);
    expect(annotateMock).toHaveBeenLastCalledWith({
      meta: {
        medication_intake_sync_devices: 1,
        medication_intake_sync_coalesced: 2,
      },
    });
  });

  it("a single queue call (bulk route) produces exactly ONE fan-out", async () => {
    deviceFindMany.mockResolvedValue([device()]);
    const userId = nextUserId();

    queueMedicationIntakeSync({ userId, originDeviceToken: null });
    await drainFlush();
    vi.advanceTimersByTime(5_000);
    await drainFlush();

    expect(rawSendMock).toHaveBeenCalledTimes(1);
    expect(annotateMock).toHaveBeenCalledWith({
      meta: {
        medication_intake_sync_devices: 1,
        medication_intake_sync_coalesced: 0,
      },
    });
  });

  it("does not coalesce across users", async () => {
    deviceFindMany.mockResolvedValue([device()]);

    queueMedicationIntakeSync({
      userId: nextUserId(),
      originDeviceToken: null,
    });
    queueMedicationIntakeSync({
      userId: nextUserId(),
      originDeviceToken: null,
    });
    await drainFlush();

    expect(rawSendMock).toHaveBeenCalledTimes(2);
  });

  it("trailing flush keeps the origin skip when the burst has ONE origin", async () => {
    deviceFindMany.mockResolvedValue([
      device({ id: "d-origin", token: "origin-token", apnsToken: "aaaa1111" }),
      device(),
    ]);
    const userId = nextUserId();

    queueMedicationIntakeSync({ userId, originDeviceToken: "origin-token" });
    queueMedicationIntakeSync({ userId, originDeviceToken: "origin-token" });
    await drainFlush();
    vi.advanceTimersByTime(2_000);
    await drainFlush();

    // Leading + trailing, and neither ever pushed to the origin device.
    expect(rawSendMock).toHaveBeenCalledTimes(2);
    const targets = rawSendMock.mock.calls.map((c) => c[0].deviceToken);
    expect(targets).toEqual(["bbbb2222", "bbbb2222"]);
  });

  it("trailing flush wakes EVERY device when the coalesced mutations mix origins", async () => {
    deviceFindMany.mockResolvedValue([
      device({ id: "d-a", token: "origin-a", apnsToken: "aaaa1111" }),
      device({ id: "d-b", token: "origin-b", apnsToken: "bbbb2222" }),
    ]);
    const userId = nextUserId();

    queueMedicationIntakeSync({ userId, originDeviceToken: "origin-a" });
    queueMedicationIntakeSync({ userId, originDeviceToken: "origin-b" });
    queueMedicationIntakeSync({ userId, originDeviceToken: "origin-a" });
    await drainFlush();
    vi.advanceTimersByTime(2_000);
    await drainFlush();

    // Leading: excludes origin-a. Trailing covers mutations from BOTH
    // devices, so neither is skipped — each still has to learn about the
    // other's change.
    const targets = rawSendMock.mock.calls.map((c) => c[0].deviceToken);
    expect(targets).toEqual(["bbbb2222", "aaaa1111", "bbbb2222"]);
  });

  it("trailing flush excludes the origin when ONLY that device queued mutations", async () => {
    deviceFindMany.mockResolvedValue([
      device({ id: "d-a", token: "origin-a", apnsToken: "aaaa1111" }),
      device({ id: "d-b", token: "origin-b", apnsToken: "bbbb2222" }),
    ]);
    const userId = nextUserId();

    queueMedicationIntakeSync({ userId, originDeviceToken: "origin-a" });
    queueMedicationIntakeSync({ userId, originDeviceToken: "origin-b" });
    await drainFlush();
    vi.advanceTimersByTime(2_000);
    await drainFlush();

    // Leading (origin-a) → d-b. Trailing covers ONLY origin-b's
    // mutation, so it wakes just d-a: origin-b already holds its own
    // state and the leading flush already synced d-b.
    const targets = rawSendMock.mock.calls.map((c) => c[0].deviceToken);
    expect(targets).toEqual(["bbbb2222", "aaaa1111"]);
  });
});

describe("queueMedicationIntakeSync — Live Activity push", () => {
  it("sends a liveactivity end push only for devices with a stored token", async () => {
    deviceFindMany.mockResolvedValue([
      device({
        id: "d1",
        token: "tok-1",
        apnsToken: "aaaa1111",
        apnsEnvironment: "production",
        liveActivityPushToken: "la-token-1",
      }),
    ]);

    queueMedicationIntakeSync({ userId: nextUserId() });
    await drainFlush();

    // One silent + one liveactivity push.
    expect(rawSendMock).toHaveBeenCalledTimes(2);
    const types = rawSendMock.mock.calls.map((c) => c[0].pushType);
    expect(types).toEqual(["background", "liveactivity"]);

    const la = rawSendMock.mock.calls.find(
      (c) => c[0].pushType === "liveactivity",
    )![0];
    expect(la.deviceToken).toBe("la-token-1");
    expect(la.topic).toBe("test.healthlog.ios.push-type.liveactivity");
    expect(la.payload.aps.event).toBe("end");
    // ActivityKit envelope only — no health data rides along.
    expect(la.payload.medicationId).toBeUndefined();
    expect(la.payload.scheduledFor).toBeUndefined();
  });

  it("sends no liveactivity push when no token is stored", async () => {
    deviceFindMany.mockResolvedValue([
      device({ id: "d1", token: "tok-1", apnsToken: "aaaa1111" }),
    ]);

    queueMedicationIntakeSync({ userId: nextUserId() });
    await drainFlush();

    expect(rawSendMock).toHaveBeenCalledTimes(1);
    expect(rawSendMock.mock.calls[0][0].pushType).toBe("background");
  });
});

describe("queueMedicationIntakeSync — gating + failure isolation", () => {
  it("no-ops silently when APNs is not configured", async () => {
    loadConfigMock.mockReturnValue(null);

    queueMedicationIntakeSync({ userId: nextUserId() });
    await drainFlush();

    expect(deviceFindMany).not.toHaveBeenCalled();
    expect(rawSendMock).not.toHaveBeenCalled();
    expect(recordPushAttemptMock).not.toHaveBeenCalled();
  });

  it("suppresses the fan-out on an explicit APNS-channel opt-out", async () => {
    channelFindUnique.mockResolvedValue({
      enabled: true,
      preferences: [{ enabled: false }],
    });

    queueMedicationIntakeSync({ userId: nextUserId() });
    await drainFlush();

    expect(deviceFindMany).not.toHaveBeenCalled();
    expect(rawSendMock).not.toHaveBeenCalled();
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "skipped",
        reason: "intake_sync_disabled",
      }),
    );
  });

  it("suppresses when the APNS channel row itself is disabled", async () => {
    channelFindUnique.mockResolvedValue({ enabled: false, preferences: [] });

    queueMedicationIntakeSync({ userId: nextUserId() });
    await drainFlush();

    expect(rawSendMock).not.toHaveBeenCalled();
  });

  it("reaps devices APNs reports as permanently dead", async () => {
    deviceFindMany.mockResolvedValue([
      device({ id: "d-dead", token: "tok-1", apnsToken: "aaaa1111" }),
    ]);
    rawSendMock.mockResolvedValue({
      ok: false,
      reason: "BadDeviceToken",
      shouldDisable: true,
    });

    queueMedicationIntakeSync({ userId: nextUserId() });
    await drainFlush();

    expect(deviceDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["d-dead"] } },
    });
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ result: "error" }),
    );
  });

  it("never throws into the caller when the flush blows up", async () => {
    channelFindUnique.mockRejectedValue(new Error("db down"));

    expect(() =>
      queueMedicationIntakeSync({ userId: nextUserId() }),
    ).not.toThrow();
    await drainFlush();

    expect(rawSendMock).not.toHaveBeenCalled();
    expect(addWarningMock).toHaveBeenCalledWith(
      expect.stringContaining("medication_intake_sync_dispatch_failed"),
    );
  });
});
