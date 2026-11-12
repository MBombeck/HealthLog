/**
 * The notification channel save routes, `/api/settings/{webhook,ntfy,email,
 * telegram}` and the Web Push subscribe, against the real database and
 * through the real API kit. Telegram's Bot API is replaced at the
 * `safeFetch` seam, so what the bot is asked to do is read off the requests
 * that seam received.
 *
 * Pinned here, read back from the stored rows:
 *   - every save route refuses an anonymous caller and a narrow token;
 *   - a toggle-only body (`{ enabled }`) flips the caller's own row and
 *     nothing else: the stored config is the same ciphertext afterwards, and
 *     another account's row of the same type is untouched; enabling a channel
 *     that has no stored config is 422 and stores nothing;
 *   - Telegram's toggle keeps the stored token and chat id, registers the
 *     bot's webhook at `APP_URL` on enable and removes it on disable;
 *   - a full body creates or replaces the config, encrypted;
 *   - the ntfy auth token and the webhook header value are write-only and
 *     survive a save that omits them or sends them empty; a non-empty value
 *     replaces them;
 *   - the webhook payload format: only the Gotify choice is written, an
 *     omitted format keeps the stored one, an unknown one is 422, and the
 *     read reports the resolved value;
 *   - a private webhook or ntfy target is refused at save time with a code
 *     that says whether the operator can list it, and a listed one saves;
 *   - enabling ntfy, Telegram or Web Push while the operator switched the
 *     channel off instance-wide is 403 and writes nothing; disabling still
 *     works.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { SafeFetchOptions } from "@/lib/safe-fetch";
import { decrypt, encrypt } from "@/lib/crypto";
import { resetEmailConfigForTesting } from "@/lib/notifications/senders/email-config";
import {
  GET as getWebhook,
  PUT as putWebhook,
} from "@/app/api/settings/webhook/route";
import { PUT as putNtfy } from "@/app/api/settings/ntfy/route";
import { PUT as putEmail } from "@/app/api/settings/email/route";
import { PUT as putTelegram } from "@/app/api/settings/telegram/route";
import { POST as subscribeWebPush } from "@/app/api/notifications/web-push/route";

import { anonymous, callRoute, type RouteAuth } from "../../kit/call-route";
import { makeSession, makeToken, makeUser } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const upstream = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; body: string }>,
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (
      url: string | URL,
      init: RequestInit = {},
      _options?: SafeFetchOptions,
    ) => {
      upstream.requests.push({
        url: String(url),
        body: typeof init.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
});

const prisma = getPrismaClient();

const ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_FROM",
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "TELEGRAM_WEBHOOK_SECRET",
  "NOTIFICATION_PRIVATE_ORIGINS",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  // The email routes refuse every write on an instance without SMTP.
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_FROM = "healthlog@example.test";
  resetEmailConfigForTesting();
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEmailConfigForTesting();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  upstream.requests.length = 0;
  process.env.APP_URL = "https://health.example";
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.NOTIFICATION_PRIVATE_ORIGINS;
});

afterEach(() => {
  vi.restoreAllMocks();
});

type ChannelType = "WEBHOOK" | "NTFY" | "EMAIL" | "TELEGRAM" | "WEB_PUSH";

async function storeChannel(
  userId: string,
  type: ChannelType,
  config: Record<string, unknown>,
  enabled: boolean,
) {
  return prisma.notificationChannel.create({
    data: {
      userId,
      type,
      enabled,
      config: encrypt(JSON.stringify(config)),
    },
  });
}

async function channel(userId: string, type: ChannelType) {
  return prisma.notificationChannel.findUnique({
    where: { userId_type: { userId, type } },
  });
}

async function storedConfig(
  userId: string,
  type: ChannelType,
): Promise<Record<string, unknown>> {
  const row = await prisma.notificationChannel.findUniqueOrThrow({
    where: { userId_type: { userId, type } },
  });
  return JSON.parse(decrypt(row.config)) as Record<string, unknown>;
}

async function switchGlobal(values: {
  ntfyGlobal?: boolean;
  telegramGlobal?: boolean;
  webPushGlobal?: boolean;
}): Promise<void> {
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...values },
    update: values,
  });
}

const SAVE_ROUTES = {
  webhook: { handler: putWebhook, route: "/api/settings/webhook" },
  ntfy: { handler: putNtfy, route: "/api/settings/ntfy" },
  email: { handler: putEmail, route: "/api/settings/email" },
  telegram: { handler: putTelegram, route: "/api/settings/telegram" },
} as const;

type SaveRoute = keyof typeof SAVE_ROUTES;

async function save(channelName: SaveRoute, body: unknown, auth: RouteAuth) {
  const { handler, route } = SAVE_ROUTES[channelName];
  return callRoute<{ saved?: true; updated?: true }>(handler, {
    method: "PUT",
    route,
    body,
    auth,
  });
}

const WEBHOOK_CONFIG = {
  url: "https://saved.example/hook",
  headerName: "Authorization",
  headerValue: "secret",
};
const NTFY_CONFIG = {
  serverUrl: "https://ntfy.sh",
  topic: "saved-topic",
  authToken: "secret",
};
const EMAIL_CONFIG = { recipient: "saved@example.com" };

const TOGGLE_FIXTURES = [
  ["webhook", "WEBHOOK", WEBHOOK_CONFIG],
  ["ntfy", "NTFY", NTFY_CONFIG],
  ["email", "EMAIL", EMAIL_CONFIG],
] as const;

describe("who may save a channel", () => {
  it.each(Object.keys(SAVE_ROUTES) as SaveRoute[])(
    "%s refuses an anonymous caller with 401",
    async (name) => {
      const res = await save(name, { enabled: false }, anonymous);

      expect(res.status).toBe(401);
      expect(res.meta?.errorCode).toBe("auth.missing");
      expect(await prisma.notificationChannel.count()).toBe(0);
    },
  );

  it.each(Object.keys(SAVE_ROUTES) as SaveRoute[])(
    "%s refuses a narrow token with 403 and leaves the stored row alone",
    async (name) => {
      const user = await makeUser({ telegramEnabled: true });
      const type = name === "telegram" ? "TELEGRAM" : name.toUpperCase();
      const row = await prisma.notificationChannel.create({
        data: {
          userId: user.id,
          type,
          enabled: true,
          config: encrypt(JSON.stringify(EMAIL_CONFIG)),
        },
      });

      const res = await save(
        name,
        { enabled: false },
        await makeToken(user, { permissions: ["measurements:write"] }),
      );

      expect(res.status).toBe(403);
      expect(res.meta?.errorCode).toBe("auth.scope.insufficient");
      const after = await prisma.notificationChannel.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.enabled).toBe(true);
    },
  );
});

describe("the toggle-only body", () => {
  it.each(TOGGLE_FIXTURES)(
    "%s flips only the caller's enabled flag and keeps the stored config",
    async (name, type, config) => {
      const user = await makeUser();
      const other = await makeUser();
      const own = await storeChannel(user.id, type, config, false);
      const theirs = await storeChannel(other.id, type, config, false);

      const res = await save(name, { enabled: true }, await makeSession(user));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { saved: true }, error: null });
      const after = await channel(user.id, type);
      expect(after?.enabled).toBe(true);
      expect(after?.config).toBe(own.config);
      const untouched = await channel(other.id, type);
      expect(untouched?.enabled).toBe(false);
      expect(untouched?.config).toBe(theirs.config);
    },
  );

  it.each(TOGGLE_FIXTURES)(
    "%s refuses to enable a channel that has no stored config, and stores none",
    async (name, type) => {
      const user = await makeUser();

      const res = await save(name, { enabled: true }, await makeSession(user));

      expect(res.status).toBe(422);
      expect(await channel(user.id, type)).toBeNull();
    },
  );

  it("Telegram disable keeps the stored credentials and removes the bot's webhook", async () => {
    const user = await makeUser({
      telegramBotToken: encrypt("saved-token"),
      telegramChatId: "saved-chat",
      telegramEnabled: true,
    });
    const row = await storeChannel(
      user.id,
      "TELEGRAM",
      { botToken: "saved-token", chatId: "saved-chat" },
      true,
    );

    const res = await save(
      "telegram",
      { enabled: false },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { updated: true }, error: null });
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.telegramEnabled).toBe(false);
    expect(stored.telegramBotToken).toBe(user.telegramBotToken);
    expect(stored.telegramChatId).toBe("saved-chat");
    const after = await channel(user.id, "TELEGRAM");
    expect(after?.enabled).toBe(false);
    expect(after?.config).toBe(row.config);
    expect(upstream.requests.map((r) => r.url)).toEqual([
      "https://api.telegram.org/botsaved-token/deleteWebhook",
    ]);
  });

  it("Telegram enable registers the webhook at APP_URL with the stored token, and rewrites no credential", async () => {
    const user = await makeUser({
      telegramBotToken: encrypt("saved-token"),
      telegramChatId: "saved-chat",
      telegramEnabled: false,
    });
    const row = await storeChannel(
      user.id,
      "TELEGRAM",
      { botToken: "saved-token", chatId: "saved-chat" },
      false,
    );

    const res = await save(
      "telegram",
      { enabled: true },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].url).toBe(
      "https://api.telegram.org/botsaved-token/setWebhook",
    );
    expect(JSON.parse(upstream.requests[0].body)).toEqual({
      url: "https://health.example/api/telegram/webhook",
      drop_pending_updates: false,
    });
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.telegramEnabled).toBe(true);
    expect(stored.telegramBotToken).toBe(user.telegramBotToken);
    expect(stored.telegramChatId).toBe("saved-chat");
    const after = await channel(user.id, "TELEGRAM");
    expect(after?.enabled).toBe(true);
    expect(after?.config).toBe(row.config);
  });
});

describe("the full body", () => {
  it.each([
    [
      "webhook",
      "WEBHOOK",
      {
        url: "https://saved.example/hook",
        headerName: "X-Test",
        headerValue: "secret",
        enabled: false,
      },
      {
        url: "https://saved.example/hook",
        headerName: "X-Test",
        headerValue: "secret",
      },
    ],
    [
      "ntfy",
      "NTFY",
      {
        serverUrl: "https://ntfy.sh",
        topic: "saved-topic",
        authToken: "secret",
        enabled: false,
      },
      {
        serverUrl: "https://ntfy.sh",
        topic: "saved-topic",
        authToken: "secret",
      },
    ],
    [
      "email",
      "EMAIL",
      { recipient: "saved@example.com", enabled: false },
      { recipient: "saved@example.com" },
    ],
  ] as const)(
    "%s creates the channel with the config encrypted",
    async (name, type, body, expected) => {
      const user = await makeUser();

      const res = await save(name, body, await makeSession(user));

      expect(res.status).toBe(200);
      const row = await channel(user.id, type);
      expect(row?.enabled).toBe(false);
      expect(row?.config).not.toContain("saved");
      expect(await storedConfig(user.id, type)).toEqual(expected);
    },
  );

  it("Telegram stores the token encrypted, the chat id, and mirrors both into the channel row", async () => {
    const user = await makeUser();

    const res = await save(
      "telegram",
      { botToken: "new-token", chatId: "new-chat", enabled: false },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.telegramEnabled).toBe(false);
    expect(stored.telegramBotToken).not.toBe("new-token");
    expect(decrypt(stored.telegramBotToken ?? "")).toBe("new-token");
    expect(stored.telegramChatId).toBe("new-chat");
    const row = await channel(user.id, "TELEGRAM");
    expect(row?.enabled).toBe(false);
    expect(await storedConfig(user.id, "TELEGRAM")).toEqual({
      botToken: "new-token",
      chatId: "new-chat",
    });
  });
});

describe("write-only secrets survive a save that does not carry them", () => {
  it("an omitted ntfy authToken keeps the stored one", async () => {
    const user = await makeUser();
    await storeChannel(user.id, "NTFY", NTFY_CONFIG, true);

    const res = await save(
      "ntfy",
      { serverUrl: "https://ntfy.sh", topic: "saved-topic", enabled: true },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    expect((await storedConfig(user.id, "NTFY")).authToken).toBe("secret");
  });

  it("an empty ntfy authToken keeps the stored one, as current clients send it", async () => {
    const user = await makeUser();
    await storeChannel(user.id, "NTFY", NTFY_CONFIG, true);

    const res = await save(
      "ntfy",
      {
        serverUrl: "https://ntfy.sh",
        topic: "saved-topic",
        authToken: "",
        enabled: true,
      },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    expect((await storedConfig(user.id, "NTFY")).authToken).toBe("secret");
  });

  it("a non-empty ntfy authToken replaces the stored one", async () => {
    const user = await makeUser();
    await storeChannel(
      user.id,
      "NTFY",
      { ...NTFY_CONFIG, authToken: "old-secret" },
      true,
    );

    const res = await save(
      "ntfy",
      {
        serverUrl: "https://ntfy.sh",
        topic: "saved-topic",
        authToken: "new-secret",
        enabled: true,
      },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    expect((await storedConfig(user.id, "NTFY")).authToken).toBe("new-secret");
  });

  it("an ntfy channel without a token saves, for a server that allows anonymous publishing", async () => {
    const user = await makeUser();

    const res = await save(
      "ntfy",
      { serverUrl: "https://ntfy.sh", topic: "public-topic", enabled: false },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    expect(await storedConfig(user.id, "NTFY")).toEqual({
      serverUrl: "https://ntfy.sh",
      topic: "public-topic",
    });
  });

  it("an omitted webhook headerValue keeps the stored one", async () => {
    const user = await makeUser();
    await storeChannel(user.id, "WEBHOOK", WEBHOOK_CONFIG, true);

    const res = await save(
      "webhook",
      {
        url: "https://saved.example/hook",
        headerName: "Authorization",
        enabled: true,
      },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    expect((await storedConfig(user.id, "WEBHOOK")).headerValue).toBe("secret");
  });
});

describe("the webhook payload format", () => {
  async function readWebhook(userId: string) {
    return callRoute<{
      enabled: boolean;
      url: string;
      headerName: string;
      hasHeaderValue: boolean;
      format: string;
    }>(getWebhook, {
      method: "GET",
      route: "/api/settings/webhook",
      auth: await makeSession({ id: userId }),
    });
  }

  it("stores the Gotify choice", async () => {
    const user = await makeUser();

    const res = await save(
      "webhook",
      {
        url: "https://gotify.example.com/message",
        headerName: "X-Gotify-Key",
        headerValue: "AbCdEfGh123",
        format: "gotify",
        enabled: true,
      },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    expect(await storedConfig(user.id, "WEBHOOK")).toEqual({
      url: "https://gotify.example.com/message",
      headerName: "X-Gotify-Key",
      headerValue: "AbCdEfGh123",
      format: "gotify",
    });
  });

  it("writes nothing for generic, so the stored config keeps its old shape", async () => {
    const user = await makeUser();

    await save(
      "webhook",
      {
        url: "https://relay.example.com/hook",
        format: "generic",
        enabled: true,
      },
      await makeSession(user),
    );

    expect(await storedConfig(user.id, "WEBHOOK")).toEqual({
      url: "https://relay.example.com/hook",
    });
  });

  it("keeps a stored Gotify choice when the body omits the field", async () => {
    const user = await makeUser();
    await storeChannel(
      user.id,
      "WEBHOOK",
      {
        url: "https://gotify.example.com/message",
        headerValue: "AbCdEfGh123",
        format: "gotify",
      },
      true,
    );

    await save(
      "webhook",
      {
        url: "https://gotify.example.com/message",
        headerValue: "NewToken456",
        enabled: true,
      },
      await makeSession(user),
    );

    expect(await storedConfig(user.id, "WEBHOOK")).toEqual({
      url: "https://gotify.example.com/message",
      headerValue: "NewToken456",
      format: "gotify",
    });
  });

  it("switches a Gotify channel back to generic when asked", async () => {
    const user = await makeUser();
    await storeChannel(
      user.id,
      "WEBHOOK",
      { url: "https://gotify.example.com/message", format: "gotify" },
      true,
    );

    await save(
      "webhook",
      {
        url: "https://gotify.example.com/message",
        format: "generic",
        enabled: true,
      },
      await makeSession(user),
    );

    expect(await storedConfig(user.id, "WEBHOOK")).toEqual({
      url: "https://gotify.example.com/message",
    });
  });

  it("refuses a format it does not know and stores nothing", async () => {
    const user = await makeUser();

    const res = await save(
      "webhook",
      {
        url: "https://relay.example.com/hook",
        format: "discord",
        enabled: true,
      },
      await makeSession(user),
    );

    expect(res.status).toBe(422);
    expect(await channel(user.id, "WEBHOOK")).toBeNull();
  });

  it("reads generic for a config saved before the choice existed", async () => {
    const user = await makeUser();
    await storeChannel(
      user.id,
      "WEBHOOK",
      { url: "https://relay.example.com/hook" },
      true,
    );

    const res = await readWebhook(user.id);

    expect(res.status).toBe(200);
    expect(res.data.format).toBe("generic");
  });

  it("reads the stored Gotify choice, and the header value only as a flag", async () => {
    const user = await makeUser();
    await storeChannel(
      user.id,
      "WEBHOOK",
      {
        url: "https://gotify.example.com/message",
        headerName: "X-Gotify-Key",
        headerValue: "AbCdEfGh123",
        format: "gotify",
      },
      true,
    );

    const res = await readWebhook(user.id);

    expect(res.data).toEqual({
      enabled: true,
      url: "https://gotify.example.com/message",
      headerName: "X-Gotify-Key",
      hasHeaderValue: true,
      format: "gotify",
    });
  });

  it("reads the defaults, generic included, when no channel exists", async () => {
    const user = await makeUser();

    const res = await readWebhook(user.id);

    expect(res.data).toEqual({
      enabled: false,
      url: "",
      headerName: "",
      hasHeaderValue: false,
      format: "generic",
    });
  });
});

describe("a private webhook target at save time", () => {
  it("refuses an unlisted private address with the reason, and stores nothing", async () => {
    const user = await makeUser();

    const res = await save(
      "webhook",
      { url: "http://10.0.0.5:8080/message", enabled: true },
      await makeSession(user),
    );

    expect(res.status).toBe(422);
    expect(res.data).toBeNull();
    expect(res.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "private_origin_not_approved",
    });
    expect(res.error).toContain("NOTIFICATION_PRIVATE_ORIGINS");
    expect(await channel(user.id, "WEBHOOK")).toBeNull();
  });

  it("refuses a sub-host of a listed origin: a grant names one origin only", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "https://gotify.example.com";
    const user = await makeUser();

    const res = await save(
      "webhook",
      { url: "https://push.gotify.example.com/message", enabled: true },
      await makeSession(user),
    );

    expect(res.status).toBe(422);
    expect(res.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "private_origin_not_approved",
    });
    expect(await channel(user.id, "WEBHOOK")).toBeNull();
  });

  it("saves a listed private address the public floor alone would refuse", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://10.0.0.5:8080";
    const user = await makeUser();

    const res = await save(
      "webhook",
      { url: "http://10.0.0.5:8080/message", enabled: true },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    expect(await storedConfig(user.id, "WEBHOOK")).toEqual({
      url: "http://10.0.0.5:8080/message",
    });
  });

  it("keeps the plain shape refusal for a body that is not a private-origin case", async () => {
    const user = await makeUser();

    const res = await save(
      "webhook",
      { url: 42, enabled: true },
      await makeSession(user),
    );

    expect(res.status).toBe(422);
    expect(res.error).toBe("Invalid data");
    expect(res.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "http.invalid",
    });
  });

  it("saves a listed loopback origin and refuses an unlisted one with the listable code", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://localhost:8080";
    const user = await makeUser();
    const session = await makeSession(user);

    const refused = await save(
      "webhook",
      { url: "http://127.0.0.1:8080/message", enabled: true },
      session,
    );
    expect(refused.status).toBe(422);
    expect(refused.meta?.errorCode).toBe("private_origin_not_approved");
    expect(await channel(user.id, "WEBHOOK")).toBeNull();

    const saved = await save(
      "webhook",
      { url: "http://localhost:8080/message", enabled: true },
      session,
    );
    expect(saved.status).toBe(200);
    expect(await storedConfig(user.id, "WEBHOOK")).toEqual({
      url: "http://localhost:8080/message",
    });
  });

  it("answers a metadata, unspecified or link-local target with the not-grantable code, listed or not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NOTIFICATION_PRIVATE_ORIGINS =
      "http://169.254.169.254, http://0.0.0.0:8080";
    const user = await makeUser();
    const session = await makeSession(user);

    for (const url of [
      "http://169.254.169.254/latest",
      "http://0.0.0.0:8080/message",
      "http://[fe80::1]:8080/message",
    ]) {
      const res = await save("webhook", { url, enabled: true }, session);
      expect(res.status).toBe(422);
      expect(res.meta).toEqual({
        requestId: expect.any(String),
        errorCode: "private_origin_not_grantable",
      });
      expect(res.error).toMatch(/no operator grant can open/);
      expect(res.error).not.toContain("NOTIFICATION_PRIVATE_ORIGINS");
      const body = res.body as { details?: { issues: unknown[] } };
      expect(body.details?.issues.length).toBeGreaterThan(0);
    }
    expect(await channel(user.id, "WEBHOOK")).toBeNull();
  });

  it("saves an mDNS name the input floor refuses, once the operator lists it", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://gotify.local";
    const user = await makeUser();
    const session = await makeSession(user);

    const refused = await save(
      "webhook",
      { url: "http://ntfy.local/message", enabled: true },
      session,
    );
    expect(refused.status).toBe(422);
    expect(refused.meta?.errorCode).toBe("private_origin_not_approved");

    const saved = await save(
      "webhook",
      { url: "http://gotify.local/message", enabled: true },
      session,
    );
    expect(saved.status).toBe(200);
    expect(await storedConfig(user.id, "WEBHOOK")).toEqual({
      url: "http://gotify.local/message",
    });
  });
});

describe("a private ntfy server at save time", () => {
  it("refuses an unlisted private server with the reason, and stores nothing", async () => {
    const user = await makeUser();

    const res = await save(
      "ntfy",
      { serverUrl: "http://192.168.1.20:8080", topic: "health", enabled: true },
      await makeSession(user),
    );

    expect(res.status).toBe(422);
    expect(res.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "private_origin_not_approved",
    });
    expect(res.error).toContain("NOTIFICATION_PRIVATE_ORIGINS");
    expect(await channel(user.id, "NTFY")).toBeNull();
  });

  it("saves a listed private server", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://192.168.1.20:8080";
    const user = await makeUser();

    const res = await save(
      "ntfy",
      { serverUrl: "http://192.168.1.20:8080", topic: "health", enabled: true },
      await makeSession(user),
    );

    expect(res.status).toBe(200);
    expect(await storedConfig(user.id, "NTFY")).toEqual({
      serverUrl: "http://192.168.1.20:8080",
      topic: "health",
    });
  });

  it("refuses a sibling port of a listed server", async () => {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://192.168.1.20:8080";
    const user = await makeUser();

    const res = await save(
      "ntfy",
      { serverUrl: "http://192.168.1.20:9090", topic: "health", enabled: true },
      await makeSession(user),
    );

    expect(res.status).toBe(422);
    expect(res.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "private_origin_not_approved",
    });
    expect(await channel(user.id, "NTFY")).toBeNull();
  });
});

describe("the operator's instance-wide channel switches", () => {
  it("refuses to enable ntfy while the operator switched it off, and writes nothing", async () => {
    await switchGlobal({ ntfyGlobal: false });
    const user = await makeUser();
    const row = await storeChannel(user.id, "NTFY", NTFY_CONFIG, false);
    const session = await makeSession(user);

    const toggle = await save("ntfy", { enabled: true }, session);
    expect(toggle.status).toBe(403);
    expect(toggle.data).toBeNull();
    expect(toggle.error).toContain("disabled on this instance");

    const full = await save(
      "ntfy",
      { serverUrl: "https://ntfy.sh", topic: "other-topic", enabled: true },
      session,
    );
    expect(full.status).toBe(403);

    const after = await channel(user.id, "NTFY");
    expect(after?.enabled).toBe(false);
    expect(after?.config).toBe(row.config);
  });

  it("still lets ntfy be disabled while the switch is off", async () => {
    await switchGlobal({ ntfyGlobal: false });
    const user = await makeUser();
    await storeChannel(user.id, "NTFY", NTFY_CONFIG, true);

    const res = await save("ntfy", { enabled: false }, await makeSession(user));

    expect(res.status).toBe(200);
    expect((await channel(user.id, "NTFY"))?.enabled).toBe(false);
  });

  it("enables ntfy while the switch is on", async () => {
    await switchGlobal({ ntfyGlobal: true });
    const user = await makeUser();
    await storeChannel(user.id, "NTFY", NTFY_CONFIG, false);

    const res = await save("ntfy", { enabled: true }, await makeSession(user));

    expect(res.status).toBe(200);
    expect((await channel(user.id, "NTFY"))?.enabled).toBe(true);
  });

  it("refuses to enable Telegram while the switch is off, registers no webhook, and writes nothing", async () => {
    await switchGlobal({ telegramGlobal: false });
    const user = await makeUser({
      telegramBotToken: encrypt("saved-token"),
      telegramChatId: "saved-chat",
      telegramEnabled: false,
    });
    const row = await storeChannel(
      user.id,
      "TELEGRAM",
      { botToken: "saved-token", chatId: "saved-chat" },
      false,
    );

    const res = await save(
      "telegram",
      { enabled: true },
      await makeSession(user),
    );

    expect(res.status).toBe(403);
    expect(upstream.requests).toEqual([]);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.telegramEnabled).toBe(false);
    const after = await channel(user.id, "TELEGRAM");
    expect(after?.enabled).toBe(false);
    expect(after?.config).toBe(row.config);
  });

  it("refuses a full Telegram save that enables the channel while the switch is off", async () => {
    await switchGlobal({ telegramGlobal: false });
    const user = await makeUser();

    const res = await save(
      "telegram",
      {
        botToken: "123456:AAaaBBbbCCccDDddEEeeFFffGGgg-HHhhIIii",
        chatId: "9876543",
        enabled: true,
      },
      await makeSession(user),
    );

    expect(res.status).toBe(403);
    expect(upstream.requests).toEqual([]);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.telegramBotToken).toBeNull();
    expect(stored.telegramChatId).toBeNull();
    expect(stored.telegramEnabled).toBe(false);
    expect(await channel(user.id, "TELEGRAM")).toBeNull();
  });

  const SUBSCRIPTION = {
    endpoint: "https://push.example.com/subscription/abc",
    keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
  };

  it("refuses a Web Push subscription while the switch is off, and stores none", async () => {
    await switchGlobal({ webPushGlobal: false });
    const user = await makeUser();

    const res = await callRoute(subscribeWebPush, {
      method: "POST",
      route: "/api/notifications/web-push",
      body: SUBSCRIPTION,
      auth: await makeSession(user),
    });

    expect(res.status).toBe(403);
    expect(
      await prisma.pushSubscription.count({ where: { userId: user.id } }),
    ).toBe(0);
    expect(await channel(user.id, "WEB_PUSH")).toBeNull();
  });

  it("stores the subscription, keys encrypted, and the Web Push channel while the switch is on", async () => {
    await switchGlobal({ webPushGlobal: true });
    const user = await makeUser();

    const res = await callRoute<{ subscribed: boolean }>(subscribeWebPush, {
      method: "POST",
      route: "/api/notifications/web-push",
      body: SUBSCRIPTION,
      auth: await makeSession(user),
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ subscribed: true });
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId: user.id },
    });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].endpoint).toBe(SUBSCRIPTION.endpoint);
    expect(subscriptions[0].p256dh).not.toBe(SUBSCRIPTION.keys.p256dh);
    expect(decrypt(subscriptions[0].p256dh)).toBe(SUBSCRIPTION.keys.p256dh);
    expect(decrypt(subscriptions[0].auth)).toBe(SUBSCRIPTION.keys.auth);
    expect((await channel(user.id, "WEB_PUSH"))?.enabled).toBe(true);
  });

  it("hands a browser's subscription to the account that subscribed it last", async () => {
    await switchGlobal({ webPushGlobal: true });
    const before = await makeUser();
    const after = await makeUser();
    for (const user of [before, after]) {
      const res = await callRoute(subscribeWebPush, {
        method: "POST",
        route: "/api/notifications/web-push",
        body: SUBSCRIPTION,
        auth: await makeSession(user),
      });
      expect(res.status).toBe(200);
    }

    const rows = await prisma.pushSubscription.findMany({
      where: { endpoint: SUBSCRIPTION.endpoint },
      select: { userId: true },
    });
    expect(rows).toEqual([{ userId: after.id }]);
  });
});
