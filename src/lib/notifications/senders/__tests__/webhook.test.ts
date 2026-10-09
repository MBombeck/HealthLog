/**
 * Generic-webhook sender unit tests (v1.17.1).
 *
 * Covers: success, hard-reject classification (404/410/401/403), SSRF block
 * (safeFetch throws `private_host`), cooldown-relevant transient classification
 * (5xx), the push_attempts ledger write per outcome, and (#947) the
 * NOTIFICATION_PRIVATE_ORIGINS grant: a listed origin rides the
 * operator-approved pin, an unlisted one keeps the public pin, and a listed
 * origin admits nothing beside itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeFetchMock = vi.fn();
const recordPushAttemptMock = vi.fn();

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  SafeFetchError: class SafeFetchError extends Error {
    kind: string;
    constructor(message: string, kind: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

const annotateMock = vi.fn();
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: vi.fn(),
    addExternalCall: vi.fn(),
    hasAction: () => false,
  }),
  annotate: (...args: unknown[]) => annotateMock(...args),
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: (...args: unknown[]) => recordPushAttemptMock(...args),
  recordPushAttemptForPayload: (
    _payload: unknown,
    _recipientUserId: string,
    attempt: unknown,
  ) => recordPushAttemptMock(attempt),
}));

import { buildWebhookBody, sendViaWebhook } from "../webhook";
import { SafeFetchError } from "@/lib/safe-fetch";

const config = {
  url: "https://gotify.example.com/message",
  headerName: "Authorization",
  headerValue: "Bearer secret",
};

function payload(over?: Record<string, unknown>) {
  return {
    eventType: "SYSTEM_ALERT" as const,
    userId: "user-1",
    title: "Title",
    message: "Body",
    ...over,
  };
}

const ORIGINAL_PRIVATE_ORIGINS = process.env.NOTIFICATION_PRIVATE_ORIGINS;

beforeEach(() => {
  safeFetchMock.mockReset();
  recordPushAttemptMock.mockReset();
  annotateMock.mockReset();
  delete process.env.NOTIFICATION_PRIVATE_ORIGINS;
});

afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_PRIVATE_ORIGINS === undefined) {
    delete process.env.NOTIFICATION_PRIVATE_ORIGINS;
  } else {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = ORIGINAL_PRIVATE_ORIGINS;
  }
});

type EgressOpts = {
  requirePublicHost?: boolean;
  operatorApprovedPrivateOrigin?: string;
};

describe("sendViaWebhook", () => {
  it("POSTs through safeFetch with requirePublicHost and returns ok on 200", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    const result = await sendViaWebhook(config, payload());

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    // SSRF floor + DNS-rebinding pin: requirePublicHost must be set.
    const [, init, opts] = safeFetchMock.mock.calls[0];
    expect((opts as { requirePublicHost?: boolean }).requirePublicHost).toBe(
      true,
    );
    expect((init as { method?: string }).method).toBe("POST");
    // Custom header is attached.
    expect(
      (init as { headers?: Record<string, string> }).headers?.Authorization,
    ).toBe("Bearer secret");
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "WEBHOOK", result: "ok" }),
    );
  });

  it("hard-rejects on 410 (endpoint gone)", async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 410 });

    const result = await sendViaWebhook(config, payload());

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(true);
    expect(result.reason).toBe("webhook_410_gone");
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "WEBHOOK", result: "error" }),
    );
  });

  it("hard-rejects on 401/403 (shared secret wrong)", async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 403 });
    const result = await sendViaWebhook(config, payload());
    expect(result.hardReject).toBe(true);
    expect(result.reason).toBe("webhook_auth_rejected");
  });

  it("soft-fails on 503 (transient — eligible for backoff)", async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 503 });

    const result = await sendViaWebhook(config, payload());

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(false);
    expect(result.reason).toBe("webhook_503");
  });

  it("reports a soft, named refusal when safeFetch blocks a private host (SSRF)", async () => {
    // Before #947 this collapsed into `webhook_network_error` and the test
    // button answered a bare 500. The refusal stays soft (delivery resumes
    // the moment the operator lists the origin) but names itself.
    safeFetchMock.mockRejectedValue(
      new SafeFetchError("refused private host", "private_host"),
    );

    const result = await sendViaWebhook(config, payload());

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(false);
    expect(result.reason).toBe("webhook_private_origin_refused");
    expect(result.errorCode).toBe("private_origin_not_approved");
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "WEBHOOK",
        result: "error",
        reason: "webhook_private_origin_refused",
      }),
    );
  });

  it("keeps a genuine network fault distinct from a policy refusal", async () => {
    safeFetchMock.mockRejectedValue(
      new SafeFetchError("socket hang up", "network"),
    );

    const result = await sendViaWebhook(config, payload());

    expect(result.reason).toBe("webhook_network_error");
    expect(result.errorCode).toBeUndefined();
  });

  it("omits the custom header when not configured", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaWebhook({ url: "https://example.com/hook" }, payload());
    const [, init] = safeFetchMock.mock.calls[0];
    expect(
      (init as { headers?: Record<string, string> }).headers?.Authorization,
    ).toBeUndefined();
  });

  describe("NOTIFICATION_PRIVATE_ORIGINS (#947)", () => {
    it("dials a listed origin through the operator-approved pin and marks the event", async () => {
      process.env.NOTIFICATION_PRIVATE_ORIGINS =
        "https://gotify.example.com, http://ntfy.lan:8080";
      safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await sendViaWebhook(config, payload());

      expect(result.ok).toBe(true);
      const [url, , opts] = safeFetchMock.mock.calls[0] as [
        string,
        unknown,
        EgressOpts,
      ];
      expect(url).toBe("https://gotify.example.com/message");
      expect(opts.requirePublicHost).toBe(false);
      expect(opts.operatorApprovedPrivateOrigin).toBe(
        "https://gotify.example.com",
      );
      expect(annotateMock).toHaveBeenCalledWith({
        action: { name: "notification.egress.private_origin" },
      });
      expect(annotateMock).toHaveBeenCalledWith({
        meta: { channel: "webhook", origin: "https://gotify.example.com" },
      });
    });

    it("keeps the public pin for a target the operator did not list", async () => {
      process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://ntfy.lan:8080";
      safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

      await sendViaWebhook(config, payload());

      const [, , opts] = safeFetchMock.mock.calls[0] as [
        string,
        unknown,
        EgressOpts,
      ];
      expect(opts.requirePublicHost).toBe(true);
      expect(opts.operatorApprovedPrivateOrigin).toBeUndefined();
      expect(annotateMock).not.toHaveBeenCalled();
    });

    it.each([
      ["sibling port", "https://gotify.example.com:8443/message"],
      ["other scheme", "http://gotify.example.com/message"],
      ["sub-host", "https://push.gotify.example.com/message"],
      ["unlisted private literal", "http://10.0.0.9/message"],
    ])(
      "refuses a %s without dialling: a listed origin admits only itself",
      async (_label, url) => {
        process.env.NOTIFICATION_PRIVATE_ORIGINS = "https://gotify.example.com";

        const result = await sendViaWebhook({ url }, payload());

        expect(safeFetchMock).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          ok: false,
          hardReject: false,
          reason: "webhook_private_origin_refused",
          errorCode: "private_origin_not_approved",
        });
        expect(annotateMock).not.toHaveBeenCalled();
      },
    );

    it("approves a listed literal private address the input floor alone would refuse", async () => {
      process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://10.0.0.9:8080";
      safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await sendViaWebhook(
        { url: "http://10.0.0.9:8080/message" },
        payload(),
      );

      expect(result.ok).toBe(true);
      const [, , opts] = safeFetchMock.mock.calls[0] as [
        string,
        unknown,
        EgressOpts,
      ];
      expect(opts.operatorApprovedPrivateOrigin).toBe("http://10.0.0.9:8080");
    });
  });

  it("reports the not-grantable code for a metadata target, without dialling (M1)", async () => {
    const result = await sendViaWebhook(
      { url: "http://169.254.169.254/latest" },
      payload(),
    );

    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      hardReject: false,
      reason: "webhook_private_origin_refused",
      errorCode: "private_origin_not_grantable",
    });
  });
});

describe("sendViaWebhook — what the relay said (#947)", () => {
  it("carries a short error body on a non-2xx", async () => {
    safeFetchMock.mockResolvedValue(
      new Response('{"error":"Bad Request","errorCode":400}', { status: 400 }),
    );

    const result = await sendViaWebhook(config, payload());

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      reason: "webhook_400",
      upstreamBody: '{"error":"Bad Request","errorCode":400}',
    });
    // The ledger row keeps the reason only, never the body.
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ upstreamBody: expect.anything() }),
    );
  });

  it("drops a body that echoes the header token or a query token", async () => {
    safeFetchMock.mockResolvedValueOnce(
      new Response("invalid token secret", { status: 401 }),
    );
    const viaHeader = await sendViaWebhook(config, payload());
    expect(viaHeader.upstreamBody).toBeUndefined();

    safeFetchMock.mockResolvedValueOnce(
      new Response("unknown token Q1w2E3r4", { status: 401 }),
    );
    const viaQuery = await sendViaWebhook(
      { url: "https://relay.example.com/message?token=Q1w2E3r4" },
      payload(),
    );
    expect(viaQuery.upstreamBody).toBeUndefined();
  });

  it("names a timeout and a refused connection, and leaves an unknown fault uncoded", async () => {
    safeFetchMock.mockRejectedValueOnce(
      new SafeFetchError("timed out", "timeout"),
    );
    expect((await sendViaWebhook(config, payload())).failureCode).toBe(
      "timeout",
    );

    safeFetchMock.mockRejectedValueOnce(
      new SafeFetchError("ECONNREFUSED", "network"),
    );
    expect((await sendViaWebhook(config, payload())).failureCode).toBe(
      "connection_failed",
    );

    safeFetchMock.mockRejectedValueOnce(new TypeError("boom"));
    expect(
      (await sendViaWebhook(config, payload())).failureCode,
    ).toBeUndefined();
  });
});

function sentBody(): string {
  return (safeFetchMock.mock.calls[0][1] as { body: string }).body;
}

// The chat-target fields appended after the four original ones (v1.42.0).
const CHAT_TAIL =
  ',"content":"Title\\nBody","text":"Title\\nBody","allowed_mentions":{"parse":[]}}';

describe("sendViaWebhook — generic body stays byte for byte", () => {
  // Literal strings, not re-parsed objects: a Home Assistant or n8n rule
  // that matches on the raw body must keep matching after the format choice
  // was added. The four original fields keep their values and their order;
  // the Discord and Slack fields only follow them.
  it.each([
    [
      "a routine event",
      {},
      '{"title":"Title","message":"Body","eventType":"SYSTEM_ALERT","priority":"default"' +
        CHAT_TAIL,
    ],
    [
      "a medication reminder",
      { eventType: "MEDICATION_REMINDER" },
      '{"title":"Title","message":"Body","eventType":"MEDICATION_REMINDER","priority":"high"' +
        CHAT_TAIL,
    ],
    [
      "an urgent event",
      { urgent: true },
      '{"title":"Title","message":"Body","eventType":"SYSTEM_ALERT","priority":"urgent"' +
        CHAT_TAIL,
    ],
    [
      "a discreet cycle event",
      { eventType: "CYCLE_PERIOD_SOON", discreet: true },
      '{"title":"Title","message":"Body","eventType":"reminder","priority":"default"' +
        CHAT_TAIL,
    ],
  ])("%s", async (_label, over, expected) => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await sendViaWebhook(
      { url: "https://relay.example.com/hook" },
      payload(over),
    );

    expect(sentBody()).toBe(expected);
  });
});

describe("buildWebhookBody — Discord and Slack", () => {
  const generic = { format: "generic" as const };

  it("carries content for Discord and text for Slack, as plain title and message", () => {
    const body = JSON.parse(
      buildWebhookBody(
        generic,
        payload({ title: "Reminder", message: "<b>Take</b> your dose" }),
      ),
    );

    expect(body.content).toBe("Reminder\nTake your dose");
    expect(body.text).toBe("Reminder\nTake your dose");
    expect(body).toMatchObject({
      title: "Reminder",
      message: "Take your dose",
      eventType: "SYSTEM_ALERT",
      priority: "default",
    });
  });

  it("tells Discord to resolve no mentions", () => {
    const body = JSON.parse(
      buildWebhookBody(
        generic,
        payload({ message: "@everyone @here <@123456789012345678>" }),
      ),
    );

    expect(body.allowed_mentions).toEqual({ parse: [] });
    // The text itself is left alone; the empty parse list is what disarms it.
    expect(body.content).toContain("@everyone");
  });

  it("keeps content within Discord's 2000 characters, ending in an ellipsis", () => {
    const long = "x".repeat(5000);
    const body = JSON.parse(
      buildWebhookBody(generic, payload({ message: long })),
    );

    expect(Array.from(body.content as string)).toHaveLength(2000);
    expect(body.content.startsWith("Title\nxxx")).toBe(true);
    expect(body.content.endsWith("\u2026")).toBe(true);
    // Slack and the relay fields keep the whole message.
    expect(body.text).toBe(`Title\n${long}`);
    expect(body.message).toBe(long);
  });

  it("leaves content alone at exactly 2000 characters", () => {
    const message = "y".repeat(2000 - "Title\n".length);
    const body = JSON.parse(buildWebhookBody(generic, payload({ message })));

    expect(body.content).toBe(`Title\n${message}`);
    expect(body.content).not.toContain("\u2026");
  });

  it("never splits a surrogate pair when it cuts", () => {
    const body = JSON.parse(
      buildWebhookBody(
        generic,
        payload({
          eventType: "SYSTEM_ALERT",
          message: "\u{1F600}".repeat(3000),
        }),
      ),
    );

    const points = Array.from(body.content as string);
    expect(points).toHaveLength(2000);
    expect(body.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("puts only the masked text into content and text in discreet mode", () => {
    // The dispatcher masks title and message upstream; the body must not
    // reintroduce the cycle event anywhere.
    const raw = buildWebhookBody(
      generic,
      payload({
        eventType: "CYCLE_PERIOD_SOON",
        discreet: true,
        title: "HealthLog",
        message: "HealthLog reminder",
      }),
    );
    const body = JSON.parse(raw);

    expect(raw).not.toContain("CYCLE");
    expect(body.eventType).toBe("reminder");
    expect(body.content).toBe("HealthLog\nHealthLog reminder");
    expect(body.text).toBe("HealthLog\nHealthLog reminder");
  });

  it("leaves the Gotify body without the chat fields", () => {
    const body = JSON.parse(buildWebhookBody({ format: "gotify" }, payload()));

    expect(body).not.toHaveProperty("content");
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("allowed_mentions");
  });
});

describe("sendViaWebhook — Gotify format (#947)", () => {
  const gotify = {
    url: "https://gotify.example.com/message",
    headerName: "X-Gotify-Key",
    headerValue: "AbCdEfGh123",
    format: "gotify" as const,
  };

  it("sends the body Gotify binds, with an integer priority and no eventType field", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await sendViaWebhook(gotify, payload({ message: "<b>Body</b>" }));

    expect(JSON.parse(sentBody())).toEqual({
      title: "Title",
      message: "Body",
      priority: 5,
      extras: {
        "client::display": { contentType: "text/plain" },
        "healthlog::event": { type: "SYSTEM_ALERT" },
      },
    });
    const [url, init] = safeFetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe("https://gotify.example.com/message");
    expect(init.headers["X-Gotify-Key"]).toBe("AbCdEfGh123");
  });

  it.each([
    ["a routine event", 5, {}],
    ["a medication reminder", 8, { eventType: "MEDICATION_REMINDER" }],
    ["an urgent event", 10, { urgent: true }],
    [
      "an urgent medication reminder",
      10,
      { eventType: "MEDICATION_REMINDER", urgent: true },
    ],
  ])("maps %s to priority %i", async (_label, priority, over) => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await sendViaWebhook(gotify, payload(over));

    const body = JSON.parse(sentBody());
    expect(body.priority).toBe(priority);
    expect(Number.isInteger(body.priority)).toBe(true);
  });

  it("keeps the cycle event name out of a discreet message", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await sendViaWebhook(
      gotify,
      payload({ eventType: "CYCLE_PERIOD_SOON", discreet: true }),
    );

    expect(sentBody()).not.toContain("CYCLE");
    expect(JSON.parse(sentBody()).extras["healthlog::event"]).toEqual({
      type: "reminder",
    });
  });

  it("treats an unknown stored format as generic", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await sendViaWebhook(
      { url: "https://relay.example.com/hook", format: "bogus" as never },
      payload(),
    );

    expect(JSON.parse(sentBody()).priority).toBe("default");
  });
});
