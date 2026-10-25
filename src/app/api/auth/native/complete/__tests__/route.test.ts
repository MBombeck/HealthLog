/**
 * GET /api/auth/native/complete — the freshness-bound code mint (iOS #65).
 *
 * The load-bearing test is the mandatory-refusal one (red-team A3): a STALE
 * session (createdAt < startedAt) is refused with a specific reason AND mints no
 * code / row. This file is the mutation-check target for the freshness gate
 * (flip the comparison in the route → the stale-refusal case goes RED).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY = "0".repeat(64);

vi.mock("@/lib/api-handler", () => ({ apiHandler: (fn: unknown) => fn }));

vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(),
}));

const validateSessionWithCreatedAt = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  validateSessionWithCreatedAt: (v: unknown) => validateSessionWithCreatedAt(v),
}));

// Keep the real shared core (buildHandoffCallbackUrl is used by
// native-web-handoff) but stub the mint so we can assert called / not-called.
vi.mock("@/lib/auth/native-handoff", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/auth/native-handoff")>();
  return { ...actual, mintNativeHandoff: vi.fn() };
});

vi.mock("@/lib/db", () => ({
  prisma: { session: { delete: vi.fn().mockResolvedValue({}) } },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { GET } from "../route";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { mintNativeHandoff } from "@/lib/auth/native-handoff";
import { prisma } from "@/lib/db";
import { fixtureSessionSecret } from "@/__tests__/helpers/session-secret";
import {
  NATIVE_HANDOFF_STATE_COOKIE,
  encodeNativeHandoffState,
} from "@/lib/auth/native-web-handoff";

const STARTED_AT = new Date("2026-07-24T10:00:00.000Z");

/** Build a request carrying a valid encrypted state cookie + a session cookie. */
function makeRequest(opts: {
  withState?: boolean;
  stateValue?: string;
  withSession?: boolean;
}): NextRequest {
  const r = new NextRequest("http://localhost/api/auth/native/complete");
  if (opts.stateValue !== undefined) {
    r.cookies.set(NATIVE_HANDOFF_STATE_COOKIE, opts.stateValue);
  } else if (opts.withState !== false) {
    r.cookies.set(
      NATIVE_HANDOFF_STATE_COOKIE,
      encodeNativeHandoffState({
        appCodeChallenge: "a".repeat(43),
        startedAt: STARTED_AT.toISOString(),
      }),
    );
  }
  if (opts.withSession !== false) {
    r.cookies.set("healthlog_session", fixtureSessionSecret());
  }
  return r;
}

function sessionCreatedAt(createdAt: Date) {
  return {
    session: {
      id: "sess-1",
      createdAt,
      expiresAt: new Date(Date.now() + 1000000),
    },
    user: { id: "user-1", username: "alice" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    ip: "1.2.3.4",
  } as never);
  vi.mocked(mintNativeHandoff).mockResolvedValue({
    code: "hlh_" + "z".repeat(43),
    handoffId: "ho-1",
  });
});

describe("GET /api/auth/native/complete", () => {
  it("fresh session → mints a web_login code and redirects to the scheme", async () => {
    // createdAt AFTER startedAt: the user authenticated inside this flow.
    validateSessionWithCreatedAt.mockResolvedValue(
      sessionCreatedAt(new Date(STARTED_AT.getTime() + 1000)),
    );

    const res = await GET(makeRequest({}));

    const location = res.headers.get("location")!;
    expect(location.startsWith("healthlog://login-callback?code=hlh_")).toBe(
      true,
    );
    // The token pair never rides the URL — only the code.
    expect(location).not.toContain("token");
    expect(location).not.toContain("refresh");

    expect(mintNativeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        appCodeChallenge: "a".repeat(43),
        flow: "web_login",
      }),
    );
    // State cookie deleted + scaffold session destroyed + session cookie cleared.
    expect(res.cookies.get(NATIVE_HANDOFF_STATE_COOKIE)?.value).toBe("");
    expect(prisma.session.delete).toHaveBeenCalledWith({
      where: { id: "sess-1" },
    });
    expect(res.cookies.get("healthlog_session")?.value).toBe("");
  });

  it("A3 — STALE session (createdAt < startedAt) is REFUSED and mints nothing", async () => {
    validateSessionWithCreatedAt.mockResolvedValue(
      sessionCreatedAt(new Date(STARTED_AT.getTime() - 1000)),
    );

    const res = await GET(makeRequest({}));

    expect(res.headers.get("location")).toBe(
      "healthlog://login-callback?error=stale_session",
    );
    // No code minted, no scaffold session destroyed.
    expect(mintNativeHandoff).not.toHaveBeenCalled();
    expect(prisma.session.delete).not.toHaveBeenCalled();
    // The single-use state cookie is still cleared on the failure branch.
    expect(res.cookies.get(NATIVE_HANDOFF_STATE_COOKIE)?.value).toBe("");
  });

  it("no state cookie → invalid_state, no mint", async () => {
    validateSessionWithCreatedAt.mockResolvedValue(
      sessionCreatedAt(new Date(STARTED_AT.getTime() + 1000)),
    );
    const res = await GET(makeRequest({ withState: false }));
    expect(res.headers.get("location")).toBe(
      "healthlog://login-callback?error=invalid_state",
    );
    expect(mintNativeHandoff).not.toHaveBeenCalled();
  });

  it("tampered / garbage state cookie → invalid_state (auth tag fails)", async () => {
    validateSessionWithCreatedAt.mockResolvedValue(
      sessionCreatedAt(new Date(STARTED_AT.getTime() + 1000)),
    );
    const res = await GET(makeRequest({ stateValue: "v1.not-a-real-blob" }));
    expect(res.headers.get("location")).toBe(
      "healthlog://login-callback?error=invalid_state",
    );
    expect(mintNativeHandoff).not.toHaveBeenCalled();
  });

  it("no valid session → no_session, no mint", async () => {
    validateSessionWithCreatedAt.mockResolvedValue(null);
    const res = await GET(makeRequest({ withSession: false }));
    expect(res.headers.get("location")).toBe(
      "healthlog://login-callback?error=no_session",
    );
    expect(mintNativeHandoff).not.toHaveBeenCalled();
  });

  it("rate-limited → scheme error, no mint", async () => {
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
      allowed: false,
      ip: "1.2.3.4",
    } as never);
    const res = await GET(makeRequest({}));
    expect(res.headers.get("location")).toBe(
      "healthlog://login-callback?error=rate_limited",
    );
    expect(mintNativeHandoff).not.toHaveBeenCalled();
  });
});
