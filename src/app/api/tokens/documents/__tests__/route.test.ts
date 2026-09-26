/**
 * The document-upload mint (#1038).
 *
 * The assertion that matters most is not the 201 — it is the exact
 * `permissions` array handed to `issueApiToken`. That helper defaults to
 * `["*"]` when the property is absent, so an edit that drops one line turns a
 * user-facing endpoint into a cookie-equivalent credential factory, and a test
 * that only checked the status code would go on passing. The structural guard
 * catches a literal `permissions: ["*"` and would not catch the omission, so
 * this is where that hole is closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  requireCookieAuth: vi.fn(),
}));

vi.mock("@/lib/auth/issue-token", () => ({
  issueApiToken: vi.fn(),
}));

vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

vi.mock("@/lib/db", () => ({
  prisma: { apiToken: { count: vi.fn() } },
}));

import { POST } from "../route";
import { requireCookieAuth } from "@/lib/api-handler";
import { issueApiToken } from "@/lib/auth/issue-token";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { DOCUMENTS_WRITE_SCOPE } from "@/lib/documents/scopes";

const USER = { id: "user-1", role: "USER" as const };
const EXPIRES = new Date("2027-08-31T00:00:00.000Z");

function req(body: unknown): Request {
  return new Request("https://health.example/api/tokens/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireCookieAuth).mockResolvedValue({ user: USER } as never);
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  // Below the ceiling by default; the cases that care set their own count.
  vi.mocked(prisma.apiToken.count).mockResolvedValue(0 as never);
  vi.mocked(issueApiToken).mockResolvedValue({
    token: "hlk_" + "a".repeat(64),
    expiresAt: EXPIRES,
    tokenId: "token-1",
    name: "Paperless workflow",
  } as never);
});

describe("what it mints", () => {
  it("names exactly the upload scope, and no wildcard", async () => {
    const res = await POST(req({ name: "Paperless workflow" }) as never);
    expect(res.status).toBe(201);

    const opts = vi.mocked(issueApiToken).mock.calls[0][0];
    // Exact equality, not `toContain`: an extra scope is a widening, and this
    // is the assertion standing between the endpoint and one.
    expect(opts.permissions).toEqual([DOCUMENTS_WRITE_SCOPE]);
    expect(opts.userId).toBe(USER.id);
  });

  it("returns the raw token once, with its name and expiry", async () => {
    const res = await POST(req({ name: "Paperless workflow" }) as never);
    const json = await res.json();
    expect(json.data.token).toMatch(/^hlk_[0-9a-f]{64}$/);
    expect(json.data.name).toBe("Paperless workflow");
    expect(json.data.expiresAt).toBeDefined();
  });

  it("expires by default rather than living forever", async () => {
    await POST(req({ name: "Import script" }) as never);
    const opts = vi.mocked(issueApiToken).mock.calls[0][0];
    expect(opts.expiresInDays).toBe(365);
  });

  it("honours an explicit lifetime", async () => {
    await POST(req({ name: "Import script", expiresInDays: 30 }) as never);
    expect(vi.mocked(issueApiToken).mock.calls[0][0].expiresInDays).toBe(30);
  });

  it("audits the mint with the token id and the scope", async () => {
    await POST(req({ name: "Import script" }) as never);
    expect(auditLog).toHaveBeenCalledWith(
      "tokens.documents.create",
      expect.objectContaining({
        userId: USER.id,
        details: expect.objectContaining({
          tokenId: "token-1",
          scope: DOCUMENTS_WRITE_SCOPE,
        }),
      }),
    );
  });

  it("counts only live tokens carrying this scope", async () => {
    // The whole shape of the query, asserted rather than assumed. Counting
    // every row would let the `["*"]` tokens a login mints consume the budget
    // and refuse a mint for a reason the person cannot see; counting revoked
    // or expired rows would mean revoking never frees a slot.
    await POST(req({ name: "Import script" }) as never);

    const where = vi.mocked(prisma.apiToken.count).mock.calls[0][0]?.where;
    expect(where).toMatchObject({
      userId: USER.id,
      revoked: false,
      permissions: { has: DOCUMENTS_WRITE_SCOPE },
    });
    expect(where?.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);
  });
});

describe("when it refuses", () => {
  it("403s while the operator has the API switched off", async () => {
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);
    const res = await POST(req({ name: "Import script" }) as never);
    expect(res.status).toBe(403);
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("429s past the mint rate limit, without minting", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await POST(req({ name: "Import script" }) as never);
    expect(res.status).toBe(429);
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("422s on a missing name", async () => {
    const res = await POST(req({}) as never);
    expect(res.status).toBe(422);
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("422s on a lifetime outside the permitted band", async () => {
    const res = await POST(
      req({ name: "Import script", expiresInDays: 4000 }) as never,
    );
    expect(res.status).toBe(422);
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("409s at the live-token ceiling, without minting", async () => {
    vi.mocked(prisma.apiToken.count).mockResolvedValue(10 as never);
    const res = await POST(req({ name: "Import script" }) as never);

    // 409, not 429: a conflict with the account's current state, whose remedy
    // is revoking rather than waiting. A 429 would say the opposite.
    expect(res.status).toBe(409);
    expect((await res.json()).meta?.errorCode).toBe(
      "tokens.documents.ceiling_reached",
    );
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("still mints on the last free slot", async () => {
    // The off-by-one that would make the ceiling nine. Worth pinning, because
    // `>=` versus `>` is invisible in review and only one of them is right.
    vi.mocked(prisma.apiToken.count).mockResolvedValue(9 as never);
    const res = await POST(req({ name: "Import script" }) as never);
    expect(res.status).toBe(201);
  });

  it("checks the ceiling only after the body validates", async () => {
    // A malformed request should hear about the malformation, not the
    // ceiling — and should not spend a query establishing it.
    vi.mocked(prisma.apiToken.count).mockResolvedValue(10 as never);
    const res = await POST(req({}) as never);
    expect(res.status).toBe(422);
    expect(prisma.apiToken.count).not.toHaveBeenCalled();
  });

  it("ignores a scope the body tries to smuggle in", async () => {
    // There is no `scope` field to validate, so an unknown key is simply not
    // read — the permission array is a literal either way. Asserted because
    // "the field does not exist" is the security property, and a schema change
    // that added one would silently make this body meaningful.
    await POST(
      req({
        name: "Import script",
        scope: "read_write",
        permissions: ["*"],
      }) as never,
    );
    expect(vi.mocked(issueApiToken).mock.calls[0][0].permissions).toEqual([
      DOCUMENTS_WRITE_SCOPE,
    ]);
  });
});
