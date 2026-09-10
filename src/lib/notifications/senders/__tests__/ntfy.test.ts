/**
 * ntfy sender unit tests.
 *
 * Covers the outbound shape (topic appended to the server URL, priority and
 * tag headers, bearer token), the outcome classification, and (#947) the
 * NOTIFICATION_PRIVATE_ORIGINS grant: a listed server rides the
 * operator-approved pin, an unlisted one keeps the public pin, and a listed
 * origin admits nothing beside itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeFetchMock = vi.fn();
const recordPushAttemptMock = vi.fn();
const annotateMock = vi.fn();

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

import { sendViaNtfy } from "../ntfy";
import { SafeFetchError } from "@/lib/safe-fetch";

const config = {
  serverUrl: "https://ntfy.example.com/",
  topic: "health",
  authToken: "tk_secret",
};

function payload(over?: Record<string, unknown>) {
  return {
    eventType: "SYSTEM_ALERT" as const,
    userId: "user-1",
    title: "Title",
    message: "<b>Body</b>",
    ...over,
  };
}

type EgressOpts = {
  requirePublicHost?: boolean;
  operatorApprovedPrivateOrigin?: string;
};

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

describe("sendViaNtfy", () => {
  it("POSTs the topic URL through safeFetch under the public pin and returns ok on 200", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    const result = await sendViaNtfy(config, payload());

    expect(result).toEqual({ ok: true, statusCode: 200 });
    const [url, init, opts] = safeFetchMock.mock.calls[0] as [
      string,
      { method?: string; headers?: Record<string, string>; body?: string },
      EgressOpts,
    ];
    expect(url).toBe("https://ntfy.example.com/health");
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBe("Bearer tk_secret");
    expect(init.body).toBe("Body");
    expect(opts.requirePublicHost).toBe(true);
    expect(opts.operatorApprovedPrivateOrigin).toBeUndefined();
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "NTFY", result: "ok" }),
    );
  });

  it("hard-rejects on 410 (topic gone)", async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 410 });

    const result = await sendViaNtfy(config, payload());

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(true);
    expect(result.reason).toBe("ntfy_410_gone");
  });

  it("reports a soft, named refusal when safeFetch blocks a private host (SSRF)", async () => {
    safeFetchMock.mockRejectedValue(
      new SafeFetchError("refused private host", "private_host"),
    );

    const result = await sendViaNtfy(config, payload());

    expect(result).toMatchObject({
      ok: false,
      hardReject: false,
      reason: "ntfy_private_origin_refused",
      errorCode: "private_origin_not_approved",
    });
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "NTFY",
        result: "error",
        reason: "ntfy_private_origin_refused",
      }),
    );
  });

  it("keeps a genuine network fault distinct from a policy refusal", async () => {
    safeFetchMock.mockRejectedValue(new SafeFetchError("timeout", "timeout"));

    const result = await sendViaNtfy(config, payload());

    expect(result.reason).toBe("ntfy_network_error");
    expect(result.errorCode).toBeUndefined();
  });

  describe("NOTIFICATION_PRIVATE_ORIGINS (#947)", () => {
    it("dials a listed server through the operator-approved pin and marks the event", async () => {
      process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://ntfy.lan:8080";
      safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await sendViaNtfy(
        { serverUrl: "http://ntfy.lan:8080", topic: "health" },
        payload(),
      );

      expect(result.ok).toBe(true);
      const [url, , opts] = safeFetchMock.mock.calls[0] as [
        string,
        unknown,
        EgressOpts,
      ];
      expect(url).toBe("http://ntfy.lan:8080/health");
      expect(opts.requirePublicHost).toBe(false);
      expect(opts.operatorApprovedPrivateOrigin).toBe("http://ntfy.lan:8080");
      expect(annotateMock).toHaveBeenCalledWith({
        action: { name: "notification.egress.private_origin" },
      });
      expect(annotateMock).toHaveBeenCalledWith({
        meta: { channel: "ntfy", origin: "http://ntfy.lan:8080" },
      });
    });

    it("keeps the public pin for a server the operator did not list", async () => {
      process.env.NOTIFICATION_PRIVATE_ORIGINS = "https://gotify.example.com";
      safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

      await sendViaNtfy(config, payload());

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
      ["sibling port", "http://ntfy.lan:9090"],
      ["other scheme", "https://ntfy.lan:8080"],
      ["sub-host", "http://push.ntfy.lan:8080"],
      ["unlisted private literal", "http://192.168.1.9"],
    ])(
      "refuses a %s without dialling: a listed origin admits only itself",
      async (_label, serverUrl) => {
        process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://ntfy.lan:8080";

        const result = await sendViaNtfy(
          { serverUrl, topic: "health" },
          payload(),
        );

        expect(safeFetchMock).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          ok: false,
          hardReject: false,
          reason: "ntfy_private_origin_refused",
          errorCode: "private_origin_not_approved",
        });
        expect(annotateMock).not.toHaveBeenCalled();
      },
    );
  });

  it("reports the not-grantable code for a loopback target, without dialling (M1)", async () => {
    const result = await sendViaNtfy(
      { serverUrl: "http://localhost:8080", topic: "health" },
      payload(),
    );

    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      hardReject: false,
      reason: "ntfy_private_origin_refused",
      errorCode: "private_origin_not_grantable",
    });
  });
});
