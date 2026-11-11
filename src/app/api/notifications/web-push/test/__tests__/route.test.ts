/**
 * The Web Push test reaches every subscribed browser of the account, in the
 * account's language, through the sender real reminders use.
 *
 * It used to send to the newest subscription only: with a phone and a laptop
 * subscribed, Test pressed on the laptop buzzed the phone and the laptop
 * looked broken. The text was English in every locale, and the push went out
 * through the library's own transport instead of the pinned `safeFetch` dial.
 *
 * The real sender runs here; the push library's signing, the dial and the
 * database are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushSubscription } from "@/generated/prisma/client";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  getVapidConfig: vi.fn(),
  safeFetch: vi.fn(),
  generateRequestDetails: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T>(fn: T) => fn,
  requireAuth: mocks.requireAuth,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    pushSubscription: {
      findMany: mocks.findMany,
      deleteMany: mocks.deleteMany,
    },
  },
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => null,
}));
vi.mock("@/lib/crypto", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/notifications/vapid-config", () => ({
  getVapidConfig: mocks.getVapidConfig,
}));
vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttemptForPayload: vi.fn(),
}));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch: mocks.safeFetch }));
vi.mock("web-push", () => ({
  setVapidDetails: vi.fn(),
  generateRequestDetails: mocks.generateRequestDetails,
}));

import { POST } from "../route";

type Handler = (request: Request) => Promise<Response>;
const post = () =>
  (POST as unknown as Handler)(
    new Request("http://localhost/api/notifications/web-push/test", {
      method: "POST",
    }),
  );

function subscription(id: string, endpoint: string): PushSubscription {
  return {
    id,
    userId: "u-1",
    endpoint,
    p256dh: "p256",
    auth: "auth",
    userAgent: null,
    createdAt: new Date(0),
  };
}

const PHONE = subscription(
  "s-phone",
  "https://fcm.googleapis.com/fcm/send/phone-secret",
);
const LAPTOP = subscription(
  "s-laptop",
  "https://updates.push.services.mozilla.com/wpush/v2/laptop-secret",
);

/** The JSON payload the sender encrypted for each subscription. */
function payloadsSent(): Array<{ title: string; body: string; tag: string }> {
  return mocks.generateRequestDetails.mock.calls.map(([, payload]) =>
    JSON.parse(String(payload)),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user: { id: "u-1", locale: "de" } });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.getVapidConfig.mockResolvedValue({
    subject: "mailto:ops@example.com",
    publicKey: "pub",
    privateKey: "priv",
  });
  mocks.findMany.mockResolvedValue([PHONE, LAPTOP]);
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.generateRequestDetails.mockImplementation(
    (sub: { endpoint: string }) => ({
      endpoint: sub.endpoint,
      method: "POST",
      headers: { TTL: "60" },
      body: null,
    }),
  );
  mocks.safeFetch.mockResolvedValue(new Response(null, { status: 201 }));
});

describe("POST /api/notifications/web-push/test", () => {
  it("sends to every subscribed browser, in the account's language", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ok: boolean; latencyMs: number };
    };
    expect(body.data.ok).toBe(true);
    expect(typeof body.data.latencyMs).toBe("number");

    expect(mocks.findMany).toHaveBeenCalledWith({ where: { userId: "u-1" } });
    expect(mocks.safeFetch.mock.calls.map(([url]) => url)).toEqual([
      PHONE.endpoint,
      LAPTOP.endpoint,
    ]);
    for (const call of mocks.safeFetch.mock.calls) {
      expect(call[2]).toEqual({ requirePublicHost: true });
    }
    expect(payloadsSent()).toEqual([
      expect.objectContaining({
        title: "HealthLog Test-Benachrichtigung",
        body: "Wenn du das siehst, kommen Push-Benachrichtigungen auf diesem Gerät an.",
        tag: "self-test",
      }),
      expect.objectContaining({ tag: "self-test" }),
    ]);
  });

  it("answers 422 not_configured when no browser is subscribed", async () => {
    mocks.findMany.mockResolvedValue([]);

    const res = await post();

    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("not_configured");
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it("answers 422 vapid_not_configured without VAPID keys", async () => {
    mocks.getVapidConfig.mockResolvedValue(null);

    const res = await post();

    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("vapid_not_configured");
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it("refuses over the rate limit without sending", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false });

    const res = await post();

    expect(res.status).toBe(429);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it("reports a rejected push without echoing an endpoint", async () => {
    mocks.safeFetch.mockResolvedValue(new Response(null, { status: 401 }));

    const res = await post();
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text).data.ok).toBe(false);
    expect(text).not.toMatch(/phone-secret|laptop-secret/);
  });
});
