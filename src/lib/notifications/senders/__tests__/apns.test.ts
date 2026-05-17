/**
 * APNs sender unit tests (v1.4.23 Wave 3 / F4).
 *
 * Drives the real `apns.ts` against a stubbed `@parse/node-apn` Provider
 * so we can exercise:
 *   1. Env-var loader — all-or-none guard, inline-PEM `\n` unescape,
 *      file-fallback path.
 *   2. Provider lazy-init + per-environment caching (sandbox vs production
 *      get distinct Provider instances; `forceProduction` overrides).
 *   3. `sendApnsPush()` permanent-failure detection (`Unregistered`,
 *      `BadDeviceToken`, `DeviceTokenNotForTopic` → `shouldDisable: true`).
 *   4. `sendViaApns()` dispatcher entry point — fan-out per device,
 *      dead-row cleanup, hard-vs-soft channel-reject classification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const shutdownMock = vi.fn();
const providerCtorMock = vi.fn();
const notificationCtorMock = vi.fn();

vi.mock("@parse/node-apn", () => {
  class Provider {
    constructor(opts: unknown) {
      providerCtorMock(opts);
    }
    send(...args: unknown[]) {
      return sendMock(...args);
    }
    shutdown() {
      return shutdownMock();
    }
  }
  class Notification {
    public topic = "";
    public alert: unknown;
    public sound: string | undefined;
    public badge: number | undefined;
    public threadId: string | undefined;
    public collapseId: string | undefined;
    public payload: unknown;
    public category: string | undefined;
    public mutableContent: boolean | undefined;
    constructor() {
      notificationCtorMock();
    }
  }
  return { default: { Provider, Notification }, Provider, Notification };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    device: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
  }),
}));

import {
  loadApnsConfig,
  resetApnsForTesting,
  sendApnsPush,
  sendViaApns,
} from "@/lib/notifications/senders/apns";
import { prisma } from "@/lib/db";

const VALID_ENV = {
  APNS_KEY_ID: "ABCDE12345",
  APNS_TEAM_ID: "TEAM123456",
  APNS_BUNDLE_ID: "test.healthlog.ios",
  APNS_KEY: "-----BEGIN PRIVATE KEY-----\\nMOCKKEY\\n-----END PRIVATE KEY-----",
};

function setEnv(over: Record<string, string | undefined> = {}): void {
  for (const k of [
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "APNS_BUNDLE_ID",
    "APNS_KEY",
    "APNS_KEY_FILE",
    "APNS_PRODUCTION",
  ]) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) process.env[k] = v;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetApnsForTesting();
  setEnv();
});

afterEach(() => {
  setEnv();
  resetApnsForTesting();
});

describe("loadApnsConfig — all-or-none env-var guard", () => {
  it("returns null and emits NO warning when nothing is set", () => {
    expect(loadApnsConfig()).toBeNull();
  });

  it("returns null when only some APNS_* vars are set", () => {
    setEnv({ APNS_KEY_ID: "only-this" });
    expect(loadApnsConfig()).toBeNull();
  });

  it("returns config when all required vars are present (inline key)", () => {
    setEnv(VALID_ENV);
    const config = loadApnsConfig();
    expect(config).toBeTruthy();
    expect(config?.bundleId).toBe("test.healthlog.ios");
    // The escaped `\n` sequences in the env string become real newlines.
    expect(config?.signingKey).toContain("\n");
    expect(config?.signingKey.split("\n").length).toBeGreaterThan(1);
  });

  it("falls back to APNS_KEY_FILE when APNS_KEY is absent", async () => {
    // Write an actual temp PEM file because ESM doesn't let us spy on
    // node:fs.readFileSync. The file content is meaningless to the test —
    // we only verify loadApnsConfig propagates it into signingKey.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpFile = path.join(
      os.tmpdir(),
      `apns-key-${Date.now()}-${Math.random().toString(36).slice(2)}.p8`,
    );
    fs.writeFileSync(tmpFile, "FILE-PEM-CONTENT");
    try {
      setEnv({
        APNS_KEY_ID: VALID_ENV.APNS_KEY_ID,
        APNS_TEAM_ID: VALID_ENV.APNS_TEAM_ID,
        APNS_BUNDLE_ID: VALID_ENV.APNS_BUNDLE_ID,
        APNS_KEY_FILE: tmpFile,
      });
      const config = loadApnsConfig();
      expect(config?.signingKey).toBe("FILE-PEM-CONTENT");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("caches the loaded config across calls", () => {
    setEnv(VALID_ENV);
    const a = loadApnsConfig();
    const b = loadApnsConfig();
    expect(a).toBe(b);
  });

  it("APNS_PRODUCTION=true sets forceProduction", () => {
    setEnv({ ...VALID_ENV, APNS_PRODUCTION: "true" });
    expect(loadApnsConfig()?.forceProduction).toBe(true);
  });
});

describe("sendApnsPush — provider lazy-init + per-gateway cache", () => {
  beforeEach(() => {
    setEnv(VALID_ENV);
    sendMock.mockResolvedValue({
      sent: [{ device: "abc" }],
      failed: [],
    });
  });

  it("creates ONE Provider per environment on first send", async () => {
    await sendApnsPush({
      deviceToken: "abc",
      environment: "sandbox",
      payload: { alert: { title: "t", body: "b" } },
    });
    await sendApnsPush({
      deviceToken: "abc",
      environment: "sandbox",
      payload: { alert: { title: "t", body: "b" } },
    });
    expect(providerCtorMock).toHaveBeenCalledTimes(1);
    expect(providerCtorMock.mock.calls[0][0]).toMatchObject({
      production: false,
      token: { key: expect.any(String), keyId: "ABCDE12345" },
    });
  });

  it("sandbox + production environments get separate Providers", async () => {
    await sendApnsPush({
      deviceToken: "a",
      environment: "sandbox",
      payload: { alert: { title: "t", body: "b" } },
    });
    await sendApnsPush({
      deviceToken: "a",
      environment: "production",
      payload: { alert: { title: "t", body: "b" } },
    });
    expect(providerCtorMock).toHaveBeenCalledTimes(2);
    expect(providerCtorMock.mock.calls[0][0].production).toBe(false);
    expect(providerCtorMock.mock.calls[1][0].production).toBe(true);
  });

  it("APNS_PRODUCTION=true funnels every send through production", async () => {
    setEnv({ ...VALID_ENV, APNS_PRODUCTION: "true" });
    await sendApnsPush({
      deviceToken: "a",
      environment: "sandbox",
      payload: { alert: { title: "t", body: "b" } },
    });
    expect(providerCtorMock.mock.calls[0][0].production).toBe(true);
  });
});

describe("sendApnsPush — failure classification", () => {
  beforeEach(() => {
    setEnv(VALID_ENV);
  });

  it("returns ok on at-least-one delivery", async () => {
    sendMock.mockResolvedValueOnce({
      sent: [{ device: "abc" }],
      failed: [],
    });
    const r = await sendApnsPush({
      deviceToken: "abc",
      environment: "sandbox",
      payload: { alert: { title: "t", body: "b" } },
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it.each([
    ["Unregistered", true],
    ["BadDeviceToken", true],
    ["DeviceTokenNotForTopic", true],
    ["TooManyRequests", false],
    ["InternalServerError", false],
  ])("reason %s → shouldDisable=%s", async (reason, shouldDisable) => {
    sendMock.mockResolvedValueOnce({
      sent: [],
      failed: [{ device: "abc", status: 410, response: { reason } }],
    });
    const r = await sendApnsPush({
      deviceToken: "abc",
      environment: "sandbox",
      payload: { alert: { title: "t", body: "b" } },
    });
    expect(r.ok).toBe(false);
    expect(r.shouldDisable).toBe(shouldDisable);
    expect(r.reason).toBe(reason);
  });

  it("network throw returns soft failure", async () => {
    sendMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const r = await sendApnsPush({
      deviceToken: "abc",
      environment: "sandbox",
      payload: { alert: { title: "t", body: "b" } },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("apns_network_error");
    expect(r.shouldDisable).toBeFalsy();
  });
});

describe("sendApnsPush — config disabled paths", () => {
  it("returns apns_not_configured when env is empty", async () => {
    setEnv();
    const r = await sendApnsPush({
      deviceToken: "abc",
      environment: "sandbox",
      payload: { alert: { title: "t", body: "b" } },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("apns_not_configured");
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("sendViaApns — dispatcher fan-out", () => {
  beforeEach(() => {
    setEnv(VALID_ENV);
  });

  it("returns soft no-recipient when the user has no APNs devices", async () => {
    vi.mocked(prisma.device.findMany).mockResolvedValueOnce([]);
    const r = await sendViaApns("u-1", {
      title: "t",
      message: "m",
      eventType: "MEDICATION_REMINDER",
    });
    expect(r.ok).toBe(false);
    expect(r.hardReject).toBe(false);
    expect(r.reason).toBe("apns_no_devices");
  });

  it("soft-fails when env is not configured (no DB lookup)", async () => {
    setEnv();
    const r = await sendViaApns("u-1", {
      title: "t",
      message: "m",
      eventType: "MEDICATION_REMINDER",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("apns_not_configured");
    expect(prisma.device.findMany).not.toHaveBeenCalled();
  });

  it("returns ok when at least one device delivered", async () => {
    vi.mocked(prisma.device.findMany).mockResolvedValueOnce([
      { id: "d1", apnsToken: "tok-a", apnsEnvironment: "sandbox" },
      { id: "d2", apnsToken: "tok-b", apnsEnvironment: "sandbox" },
    ] as never);
    sendMock
      .mockResolvedValueOnce({ sent: [{ device: "tok-a" }], failed: [] })
      .mockResolvedValueOnce({
        sent: [],
        failed: [
          {
            device: "tok-b",
            status: 410,
            response: { reason: "Unregistered" },
          },
        ],
      });
    const r = await sendViaApns("u-1", {
      title: "t",
      message: "m",
      eventType: "MEDICATION_REMINDER",
    });
    expect(r.ok).toBe(true);
    // The Unregistered device row was deleted.
    expect(prisma.device.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["d2"] } },
    });
  });

  it("hard-rejects when EVERY device returns a permanent reason", async () => {
    vi.mocked(prisma.device.findMany).mockResolvedValueOnce([
      { id: "d1", apnsToken: "tok-a", apnsEnvironment: "sandbox" },
      { id: "d2", apnsToken: "tok-b", apnsEnvironment: "production" },
    ] as never);
    sendMock
      .mockResolvedValueOnce({
        sent: [],
        failed: [
          {
            device: "tok-a",
            status: 410,
            response: { reason: "Unregistered" },
          },
        ],
      })
      .mockResolvedValueOnce({
        sent: [],
        failed: [
          {
            device: "tok-b",
            status: 400,
            response: { reason: "BadDeviceToken" },
          },
        ],
      });
    const r = await sendViaApns("u-1", {
      title: "t",
      message: "m",
      eventType: "MEDICATION_REMINDER",
    });
    expect(r.ok).toBe(false);
    expect(r.hardReject).toBe(true);
    expect(prisma.device.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["d1", "d2"] } },
    });
  });

  it("soft-fails when the failure is transient (e.g. 503)", async () => {
    vi.mocked(prisma.device.findMany).mockResolvedValueOnce([
      { id: "d1", apnsToken: "tok-a", apnsEnvironment: "sandbox" },
    ] as never);
    sendMock.mockResolvedValueOnce({
      sent: [],
      failed: [
        {
          device: "tok-a",
          status: 503,
          response: { reason: "InternalServerError" },
        },
      ],
    });
    const r = await sendViaApns("u-1", {
      title: "t",
      message: "m",
      eventType: "MEDICATION_REMINDER",
    });
    expect(r.ok).toBe(false);
    expect(r.hardReject).toBe(false);
    expect(r.reason).toBe("InternalServerError");
    // No device row deleted on transient failure.
    expect(prisma.device.deleteMany).not.toHaveBeenCalled();
  });

  it("strips HTML from the alert body before handing to APNs", async () => {
    vi.mocked(prisma.device.findMany).mockResolvedValueOnce([
      { id: "d1", apnsToken: "tok-a", apnsEnvironment: "sandbox" },
    ] as never);
    sendMock.mockResolvedValueOnce({ sent: [{ device: "tok-a" }], failed: [] });
    await sendViaApns("u-1", {
      title: "t",
      message: "<b>take</b> meds",
      eventType: "MEDICATION_REMINDER",
    });
    const note = sendMock.mock.calls[0][0];
    expect(note.alert.body).toBe("take meds");
  });

  it("forwards eventType as aps.category so iOS renders action buttons", async () => {
    // Wires the v0.5.4 contract: MEDICATION_REMINDER on the server must
    // surface as `aps.category = "MEDICATION_REMINDER"` so iOS looks up
    // the UNNotificationCategory the app registered at launch and
    // renders Take / Snooze 15 / Skip on the lock-screen.
    vi.mocked(prisma.device.findMany).mockResolvedValueOnce([
      { id: "d1", apnsToken: "tok-a", apnsEnvironment: "sandbox" },
    ] as never);
    sendMock.mockResolvedValueOnce({ sent: [{ device: "tok-a" }], failed: [] });
    await sendViaApns("u-1", {
      title: "t",
      message: "m",
      eventType: "MEDICATION_REMINDER",
      metadata: { medicationId: "med-1", scheduleId: "sched-1" },
    });
    const note = sendMock.mock.calls[0][0];
    expect(note.category).toBe("MEDICATION_REMINDER");
    expect(note.mutableContent).toBe(true);
    expect(note.threadId).toBe("MEDICATION_REMINDER");
    expect(note.payload.medicationId).toBe("med-1");
    expect(note.payload.scheduleId).toBe("sched-1");
    expect(note.payload.eventType).toBe("MEDICATION_REMINDER");
  });

  it("forwards MOOD_REMINDER eventType as aps.category too", async () => {
    // SR-2 contract: the mood-reminder daily job emits this event-type;
    // the iOS app registers a `MOOD_REMINDER` category whose only
    // action opens the mood-entry sheet.
    vi.mocked(prisma.device.findMany).mockResolvedValueOnce([
      { id: "d1", apnsToken: "tok-a", apnsEnvironment: "sandbox" },
    ] as never);
    sendMock.mockResolvedValueOnce({ sent: [{ device: "tok-a" }], failed: [] });
    await sendViaApns("u-1", {
      title: "Stimmung erfassen",
      message: "Wie geht es dir heute?",
      eventType: "MOOD_REMINDER",
      metadata: { scheduledAt: "2026-05-17T20:00:00.000Z" },
    });
    const note = sendMock.mock.calls[0][0];
    expect(note.category).toBe("MOOD_REMINDER");
    expect(note.threadId).toBe("MOOD_REMINDER");
    expect(note.payload.scheduledAt).toBe("2026-05-17T20:00:00.000Z");
  });

  it("forwards explicit category override on sendApnsPush", async () => {
    // Lower-level entry — directly setting `payload.category` must
    // propagate to `note.category` so callers that bypass `sendViaApns`
    // (e.g. an admin test endpoint) keep full control.
    setEnv(VALID_ENV);
    sendMock.mockResolvedValueOnce({ sent: [{ device: "abc" }], failed: [] });
    await sendApnsPush({
      deviceToken: "abc",
      environment: "sandbox",
      payload: {
        alert: { title: "t", body: "b" },
        category: "CUSTOM_CATEGORY",
        mutableContent: true,
      },
    });
    const note = sendMock.mock.calls[0][0];
    expect(note.category).toBe("CUSTOM_CATEGORY");
    expect(note.mutableContent).toBe(true);
  });
});
