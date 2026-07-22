/**
 * v1.4.48 M3 — unit-level coverage for the atomic nonce-consumption
 * branch.
 *
 * The integration tests in `tests/integration/withings-oauth*.test.ts`
 * already pin the full handshake against real Postgres (happy path,
 * replay, expired, cross-user). This file specifically targets the
 * delete-first race window the M3 refactor closed: two concurrent
 * callbacks with the same nonce — the first wins, the second hits
 * Prisma P2025 and lands on the replay branch.
 *
 * Co-tests M7 — non-P2025 delete failures (DB-connection drop /
 * integrity violation) surface via Wide-Event `addWarning` instead
 * of being silently swallowed.
 *
 * v1.4.49 — assertions updated for the four-way reason-tag split
 * (`csrf1`, `replay`, `expired`, `cross_user`) and the QA-2
 * err.name-only warning template.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "user-1" },
    session: { id: "sess-1" },
  })),
  HttpError: class HttpError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    withingsOAuthState: {
      delete: vi.fn(),
    },
    withingsConnection: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((s: string) => `enc(${s})`),
}));

vi.mock("@/lib/withings/client", () => ({
  exchangeCode: vi.fn(),
  WITHINGS_OAUTH_SCOPE: "user.metrics,user.activity",
}));

vi.mock("@/lib/withings/credentials", () => ({
  getUserWithingsCredentials: vi.fn(),
}));

vi.mock("@/lib/withings/sync", () => ({
  setupWebhook: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/integrations/status", () => ({
  markReconnected: vi.fn(),
}));

const addWarning = vi.fn();
const annotateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logging/context", () => ({
  annotate: annotateMock,
  getEvent: vi.fn(() => ({ addWarning, setError: vi.fn() })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

const NONCE = "abcdefghijklmnopqrstuv"; // 22-char base64url
const APP_URL = "http://localhost:3000";

function callbackRequest(state: string, cookieState: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/withings/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
    {
      method: "GET",
      headers: {
        cookie: `withings_state=${cookieState}`,
      },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
});

describe("withings/callback atomic nonce consumption (M3)", () => {
  it("concurrent callbacks with the same nonce — only one succeeds, the second hits the P2025 replay branch", async () => {
    // First callback: delete returns the row (win the race).
    // Second callback: delete throws P2025 (row already consumed).
    const winningRow = {
      nonce: NONCE,
      userId: "user-1",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    };
    const p2025 = new Prisma.PrismaClientKnownRequestError(
      "An operation failed because it depends on one or more records that were required but not found.",
      { code: "P2025", clientVersion: "x" },
    );

    const deleteMock = vi.mocked(prisma.withingsOAuthState.delete);
    deleteMock
      .mockResolvedValueOnce(winningRow as never)
      .mockRejectedValueOnce(p2025);

    // Stub the rest of the happy path for the winning request — code
    // exchange returns plausible tokens so the upsert + redirect run.
    const { getUserWithingsCredentials } =
      await import("@/lib/withings/credentials");
    vi.mocked(getUserWithingsCredentials).mockResolvedValue({
      clientId: "cid",
      clientSecret: "csec",
    } as never);
    const { exchangeCode } = await import("@/lib/withings/client");
    vi.mocked(exchangeCode).mockResolvedValue({
      userid: "wuid",
      access_token: "atok",
      refresh_token: "rtok",
      expires_in: 3600,
    } as never);

    // Fire both legs concurrently. The mock's call ordering is FIFO,
    // so whichever `await` hits the Prisma mock first gets the
    // success result. Both legs use the same nonce + cookie value.
    const reqA = callbackRequest(NONCE, NONCE);
    const reqB = callbackRequest(NONCE, NONCE);
    const [resA, resB] = await Promise.all([GET(reqA), GET(reqB)]);

    // Both responses are 307 redirects.
    expect(resA.status).toBe(307);
    expect(resB.status).toBe(307);

    // Exactly one delete-attempt per leg — the atomic shape collapses
    // findUnique + delete into a single round-trip.
    expect(deleteMock).toHaveBeenCalledTimes(2);
    const upsert = vi.mocked(prisma.withingsConnection.upsert).mock
      .calls[0]![0];
    expect(upsert.update).toMatchObject({
      webhookSubscriptionState: Prisma.DbNull,
      webhookSubscriptionRetryAt: expect.any(Date),
    });
    expect(upsert.create).toMatchObject({
      webhookSubscriptionState: Prisma.DbNull,
      webhookSubscriptionRetryAt: expect.any(Date),
    });

    // Exactly one leg landed on `withings=connected`, exactly one
    // landed on the replay branch (`withings=error&reason=replay`).
    const locations = [resA, resB].map((r) => r.headers.get("location")).sort();
    expect(locations).toHaveLength(2);
    expect(locations.some((l) => l?.includes("withings=connected"))).toBe(true);
    expect(
      locations.some((l) => l?.includes("withings=error&reason=replay")),
    ).toBe(true);

    // P2025 must NOT surface as a warning — it's the expected
    // replay-branch signal, not a real infra problem.
    expect(addWarning).not.toHaveBeenCalled();

    // Wide-Event annotation carries the same reason so operators can
    // grep without DB-shell.
    expect(annotateMock).toHaveBeenCalledWith({ meta: { reason: "replay" } });
  });

  it("non-P2025 delete failure (e.g. connection drop) surfaces a Wide-Event warning carrying err.name only, and bounces to the error page", async () => {
    // M7 — a real infra failure on the consume-delete must not be
    // silently swallowed.
    //
    // v1.4.49 QA-2 — the warning template now interpolates `err.name`
    // rather than `${err}`. A Prisma error whose `message` echoes the
    // offending value (e.g. the raw nonce) into the wide-event log
    // would otherwise leak it.
    class TimeoutError extends Error {
      constructor() {
        super("connection terminated unexpectedly nonce=abc123");
        this.name = "TimeoutError";
      }
    }
    vi.mocked(prisma.withingsOAuthState.delete).mockRejectedValueOnce(
      new TimeoutError(),
    );

    const req = callbackRequest(NONCE, NONCE);
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "withings=error&reason=state",
    );

    // The warning carries the error NAME so the audit trail can
    // distinguish "row was gone" (P2025, no warning) from "DB unhappy"
    // (warning, infra signal) without ever interpolating the message
    // body.
    expect(addWarning).toHaveBeenCalledTimes(1);
    expect(addWarning).toHaveBeenCalledWith(
      "oauth-state-delete failed: TimeoutError",
    );
    // Defensive: the message body (which Prisma may use to echo the
    // offending value) must not appear in the warning.
    expect(addWarning).not.toHaveBeenCalledWith(
      expect.stringContaining("nonce=abc123"),
    );
    expect(addWarning).not.toHaveBeenCalledWith(
      expect.stringContaining("connection terminated"),
    );
  });

  it("delete succeeds but row has expired — validity check trips with reason=expired, no token exchange", async () => {
    const expiredRow = {
      nonce: NONCE,
      userId: "user-1",
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
    };
    vi.mocked(prisma.withingsOAuthState.delete).mockResolvedValueOnce(
      expiredRow as never,
    );

    const { exchangeCode } = await import("@/lib/withings/client");

    const req = callbackRequest(NONCE, NONCE);
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "withings=error&reason=expired",
    );
    // Single atomic round-trip consumed the row; no token exchange.
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(annotateMock).toHaveBeenCalledWith({ meta: { reason: "expired" } });
  });

  it("delete succeeds but row's userId mismatches session — validity check trips with reason=cross_user, no token exchange", async () => {
    const crossUserRow = {
      nonce: NONCE,
      userId: "user-OTHER",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    };
    vi.mocked(prisma.withingsOAuthState.delete).mockResolvedValueOnce(
      crossUserRow as never,
    );

    const { exchangeCode } = await import("@/lib/withings/client");

    const req = callbackRequest(NONCE, NONCE);
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "withings=error&reason=cross_user",
    );
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(annotateMock).toHaveBeenCalledWith({
      meta: { reason: "cross_user" },
    });
  });

  it("non-P2025 infra error branch annotates reason=state on the Wide Event (legacy fallback for unclassified DB failures)", async () => {
    // v1.4.49 — the four named reasons (csrf1, replay, expired,
    // cross_user) cover every "we know what went wrong" branch. A
    // raw infra failure is intentionally still tagged `state` —
    // operators reading the wide event will see the err.name in the
    // warning and the `reason=state` annotation, which is enough to
    // distinguish it from the four classified branches.
    class TimeoutError extends Error {
      constructor() {
        super("connection terminated");
        this.name = "TimeoutError";
      }
    }
    vi.mocked(prisma.withingsOAuthState.delete).mockRejectedValueOnce(
      new TimeoutError(),
    );

    const req = callbackRequest(NONCE, NONCE);
    await GET(req);

    expect(annotateMock).toHaveBeenCalledWith({ meta: { reason: "state" } });
  });

  it("URL state vs cookie state mismatch short-circuits with reason=csrf1 BEFORE the atomic delete fires", async () => {
    // CSRF leg 1 — must reject without touching the ledger so a
    // probe can't grief legitimate rows by issuing deletes for
    // nonces it doesn't legitimately hold the cookie for.
    const req = callbackRequest(
      "aaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbb",
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "withings=error&reason=csrf1",
    );
    expect(prisma.withingsOAuthState.delete).not.toHaveBeenCalled();
    expect(annotateMock).toHaveBeenCalledWith({ meta: { reason: "csrf1" } });
  });
});
