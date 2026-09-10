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

import { sendViaWebhook } from "../webhook";
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
});
