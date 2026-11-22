/**
 * v1.4.46 — coverage for the admin notification-test route, with the
 * focus on the APNS branch that the prior switch was missing entirely
 * (`channel.type === "APNS"` fell through to the "Unknown channel
 * type" default, even though APNs is a first-class channel in the
 * dispatcher and the device-pairing flow). The regression cases pin:
 *
 *   * APNS channel triggers the APNs sender,
 *   * the sender's `ok: true` returns `success: true` in the results
 *     envelope,
 *   * the sender's `ok: false` surfaces its `reason` in the per-channel
 *     error,
 *   * the route co-handles APNS + WEB_PUSH in the same response when
 *     both are enabled,
 *   * un-stubbed channels (NTFY for symmetry) still flow through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    notificationChannel: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((value: string) => `enc(${value})`),
  decrypt: vi.fn((value: string) => value.replace(/^enc\(|\)$/g, "")),
}));

vi.mock("@/lib/notifications/senders/telegram", () => ({
  sendViaTelegram: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/ntfy", () => ({
  sendViaNtfy: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/web-push", () => ({
  sendViaWebPush: vi.fn(),
}));
vi.mock("@/lib/push-relay/apns-channel", () => ({
  sendApnsTestPush: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/webhook", () => ({
  sendViaWebhook: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/email", () => ({
  sendViaEmail: vi.fn(),
}));

vi.mock("@/lib/i18n/server-translator", () => ({
  getServerTranslator: vi.fn(() => ({
    t: (key: string) => key,
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/api-handler";
import { sendApnsTestPush } from "@/lib/push-relay/apns-channel";
import { sendViaWebPush } from "@/lib/notifications/senders/web-push";
import { sendViaNtfy } from "@/lib/notifications/senders/ntfy";
import { sendViaWebhook } from "@/lib/notifications/senders/webhook";
import { sendViaEmail } from "@/lib/notifications/senders/email";

const ADMIN_USER_ID = "admin-1";
const ADMIN_CTX = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: ADMIN_USER_ID,
    username: "admin",
    role: "ADMIN",
  },
} as never;

interface FakeChannelRow {
  id: string;
  userId: string;
  type: "TELEGRAM" | "NTFY" | "WEB_PUSH" | "APNS" | "WEBHOOK" | "EMAIL";
  enabled: boolean;
  config: string;
  preferences: Array<{ eventType: string; enabled: boolean }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
  vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue({
    id: "ch-tg",
    userId: ADMIN_USER_ID,
    type: "TELEGRAM",
  } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    locale: "en",
  } as never);
});

interface ResultEnvelope {
  data: {
    sent: boolean;
    message: string;
    results: Array<{
      channel: string;
      success: boolean;
      error?: string;
      errorCode?: string;
      upstreamStatus?: number;
      smtpCode?: number;
      upstreamBody?: string;
    }>;
  };
}

describe("POST /api/admin/notifications/test — APNS branch (v1.4.46)", () => {
  it("routes APNS channel through the sealed APNs channel with title/message/eventType", async () => {
    const apnsChannel: FakeChannelRow = {
      id: "ch-apns",
      userId: ADMIN_USER_ID,
      type: "APNS",
      enabled: true,
      config: "enc({})",
      preferences: [],
    };
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      apnsChannel,
    ] as never);
    vi.mocked(sendApnsTestPush).mockResolvedValue({ ok: true });

    const res = await POST();
    const body = (await res.json()) as ResultEnvelope;

    expect(sendApnsTestPush).toHaveBeenCalledTimes(1);
    expect(sendApnsTestPush).toHaveBeenCalledWith(
      ADMIN_USER_ID,
      expect.objectContaining({
        title: expect.any(String),
        message: expect.any(String),
        eventType: "SYSTEM_ALERT",
      }),
    );
    expect(body.data.results).toEqual([{ channel: "APNS", success: true }]);
    expect(body.data.sent).toBe(true);
  });

  it("surfaces the APNs sender's reason on failure (per-channel error)", async () => {
    const apnsChannel: FakeChannelRow = {
      id: "ch-apns",
      userId: ADMIN_USER_ID,
      type: "APNS",
      enabled: true,
      config: "enc({})",
      preferences: [],
    };
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      apnsChannel,
    ] as never);
    vi.mocked(sendApnsTestPush).mockResolvedValue({
      ok: false,
      hardReject: false,
      reason: "apns_no_devices",
    });

    const res = await POST();
    const body = (await res.json()) as ResultEnvelope;

    expect(body.data.results).toEqual([
      {
        channel: "APNS",
        success: false,
        error: "apns_no_devices",
      },
    ]);
    expect(body.data.sent).toBe(false);
  });

  it("falls back to a generic error when the sender omits a reason", async () => {
    const apnsChannel: FakeChannelRow = {
      id: "ch-apns",
      userId: ADMIN_USER_ID,
      type: "APNS",
      enabled: true,
      config: "enc({})",
      preferences: [],
    };
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      apnsChannel,
    ] as never);
    vi.mocked(sendApnsTestPush).mockResolvedValue({
      ok: false,
      hardReject: false,
    });

    const res = await POST();
    const body = (await res.json()) as ResultEnvelope;

    expect(body.data.results[0]).toEqual({
      channel: "APNS",
      success: false,
      error: "apns_send_failed",
    });
  });

  it("fans out across APNS + WEB_PUSH in the same response when both enabled", async () => {
    const channels: FakeChannelRow[] = [
      {
        id: "ch-apns",
        userId: ADMIN_USER_ID,
        type: "APNS",
        enabled: true,
        config: "enc({})",
        preferences: [],
      },
      {
        id: "ch-web",
        userId: ADMIN_USER_ID,
        type: "WEB_PUSH",
        enabled: true,
        config: "enc({})",
        preferences: [],
      },
    ];
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue(
      channels as never,
    );
    vi.mocked(sendApnsTestPush).mockResolvedValue({ ok: true });
    vi.mocked(sendViaWebPush).mockResolvedValue({ ok: true });

    const res = await POST();
    const body = (await res.json()) as ResultEnvelope;

    expect(sendApnsTestPush).toHaveBeenCalledTimes(1);
    expect(sendViaWebPush).toHaveBeenCalledTimes(1);
    expect(body.data.results).toEqual([
      { channel: "APNS", success: true },
      { channel: "WEB_PUSH", success: true },
    ]);
    expect(body.data.sent).toBe(true);
  });

  it("does not fall through to the 'Unknown channel type' default for APNS", async () => {
    // Regression for the v1.4.46 bug: pre-fix the switch had no APNS
    // arm and APNs channels reported "Unknown channel type" in the
    // admin UI. The new arm must short-circuit that path.
    const apnsChannel: FakeChannelRow = {
      id: "ch-apns",
      userId: ADMIN_USER_ID,
      type: "APNS",
      enabled: true,
      config: "enc({})",
      preferences: [],
    };
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      apnsChannel,
    ] as never);
    vi.mocked(sendApnsTestPush).mockResolvedValue({ ok: true });

    const res = await POST();
    const body = (await res.json()) as ResultEnvelope;

    expect(body.data.results[0].error).not.toBe("Unknown channel type");
    expect(sendApnsTestPush).toHaveBeenCalled();
  });
});

describe("POST /api/admin/notifications/test — preserved branches", () => {
  it("still routes NTFY channels through sendViaNtfy", async () => {
    const ntfyChannel: FakeChannelRow = {
      id: "ch-ntfy",
      userId: ADMIN_USER_ID,
      type: "NTFY",
      enabled: true,
      config: 'enc({"topic":"hl-test"})',
      preferences: [],
    };
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      ntfyChannel,
    ] as never);
    vi.mocked(sendViaNtfy).mockResolvedValue({ ok: true } as never);

    const res = await POST();
    const body = (await res.json()) as ResultEnvelope;

    expect(sendViaNtfy).toHaveBeenCalledTimes(1);
    expect(body.data.results[0]).toMatchObject({
      channel: "NTFY",
      success: true,
    });
  });
});

describe("POST /api/admin/notifications/test — a failure keeps its cause (#947)", () => {
  function channel(
    type: FakeChannelRow["type"],
    config: string,
  ): FakeChannelRow {
    return {
      id: `ch-${type}`,
      userId: ADMIN_USER_ID,
      type,
      enabled: true,
      config,
      preferences: [],
    };
  }

  it("carries the ntfy status and code instead of a bare sentence", async () => {
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      channel("NTFY", 'enc({"topic":"hl-test"})'),
    ] as never);
    vi.mocked(sendViaNtfy).mockResolvedValue({
      ok: false,
      hardReject: false,
      reason: "ntfy_400",
      statusCode: 400,
    });

    const body = (await (await POST()).json()) as ResultEnvelope;

    expect(body.data.results[0]).toMatchObject({
      channel: "NTFY",
      success: false,
      errorCode: "upstream_rejected",
      upstreamStatus: 400,
    });
    expect(body.data.results[0].error).toContain("HTTP 400");
    expect(body.data.results[0].error).not.toContain("hl-test");
  });

  it("tests the webhook channel rather than calling it unknown", async () => {
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      channel("WEBHOOK", 'enc({"url":"https://relay.example.com/message"})'),
    ] as never);
    vi.mocked(sendViaWebhook).mockResolvedValue({
      ok: false,
      hardReject: false,
      reason: "webhook_400",
      statusCode: 400,
      upstreamBody: "priority must be an integer",
    });

    const body = (await (await POST()).json()) as ResultEnvelope;

    expect(sendViaWebhook).toHaveBeenCalledWith(
      { url: "https://relay.example.com/message" },
      expect.objectContaining({ eventType: "SYSTEM_ALERT" }),
    );
    expect(body.data.results[0]).toMatchObject({
      channel: "WEBHOOK",
      success: false,
      errorCode: "upstream_rejected",
      upstreamStatus: 400,
    });
    // The relay body belongs to the settings card, not the admin toast.
    expect(body.data.results[0].upstreamBody).toBeUndefined();
  });

  it("tests the email channel and forwards the SMTP code", async () => {
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      channel("EMAIL", 'enc({"recipient":"admin@example.com"})'),
    ] as never);
    vi.mocked(sendViaEmail).mockResolvedValue({
      ok: false,
      hardReject: true,
      reason: "email_smtp_5xx",
      failureCode: "upstream_rejected",
      smtpCode: 550,
    });

    const body = (await (await POST()).json()) as ResultEnvelope;

    expect(body.data.results[0]).toMatchObject({
      channel: "EMAIL",
      success: false,
      errorCode: "upstream_rejected",
      smtpCode: 550,
    });
    expect(body.data.results[0].error).toContain("SMTP 550");
  });

  it("forwards a private-origin refusal with its own code", async () => {
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      channel("WEBHOOK", 'enc({"url":"http://10.0.0.5/message"})'),
    ] as never);
    vi.mocked(sendViaWebhook).mockResolvedValue({
      ok: false,
      hardReject: false,
      reason: "webhook_private_origin_refused",
      errorCode: "private_origin_not_approved",
    });

    const body = (await (await POST()).json()) as ResultEnvelope;

    expect(body.data.results[0]).toMatchObject({
      channel: "WEBHOOK",
      success: false,
      errorCode: "private_origin_not_approved",
    });
  });

  it("reports a delivered webhook and email as successes", async () => {
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      channel("WEBHOOK", 'enc({"url":"https://relay.example.com"})'),
      channel("EMAIL", 'enc({"recipient":"admin@example.com"})'),
    ] as never);
    vi.mocked(sendViaWebhook).mockResolvedValue({ ok: true, statusCode: 200 });
    vi.mocked(sendViaEmail).mockResolvedValue({ ok: true });

    const body = (await (await POST()).json()) as ResultEnvelope;

    expect(body.data.results).toEqual([
      { channel: "WEBHOOK", success: true },
      { channel: "EMAIL", success: true },
    ]);
  });
});
