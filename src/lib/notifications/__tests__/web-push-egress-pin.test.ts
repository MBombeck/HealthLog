/**
 * Web Push egress must run through the pinned dispatcher.
 *
 * The push endpoint host is USER-CONTROLLED — the browser hands it over at
 * subscribe time and the server stores it. `isPublicUrl` is checked both at
 * subscribe time and again before each dial, but it is a literal, input-time
 * check: it cannot see a DNS rebind between the accept and the connect. With a
 * short-TTL record an attacker flips the host to `169.254.169.254` or an
 * internal address after the check passes, and the dial reaches the pod's
 * private network (issue #217).
 *
 * `web-push`'s `sendNotification` dials with its own internal `https.request`,
 * which bypasses `safeFetch` entirely and therefore bypasses the pinned
 * dispatcher. The sender signs and encrypts via `generateRequestDetails`
 * — identical VAPID + payload handling — and dials through `safeFetch` with
 * `requirePublicHost: true`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetchMock, findManyMock, deleteManyMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  findManyMock: vi.fn(),
  deleteManyMock: vi.fn(),
}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: vi.fn(),
    addExternalCall: vi.fn(),
    setError: vi.fn(),
    addMeta: vi.fn(),
  }),
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: vi.fn(),
  recordPushAttemptForPayload: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    pushSubscription: { findMany: findManyMock, deleteMany: deleteManyMock },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
}));

vi.mock("@/lib/notifications/vapid-config", () => ({
  getVapidConfig: () =>
    Promise.resolve({
      subject: "mailto:a@b.c",
      publicKey: "pub",
      privateKey: "priv",
    }),
}));

vi.mock("@/lib/validations/notifications", () => ({
  isPublicUrl: () => true,
}));

vi.mock("web-push", () => ({
  setVapidDetails: vi.fn(),
  generateRequestDetails: () => ({
    endpoint: "https://push.example.com/x",
    method: "POST",
    headers: { TTL: "60" },
    body: null,
  }),
}));

import { sendViaWebPush } from "../senders/web-push";

const SUB = {
  id: "s1",
  endpoint: "https://push.example.com/x",
  p256dh: "a",
  auth: "b",
};

beforeEach(() => {
  safeFetchMock.mockReset();
  findManyMock.mockReset();
  deleteManyMock.mockReset();
  deleteManyMock.mockResolvedValue({ count: 0 });
  findManyMock.mockResolvedValue([SUB]);
  safeFetchMock.mockResolvedValue({ ok: true, status: 201 });
});

function optsOfFirstCall() {
  return safeFetchMock.mock.calls[0]?.[2] as
    { requirePublicHost?: boolean } | undefined;
}

describe("sendViaWebPush egress", () => {
  it("dials through safeFetch, not web-push's own transport", async () => {
    const res = await sendViaWebPush("user-1", {
      eventType: "MEDICATION_REMINDER",
      userId: "user-1",
      title: "T",
      message: "M",
    });
    expect(res.ok).toBe(true);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("pins the connect-time host check with requirePublicHost", async () => {
    await sendViaWebPush("user-1", {
      eventType: "MEDICATION_REMINDER",
      userId: "user-1",
      title: "T",
      message: "M",
    });
    expect(optsOfFirstCall()?.requirePublicHost).toBe(true);
  });

  it("maps a 410 onto the expiry-reap path", async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 410 });
    await sendViaWebPush("user-1", {
      eventType: "MEDICATION_REMINDER",
      userId: "user-1",
      title: "T",
      message: "M",
    });
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["s1"] } },
    });
  });
});
