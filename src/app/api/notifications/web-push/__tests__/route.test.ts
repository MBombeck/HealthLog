/**
 * `/api/notifications/web-push` — the refusal has to say which rule was broken.
 *
 * Both handlers used to answer a flat `apiError("Invalid data", 422)` and throw
 * the Zod issues away. A non-HTTPS endpoint, an endpoint aimed at an internal
 * host, an over-long one and a missing subscription key all produced the same
 * three words, so a browser whose subscription was refused could not tell a
 * fixable mistake from a policy it would never satisfy.
 *
 * The cases below assert on CONTENT rather than status. A status-only test
 * passes just as happily against the flat error it replaces, which is the whole
 * reason the defect survived this long.
 *
 * The other half is what must NOT come back. The endpoint is the routing secret
 * for a subscription and `keys` is crypto material, so the last test pins that
 * neither reaches the wire: `sanitiseZodIssues` emits `path`, `code` and
 * `message` only, and every message this schema can produce is a fixed string
 * or a length/format default rather than an interpolation of the value.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    // The route reads the operator's instance-wide Web Push switch before it
    // touches the body; the default stub leaves it on so these cases keep
    // asserting the validation refusals they were written for.
    appSettings: { findUnique: vi.fn() },
    pushSubscription: { upsert: vi.fn(), deleteMany: vi.fn() },
    notificationChannel: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

vi.mock("@/lib/crypto", () => ({ encrypt: (v: string) => `enc(${v})` }));

import type {
  NotificationChannel,
  PushSubscription,
} from "@/generated/prisma/client";
import { POST, DELETE } from "../route";
import { requireAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";

const USER = { id: "user-1", username: "u" };

const STORED_SUBSCRIPTION: PushSubscription = {
  id: "sub-1",
  userId: USER.id,
  endpoint: "https://fcm.googleapis.com/fcm/send/abcdef-routing-secret",
  p256dh: "enc(BPkey)",
  auth: "enc(authsecret)",
  userAgent: null,
  createdAt: new Date(0),
};

function channelRow(over: Partial<NotificationChannel>): NotificationChannel {
  return {
    id: "ch-1",
    userId: USER.id,
    type: "WEB_PUSH",
    enabled: true,
    config: "enc({})",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    disabledReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    nextRetryAt: null,
    ...over,
  };
}

/** A well-formed subscription, for the cases that should succeed. */
const GOOD = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abcdef-routing-secret",
  keys: { p256dh: "BPkey", auth: "authsecret" },
};

type IssueEnvelope = {
  error: string;
  details?: {
    issues?: Array<{ path?: string; code?: string; message?: string }>;
  };
};

function req(body: unknown): Request {
  return new Request("http://localhost/api/notifications/web-push", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

type Handler = (r: Request) => Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ user: USER } as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    telegramGlobal: true,
    ntfyGlobal: true,
    webPushGlobal: true,
    apiGlobal: true,
  } as never);
});

describe("POST /api/notifications/web-push — the subscribe refusal", () => {
  it("names the offending field for a plain-http endpoint", async () => {
    const res = await (POST as unknown as Handler)(
      req({ ...GOOD, endpoint: "http://fcm.googleapis.com/fcm/send/x" }),
    );

    expect(res.status).toBe(422);
    const env = (await res.json()) as IssueEnvelope;
    expect(env.error).toBe("Validation failed");
    expect(env.details?.issues?.length).toBeGreaterThan(0);
    expect(env.details?.issues?.some((i) => i.path === "endpoint")).toBe(true);
    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it("names the offending field for a missing subscription key", async () => {
    const res = await (POST as unknown as Handler)(
      req({ endpoint: GOOD.endpoint, keys: { p256dh: "BPkey" } }),
    );

    expect(res.status).toBe(422);
    const env = (await res.json()) as IssueEnvelope;
    expect(env.details?.issues?.some((i) => i.path === "keys.auth")).toBe(true);
    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it("tells an internal-host endpoint apart from an http one", async () => {
    // The two are different problems with different fixes — one is a client
    // bug, the other is a subscription this instance will never accept. Under
    // the flat error the bodies were byte-identical.
    const insecure = await (POST as unknown as Handler)(
      req({ ...GOOD, endpoint: "http://fcm.googleapis.com/fcm/send/x" }),
    );
    const internal = await (POST as unknown as Handler)(
      req({ ...GOOD, endpoint: "https://192.168.1.10/push/x" }),
    );

    expect(insecure.status).toBe(422);
    expect(internal.status).toBe(422);
    expect(JSON.stringify(await insecure.json())).not.toBe(
      JSON.stringify(await internal.json()),
    );
  });

  it("still stores a well-formed subscription", async () => {
    vi.mocked(prisma.notificationChannel.findFirst).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.pushSubscription.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.notificationChannel.create).mockResolvedValue({} as never);

    const res = await (POST as unknown as Handler)(req(GOOD));

    expect(res.status).toBe(200);
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/notifications/web-push — the channel it delivers through", () => {
  // The channel is switched off when the last browser's endpoint answers 410
  // (the app was removed from the Home Screen, site data was cleared) or after
  // five failed sends. Subscribing again must switch it back on: before, the
  // subscription was stored, the test push arrived and no reminder ever did.
  it("switches a disabled channel back on", async () => {
    const disabled = channelRow({
      enabled: false,
      disabledReason: "web_push_410_gone",
      consecutiveFailures: 1,
    });
    vi.mocked(prisma.pushSubscription.upsert).mockResolvedValue(
      STORED_SUBSCRIPTION,
    );
    vi.mocked(prisma.notificationChannel.findFirst).mockResolvedValue(disabled);
    vi.mocked(prisma.notificationChannel.update).mockResolvedValue({
      ...disabled,
      enabled: true,
      disabledReason: null,
      consecutiveFailures: 0,
    });

    const res = await (POST as unknown as Handler)(req(GOOD));

    expect(res.status).toBe(200);
    expect(prisma.notificationChannel.update).toHaveBeenCalledWith({
      where: { id: "ch-1" },
      data: expect.objectContaining({
        enabled: true,
        disabledReason: null,
        consecutiveFailures: 0,
      }),
    });
    expect(prisma.notificationChannel.create).not.toHaveBeenCalled();
  });

  it("clears failures and a cooldown left on an enabled channel", async () => {
    // Four failed sends before the new subscription: one more transient
    // failure would have switched the channel off, and the cooldown skipped
    // every reminder until it ran out.
    const strained = channelRow({
      consecutiveFailures: 4,
      nextRetryAt: new Date(Date.now() + 2 * 3_600_000),
      lastFailureReason: "web_push_no_subscriptions",
    });
    vi.mocked(prisma.pushSubscription.upsert).mockResolvedValue(
      STORED_SUBSCRIPTION,
    );
    vi.mocked(prisma.notificationChannel.findFirst).mockResolvedValue(strained);
    vi.mocked(prisma.notificationChannel.update).mockResolvedValue(
      channelRow({}),
    );

    const res = await (POST as unknown as Handler)(req(GOOD));

    expect(res.status).toBe(200);
    expect(prisma.notificationChannel.update).toHaveBeenCalledWith({
      where: { id: "ch-1" },
      data: expect.objectContaining({
        enabled: true,
        consecutiveFailures: 0,
        nextRetryAt: null,
        lastFailureReason: null,
      }),
    });
  });

  it("leaves an enabled channel as it is", async () => {
    vi.mocked(prisma.pushSubscription.upsert).mockResolvedValue(
      STORED_SUBSCRIPTION,
    );
    vi.mocked(prisma.notificationChannel.findFirst).mockResolvedValue(
      channelRow({}),
    );

    const res = await (POST as unknown as Handler)(req(GOOD));

    expect(res.status).toBe(200);
    expect(prisma.notificationChannel.update).not.toHaveBeenCalled();
    expect(prisma.notificationChannel.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/notifications/web-push — one account per browser", () => {
  it("removes another account's row for the same browser", async () => {
    // A session that ended without a sign-out left the previous account's
    // row on this endpoint; its reminders kept arriving for the next person.
    vi.mocked(prisma.pushSubscription.upsert).mockResolvedValue(
      STORED_SUBSCRIPTION,
    );
    vi.mocked(prisma.notificationChannel.findFirst).mockResolvedValue(
      channelRow({}),
    );

    const res = await (POST as unknown as Handler)(req(GOOD));

    expect(res.status).toBe(200);
    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: GOOD.endpoint, userId: { not: USER.id } },
    });
  });
});

describe("DELETE /api/notifications/web-push — the unsubscribe refusal", () => {
  it("names the offending field rather than answering flat", async () => {
    const res = await (DELETE as unknown as Handler)(
      req({ endpoint: "not-a-url" }),
    );

    expect(res.status).toBe(422);
    const env = (await res.json()) as IssueEnvelope;
    expect(env.error).toBe("Validation failed");
    expect(env.details?.issues?.some((i) => i.path === "endpoint")).toBe(true);
    expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it("distinguishes a missing endpoint from a malformed one", async () => {
    const missing = await (DELETE as unknown as Handler)(req({}));
    const malformed = await (DELETE as unknown as Handler)(
      req({ endpoint: "not-a-url" }),
    );

    expect(JSON.stringify(await missing.json())).not.toBe(
      JSON.stringify(await malformed.json()),
    );
  });
});

describe("what the refusal must never carry", () => {
  it("echoes neither the endpoint nor the subscription keys", async () => {
    // The endpoint path is the routing secret for a push subscription and the
    // keys are its crypto material. Publishing the issue list is only safe
    // while this holds; if a future schema change adds a message that
    // interpolates the value, this fails rather than leaking quietly.
    const res = await (POST as unknown as Handler)(
      req({
        endpoint: "http://attacker.example/fcm/send/ROUTING-SECRET-abc123",
        keys: { p256dh: "P256-SECRET-xyz", auth: "AUTH-SECRET-789" },
      }),
    );

    expect(res.status).toBe(422);
    const raw = await res.text();
    expect(raw).not.toContain("ROUTING-SECRET-abc123");
    expect(raw).not.toContain("P256-SECRET-xyz");
    expect(raw).not.toContain("AUTH-SECRET-789");
    expect(raw).not.toContain("attacker.example");
  });
});
