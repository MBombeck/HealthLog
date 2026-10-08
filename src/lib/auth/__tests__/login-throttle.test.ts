/**
 * The per-account password throttle, against an in-memory rate-limit table.
 *
 * The case it exists for: somebody who is not the owner types wrong passwords
 * for the account from two addresses. That used to lock a password-only
 * account (the phone app's password sign-in with it) for as long as they kept
 * it up. Now the owner's own device or network is not held back at all, and
 * anywhere else waits a bounded, growing time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const table = new Map<string, { count: number; resetAt: number }>();
let now = Date.parse("2026-09-26T12:00:00Z");

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(
    async (key: string, limit: number, windowMs: number) => {
      const row = table.get(key);
      const fresh = !row || row.resetAt < now;
      const next = fresh
        ? { count: 1, resetAt: now + windowMs }
        : { count: row.count + 1, resetAt: row.resetAt };
      table.set(key, next);
      return {
        allowed: next.count <= limit,
        limit,
        remaining: Math.max(0, limit - next.count),
        resetAt: next.resetAt,
      };
    },
  ),
  refundRateLimit: vi.fn(async (key: string) => {
    const row = table.get(key);
    if (row && row.resetAt >= now) row.count = Math.max(0, row.count - 1);
  }),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    rateLimit: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const row = table.get(where.key);
        return row ? { resetAt: new Date(row.resetAt) } : null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { key: string };
          create: { count: number; resetAt: Date };
        }) => {
          table.set(where.key, {
            count: create.count,
            resetAt: create.resetAt.getTime(),
          });
        },
      ),
    },
    trustedDevice: { findUnique: vi.fn(async () => null) },
    refreshToken: { findFirst: vi.fn(async () => null) },
    session: { findFirst: vi.fn(async () => null) },
  },
}));

let deviceCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => (deviceCookie ? { value: deviceCookie } : undefined),
  })),
}));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: (v: string) => `h(${v})` }));

import { prisma } from "@/lib/db";
import {
  beginAccountLoginAttempt,
  BASE_WAIT_MS,
  FREE_FAILURES,
  MAX_WAIT_MS,
  waitAfter,
} from "../login-throttle";

const OWNER = { id: "owner-1" };

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers,
  });
}

/** One password attempt; returns "waiting" or whether it was checked. */
async function guess(
  ip: string,
  opts: { right?: boolean; headers?: Record<string, string> } = {},
): Promise<"waiting" | "checked"> {
  const attempt = await beginAccountLoginAttempt({
    user: OWNER,
    identifier: "owner",
    request: req(opts.headers),
    ip,
  });
  if (attempt.waiting) return "waiting";
  if (opts.right) await attempt.succeeded();
  else await attempt.failed();
  return "checked";
}

beforeEach(() => {
  vi.clearAllMocks();
  table.clear();
  now = Date.parse("2026-09-26T12:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  deviceCookie = undefined;
  vi.mocked(prisma.trustedDevice.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.session.findFirst).mockResolvedValue(null);
});

describe("waitAfter", () => {
  it("is free for the first few failures, then doubles up to the cap", () => {
    expect(waitAfter(FREE_FAILURES - 1)).toBe(0);
    expect(waitAfter(FREE_FAILURES)).toBe(BASE_WAIT_MS);
    expect(waitAfter(FREE_FAILURES + 1)).toBe(2 * BASE_WAIT_MS);
    expect(waitAfter(FREE_FAILURES + 100)).toBe(MAX_WAIT_MS);
  });
});

describe("somebody guessing from two addresses", () => {
  async function tenGuesses() {
    const answers: string[] = [];
    for (let i = 0; i < 10; i++) {
      answers.push(await guess(i % 2 ? "198.51.100.1" : "198.51.100.2"));
    }
    return answers;
  }

  it("is slowed down, not given a lock that lasts", async () => {
    const answers = await tenGuesses();
    // The first five are checked, then the wait holds the rest back.
    expect(answers.slice(0, FREE_FAILURES)).toEqual(
      Array(FREE_FAILURES).fill("checked"),
    );
    expect(answers.slice(FREE_FAILURES)).toContain("waiting");
  });

  it("the owner's phone, known by the device id it signed in with, still gets through", async () => {
    await tenGuesses();
    vi.mocked(prisma.refreshToken.findFirst).mockImplementation((async (args: {
      where: { deviceId?: string };
    }) =>
      args.where.deviceId === "owner-phone" ? { id: "rt-1" } : null) as never);
    expect(
      await guess("203.0.113.50", {
        right: true,
        headers: { "x-device-id": "owner-phone" },
      }),
    ).toBe("checked");
  });

  it("the owner's remembered browser still gets through", async () => {
    await tenGuesses();
    deviceCookie = "device-token";
    // The device's expiry is compared against the wall clock, not the mocked
    // rate-limit clock `now`, so it is anchored to the wall clock too: an
    // expiry fixed relative to `now` expired for real once the calendar
    // passed it.
    vi.mocked(prisma.trustedDevice.findUnique).mockResolvedValue({
      userId: "owner-1",
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    } as never);
    expect(await guess("203.0.113.51", { right: true })).toBe("checked");
  });

  it("the owner's home network, seen on a recent session, still gets through", async () => {
    await tenGuesses();
    vi.mocked(prisma.session.findFirst).mockImplementation((async (args: {
      where: { ipAddress?: string };
    }) =>
      args.where.ipAddress === "203.0.113.9" ? { id: "s-1" } : null) as never);
    expect(await guess("203.0.113.9", { right: true })).toBe("checked");
  });

  it("a place the account has signed in from never counts toward the wait", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({
      id: "s-1",
    } as never);
    for (let i = 0; i < 20; i++) {
      expect(await guess("203.0.113.9")).toBe("checked");
    }
    vi.mocked(prisma.session.findFirst).mockResolvedValue(null);
    expect(await guess("198.51.100.1")).toBe("checked");
  });

  it("an unknown place waits at most fifteen minutes, however long the guessing went on", async () => {
    for (let i = 0; i < 40; i++) {
      await guess("198.51.100.1");
      now += MAX_WAIT_MS; // the guesser comes back as soon as allowed
    }
    await guess("198.51.100.1"); // one more failure, the longest wait
    now += MAX_WAIT_MS + 1;
    expect(await guess("203.0.113.77", { right: true })).toBe("checked");
  });

  it("a right password gives its attempt back", async () => {
    await guess("198.51.100.1");
    await guess("198.51.100.1", { right: true });
    expect(table.get("auth:login:account:u:owner-1")?.count).toBe(1);
  });
});

describe("an identifier that names no account", () => {
  it("runs the same arithmetic on its hash", async () => {
    for (let i = 0; i < FREE_FAILURES + 1; i++) {
      const attempt = await beginAccountLoginAttempt({
        user: null,
        identifier: "Nobody",
        request: req(),
        ip: "198.51.100.1",
      });
      await attempt.failed();
    }
    expect(table.has("auth:login:account:i:h(nobody):wait")).toBe(true);
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
  });
});
