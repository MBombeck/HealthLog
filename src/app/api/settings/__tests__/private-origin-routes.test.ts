/**
 * #947 — a webhook or ntfy target on a private network, at the four routes
 * that meet it.
 *
 * The save routes evaluate the same policy the senders do, so a private
 * target that is not listed in NOTIFICATION_PRIVATE_ORIGINS is a 422 that
 * names the reason (`meta.errorCode = private_origin_not_approved`) instead
 * of a generic "Invalid data", and a listed literal address saves although
 * the plain public floor would refuse it. The test routes forward the
 * sender's own refusal as a 422 with the same code instead of the bare 500
 * that made the reporter read the wide-event log to learn it was policy.
 *
 * The last block is the structural half: the test button and the dispatcher
 * must reach the SAME sender function, so the decision cannot differ between
 * the button that says "works" and the reminder that then does not arrive.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    notificationChannel: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));

vi.mock("@/lib/app-settings", () => ({
  isChannelGloballyEnabled: vi.fn().mockResolvedValue(true),
}));

const sendViaWebhookMock = vi.fn();
const sendViaNtfyMock = vi.fn();
vi.mock("@/lib/notifications/senders/webhook", () => ({
  sendViaWebhook: (...args: unknown[]) => sendViaWebhookMock(...args),
}));
vi.mock("@/lib/notifications/senders/ntfy", () => ({
  sendViaNtfy: (...args: unknown[]) => sendViaNtfyMock(...args),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { PUT as putWebhook } from "../webhook/route";
import { PUT as putNtfy } from "../ntfy/route";
import { POST as testWebhook } from "../webhook/test/route";
import { POST as testNtfy } from "../ntfy/test/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

type Route = (request: Request) => Promise<Response>;

function put(path: string, body: unknown): Promise<Response> {
  const route = (path === "webhook" ? putWebhook : putNtfy) as Route;
  return route(
    new Request(`http://localhost/api/settings/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function post(path: string): Promise<Response> {
  const route = (path === "webhook" ? testWebhook : testNtfy) as Route;
  return route(
    new Request(`http://localhost/api/settings/${path}/test`, {
      method: "POST",
    }),
  );
}

const ORIGINAL_PRIVATE_ORIGINS = process.env.NOTIFICATION_PRIVATE_ORIGINS;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NOTIFICATION_PRIVATE_ORIGINS;
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.notificationChannel.upsert).mockResolvedValue({} as never);
});

afterEach(() => {
  if (ORIGINAL_PRIVATE_ORIGINS === undefined) {
    delete process.env.NOTIFICATION_PRIVATE_ORIGINS;
  } else {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = ORIGINAL_PRIVATE_ORIGINS;
  }
});

describe("PUT /api/settings/webhook — private targets", () => {
  it("refuses an unlisted private address with the reason, and stores nothing", async () => {
    const response = await put("webhook", {
      url: "http://10.0.0.5:8080/message",
      enabled: true,
    });

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.data).toBeNull();
    expect(json.meta).toEqual({ errorCode: "private_origin_not_approved" });
    expect(json.error).toContain("NOTIFICATION_PRIVATE_ORIGINS");
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
  });

  it("refuses a sub-host of a listed origin: a grant names one origin only", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "https://gotify.example.com";

    const response = await put("webhook", {
      url: "https://push.gotify.example.com/message",
      enabled: true,
    });

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.meta).toEqual({ errorCode: "private_origin_not_approved" });
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
  });

  it("saves a listed private address the public floor alone would refuse", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://10.0.0.5:8080";

    const response = await put("webhook", {
      url: "http://10.0.0.5:8080/message",
      enabled: true,
    });

    expect(response.status).toBe(200);
    expect(prisma.notificationChannel.upsert).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.notificationChannel.upsert).mock.calls[0][0];
    expect(call.create.config).toBe(
      'encrypted:{"url":"http://10.0.0.5:8080/message"}',
    );
  });

  it("keeps the plain shape refusal for a body that is not a private-origin case", async () => {
    const response = await put("webhook", { url: 42, enabled: true });

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.error).toBe("Invalid data");
    expect(json.meta).toBeUndefined();
  });

  it("refuses a loopback grant at save time: listing it does not open it", async () => {
    // The parser drops a loopback or localhost grant with a warning, so the
    // save is refused with the reason and the operator learns that the list
    // is not the way to reach the container itself.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NOTIFICATION_PRIVATE_ORIGINS =
      "http://127.0.0.1:8080, http://localhost:8080";

    for (const url of [
      "http://127.0.0.1:8080/message",
      "http://localhost:8080/message",
    ]) {
      const response = await put("webhook", { url, enabled: true });
      expect(response.status).toBe(422);
      const json = await response.json();
      expect(json.meta).toEqual({ errorCode: "private_origin_not_approved" });
    }
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
  });

  it("saves an mDNS name the input floor refuses, once the operator lists it", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://gotify.local";

    const refused = await put("webhook", {
      url: "http://ntfy.local/message",
      enabled: true,
    });
    expect(refused.status).toBe(422);
    await expect(refused.json()).resolves.toMatchObject({
      meta: { errorCode: "private_origin_not_approved" },
    });

    const saved = await put("webhook", {
      url: "http://gotify.local/message",
      enabled: true,
    });
    expect(saved.status).toBe(200);
    expect(prisma.notificationChannel.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/settings/ntfy — private servers", () => {
  it("refuses an unlisted private server with the reason, and stores nothing", async () => {
    const response = await put("ntfy", {
      serverUrl: "http://192.168.1.20:8080",
      topic: "health",
      enabled: true,
    });

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.meta).toEqual({ errorCode: "private_origin_not_approved" });
    expect(json.error).toContain("NOTIFICATION_PRIVATE_ORIGINS");
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
  });

  it("saves a listed private server", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://192.168.1.20:8080";

    const response = await put("ntfy", {
      serverUrl: "http://192.168.1.20:8080",
      topic: "health",
      enabled: true,
    });

    expect(response.status).toBe(200);
    expect(prisma.notificationChannel.upsert).toHaveBeenCalledTimes(1);
  });

  it("refuses a sibling port of a listed server", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://192.168.1.20:8080";

    const response = await put("ntfy", {
      serverUrl: "http://192.168.1.20:9090",
      topic: "health",
      enabled: true,
    });

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.meta).toEqual({ errorCode: "private_origin_not_approved" });
  });
});

describe("POST /api/settings/{webhook,ntfy}/test — the refusal names itself", () => {
  beforeEach(() => {
    vi.mocked(prisma.notificationChannel.findUnique).mockImplementation(
      (async (args: { where: { userId_type: { type: string } } }) =>
        args.where.userId_type.type === "WEBHOOK"
          ? { config: 'encrypted:{"url":"https://gotify.lan/message"}' }
          : {
              config:
                'encrypted:{"serverUrl":"https://ntfy.lan","topic":"health"}',
            }) as never,
    );
  });

  it.each([
    ["webhook", sendViaWebhookMock],
    ["ntfy", sendViaNtfyMock],
  ])(
    "%s: answers a private-origin refusal with 422 and the code, not a 500",
    async (path, sender) => {
      sender.mockResolvedValue({
        ok: false,
        hardReject: false,
        reason: `${path}_private_origin_refused`,
        errorCode: "private_origin_not_approved",
      });

      const response = await post(path);

      expect(response.status).toBe(422);
      const json = await response.json();
      expect(json.meta).toEqual({ errorCode: "private_origin_not_approved" });
      expect(json.error).toContain("NOTIFICATION_PRIVATE_ORIGINS");
    },
  );

  it.each([
    ["webhook", sendViaWebhookMock],
    ["ntfy", sendViaNtfyMock],
  ])("%s: a plain delivery failure is still a 500", async (path, sender) => {
    sender.mockResolvedValue({
      ok: false,
      hardReject: false,
      reason: `${path}_503`,
      statusCode: 503,
    });

    const response = await post(path);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.meta).toBeUndefined();
  });

  it.each([
    ["webhook", sendViaWebhookMock],
    ["ntfy", sendViaNtfyMock],
  ])("%s: a delivered test is a 200", async (path, sender) => {
    sender.mockResolvedValue({ ok: true, statusCode: 200 });

    const response = await post(path);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { sent: true },
      error: null,
    });
  });
});

describe("the test button and the dispatcher share one sender", () => {
  const SRC = join(process.cwd(), "src");
  const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

  it.each([
    [
      "webhook",
      "app/api/settings/webhook/test/route.ts",
      /import \{ sendViaWebhook \} from "@\/lib\/notifications\/senders\/webhook"/,
      /sendViaWebhook\(config, payload\)/,
    ],
    [
      "ntfy",
      "app/api/settings/ntfy/test/route.ts",
      /import \{ sendViaNtfy \} from "@\/lib\/notifications\/senders\/ntfy"/,
      /sendViaNtfy\(config, payload\)/,
    ],
  ])(
    "%s: the route and the dispatcher import the same sender module",
    (_channel, routeFile, importPattern, dispatcherCall) => {
      expect(read(routeFile)).toMatch(importPattern);
      const dispatcher = read("lib/notifications/dispatcher.ts");
      expect(dispatcher).toMatch(importPattern);
      expect(dispatcher).toMatch(dispatcherCall);
    },
  );

  it("neither sender decides the private-origin verdict on its own", () => {
    // The senders take the verdict from `evaluateNotificationTarget`, the
    // function the save routes use too. No sender may carry a second policy.
    for (const rel of [
      "lib/notifications/senders/webhook.ts",
      "lib/notifications/senders/ntfy.ts",
    ]) {
      const src = read(rel);
      expect(src).toMatch(/evaluateNotificationTarget\(/);
      expect(src).not.toMatch(/process\.env\.NOTIFICATION_PRIVATE_ORIGINS/);
      expect(src).not.toMatch(/isPublicUrl\(/);
    }
    for (const rel of [
      "app/api/settings/webhook/route.ts",
      "app/api/settings/ntfy/route.ts",
    ]) {
      expect(read(rel)).toMatch(/isAllowedNotificationTarget/);
    }
  });
});
