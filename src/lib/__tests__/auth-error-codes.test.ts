/**
 * The generic auth gates refuse with a stable machine code.
 *
 * This decides the single most important branch a native client makes:
 * refresh the token and retry, drop the session and show the login screen, or
 * stop retrying because the credential will never work. Before these codes the
 * only way to tell those apart was to string-match the English sentence "Token
 * expired", so a rewording — or a localisation pass — would have turned a
 * recoverable refresh into a forced logout for every already-shipped build.
 *
 * So the assertions here are on the CODE, and deliberately not on the prose.
 * The one place the sentence is pinned is the pair of cases proving the
 * envelope is otherwise unchanged: `error` still carries a sentence, and an
 * HttpError thrown without a code still serialises without a `meta`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    session: { findUnique: vi.fn() },
    webauthnMfaCredential: { count: vi.fn() },
    passkey: { count: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

const headersGet = vi.fn<(name: string) => string | null>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: headersGet })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import {
  apiHandler,
  AUTH_ERROR_CODES,
  HttpError,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireAdmin,
  requireAuth,
  requireFreshMfa,
} from "../api-handler";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/hmac";
import { auditLog } from "@/lib/auth/audit";

const FAKE_HASH = "deadbeefcafef00d";
const RAW_TOKEN = "hlk_" + "a".repeat(64);
const FAKE_USER = {
  id: "user-1",
  role: "USER" as const,
  username: "testuser",
  email: "user@example.com",
};

function setBearerHeader(value: string | null): void {
  headersGet.mockReset();
  headersGet.mockImplementation((name: string) =>
    name.toLowerCase() === "authorization" ? value : null,
  );
}

function mockSession(user: unknown) {
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 1e6) },
    user,
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hashToken).mockReturnValue(FAKE_HASH);
  vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
});

/** Run a gate through `apiHandler` and read the envelope it produced. */
async function envelopeFor(gate: () => Promise<unknown>): Promise<{
  status: number;
  body: { data: null; error: string; meta?: { errorCode?: string } };
}> {
  const handler = apiHandler(async (_request: Request) => {
    await gate();
    return new Response(null, { status: 204 });
  });
  const res = (await handler(
    new Request("http://localhost/api/anything"),
  )) as Response;
  return {
    status: res.status,
    body: (await res.json()) as {
      data: null;
      error: string;
      meta?: { errorCode?: string };
    },
  };
}

describe("auth failures carry a machine-readable errorCode", () => {
  it("names auth.missing when no credential was presented at all", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(null);

    const { status, body } = await envelopeFor(() => requireAuth());

    expect(status).toBe(401);
    expect(body.meta?.errorCode).toBe(AUTH_ERROR_CODES.missing);
    // The envelope is otherwise what it always was.
    expect(body.data).toBeNull();
    expect(body.error).toBe("Not authenticated");
  });

  it("names auth.token.expired so the client refreshes instead of logging out", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-expired",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt: new Date(Date.now() - 60_000),
    } as never);

    const { status, body } = await envelopeFor(() => requireAuth());

    expect(status).toBe(401);
    expect(body.meta?.errorCode).toBe(AUTH_ERROR_CODES.expired);
  });

  it("names auth.token.invalid for an unknown token", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue(null);

    const { status, body } = await envelopeFor(() => requireAuth());

    expect(status).toBe(401);
    expect(body.meta?.errorCode).toBe(AUTH_ERROR_CODES.invalid);
  });

  it("names auth.token.invalid for a revoked token — not the expired code", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-revoked",
      userId: "user-1",
      permissions: ["*"],
      revoked: true,
      expiresAt: null,
    } as never);

    const { body } = await envelopeFor(() => requireAuth());

    // Refreshing a revoked token loops forever; the two must not share a code.
    expect(body.meta?.errorCode).toBe(AUTH_ERROR_CODES.invalid);
    expect(body.meta?.errorCode).not.toBe(AUTH_ERROR_CODES.expired);
  });

  it("names auth.scope.insufficient when the token's scope does not reach the route", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-narrow",
      userId: "user-1",
      permissions: ["something:else"],
      revoked: false,
      expiresAt: null,
    } as never);

    const { status, body } = await envelopeFor(() =>
      requireAuth("medication:ingest"),
    );

    expect(status).toBe(403);
    expect(body.meta?.errorCode).toBe(AUTH_ERROR_CODES.scope);
  });

  it("names auth.scope.insufficient when a narrow token hits a route that declared none", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-undeclared",
      userId: "user-1",
      permissions: ["health:read"],
      revoked: false,
      expiresAt: null,
    } as never);

    const { status, body } = await envelopeFor(() => requireAuth());

    expect(status).toBe(403);
    expect(body.meta?.errorCode).toBe(AUTH_ERROR_CODES.scope);
  });

  it("names auth.missing and auth.admin.required on the admin gate", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const anonymous = await envelopeFor(() => requireAdmin());
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.meta?.errorCode).toBe(AUTH_ERROR_CODES.missing);

    mockSession(FAKE_USER);
    const nonAdmin = await envelopeFor(() => requireAdmin());
    expect(nonAdmin.status).toBe(403);
    expect(nonAdmin.body.meta?.errorCode).toBe(AUTH_ERROR_CODES.admin);
  });

  it("names auth.missing on the step-up gate with no session", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const { status, body } = await envelopeFor(() =>
      requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS),
    );

    expect(status).toBe(401);
    expect(body.meta?.errorCode).toBe(AUTH_ERROR_CODES.missing);
  });

  it("leaves an HttpError thrown without a code exactly as it was", async () => {
    const handler = apiHandler(async (_request: Request) => {
      throw new HttpError(404, "Not found");
    });
    const res = (await handler(
      new Request("http://localhost/api/anything"),
    )) as Response;

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ data: null, error: "Not found" });
  });

  it("keeps every code distinct and dot.case", () => {
    const codes = Object.values(AUTH_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^auth(\.[a-z_]+)+$/);
    }
  });
});
