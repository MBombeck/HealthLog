/**
 * `requireFreshMfaOrElevationIfEnrolled` — the erasure gate that a native
 * client can clear.
 *
 * The cookie arm is `requireFreshMfaIfEnrolled` byte for byte; the cases here
 * that cover it exist so a later edit to the sibling cannot quietly change what
 * a browser session gets. The Bearer arm is the new part: an MFA-enrolled
 * account presenting a fresh-factor step-up elevation passes, everything else
 * on Bearer is refused with the same 401 the MFA-management routes emit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    session: { findUnique: vi.fn() },
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    webauthnMfaCredential: { count: vi.fn() },
    // The stale refusal names the proofs the account holds, passkeys among them.
    passkey: { count: vi.fn() },
    stepUpElevation: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn(() => "hash") }));
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
  requireFreshMfaOrElevationIfEnrolled,
  StepUpRequiredError,
  HttpError,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from "../api-handler";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { auditLog } from "@/lib/auth/audit";

const MFA_USER = {
  id: "user-1",
  role: "USER" as const,
  username: "u",
  totpConfirmedAt: new Date("2020-01-01"),
};
const PLAIN_USER = { ...MFA_USER, totpConfirmedAt: null };

const ELEVATION = `hle_${"a".repeat(64)}`;

beforeEach(() => {
  vi.resetAllMocks();
  headersGet.mockReturnValue(null);
  vi.mocked(headers).mockImplementation(
    async () => ({ get: headersGet }) as never,
  );
  vi.mocked(auditLog).mockResolvedValue(undefined);
  vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0 as never);
});

function mockCookieSession(user: unknown) {
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 1e6) },
    user,
  } as never);
}

/** A wildcard (or narrow) Bearer caller, optionally presenting an elevation. */
function mockBearer(opts: {
  user: unknown;
  permissions?: string[];
  elevation?: string | null;
}) {
  vi.mocked(getSession).mockResolvedValue(null as never);
  headersGet.mockImplementation((n) => {
    const name = n.toLowerCase();
    if (name === "authorization") return "Bearer hlk_xyz";
    if (name === "x-step-up") return opts.elevation ?? null;
    return null;
  });
  vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
    id: "tok-1",
    userId: "user-1",
    permissions: opts.permissions ?? ["*"],
    revoked: false,
    expiresAt: null,
  } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(opts.user as never);
  vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
}

/** A stored elevation row as `validateStepUpElevation` reads it. */
function mockElevationRow(method: string, overrides: object = {}) {
  vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue({
    userId: "user-1",
    apiTokenId: "tok-1",
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    method,
    ...overrides,
  } as never);
}

async function rejectedWith(
  promise: Promise<unknown>,
): Promise<StepUpRequiredError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(StepUpRequiredError);
  return caught as StepUpRequiredError;
}

describe("requireFreshMfaOrElevationIfEnrolled — cookie arm is unchanged", () => {
  it("passes a non-MFA user straight through without a freshness read", async () => {
    mockCookieSession(PLAIN_USER);
    const ctx = await requireFreshMfaOrElevationIfEnrolled(
      MFA_STEP_UP_MAX_AGE_SECONDS,
    );
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.authMethod).toBe("cookie");
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
    await expect(ctx.commitElevation()).resolves.toBeUndefined();
  });

  it("passes an MFA user with a fresh verification", async () => {
    mockCookieSession(MFA_USER);
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: new Date(Date.now() - 60_000),
    } as never);
    const ctx = await requireFreshMfaOrElevationIfEnrolled(
      MFA_STEP_UP_MAX_AGE_SECONDS,
    );
    expect(ctx.user.id).toBe("user-1");
    // The session stamp is not consumable, so committing is a no-op and the
    // elevation store is never touched on the cookie arm.
    await ctx.commitElevation();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.stepUpElevation.findUnique).not.toHaveBeenCalled();
  });

  it("blocks an MFA user without a fresh verification", async () => {
    mockCookieSession(MFA_USER);
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: null,
    } as never);
    const err = await rejectedWith(
      requireFreshMfaOrElevationIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS),
    );
    expect(err.errorCode).toBe("auth.stepup.required");
  });

  it("ignores an elevation header when a cookie session is present", async () => {
    mockCookieSession(MFA_USER);
    headersGet.mockImplementation((n) =>
      n.toLowerCase() === "x-step-up" ? ELEVATION : null,
    );
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: null,
    } as never);
    await rejectedWith(
      requireFreshMfaOrElevationIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS),
    );
    expect(prisma.stepUpElevation.findUnique).not.toHaveBeenCalled();
  });
});

describe("requireFreshMfaOrElevationIfEnrolled — Bearer arm", () => {
  it("passes a non-MFA wildcard token through with no elevation, as before", async () => {
    mockBearer({ user: PLAIN_USER });
    const ctx = await requireFreshMfaOrElevationIfEnrolled(
      MFA_STEP_UP_MAX_AGE_SECONDS,
    );
    expect(ctx.authMethod).toBe("bearer");
    expect(prisma.stepUpElevation.findUnique).not.toHaveBeenCalled();
    await expect(ctx.commitElevation()).resolves.toBeUndefined();
  });

  it("refuses a narrow-scope token before any elevation is read", async () => {
    mockBearer({
      user: MFA_USER,
      permissions: ["fhir:read"],
      elevation: ELEVATION,
    });
    let caught: unknown;
    try {
      await requireFreshMfaOrElevationIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).not.toBeInstanceOf(StepUpRequiredError);
    expect((caught as HttpError).statusCode).toBe(403);
    expect(prisma.stepUpElevation.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an MFA-enrolled token with no elevation as auth.stepup.required", async () => {
    mockBearer({ user: MFA_USER, elevation: null });
    const err = await rejectedWith(
      requireFreshMfaOrElevationIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS),
    );
    expect(err.statusCode).toBe(401);
    expect(err.errorCode).toBe("auth.stepup.required");
    expect(prisma.stepUpElevation.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an unknown elevation and audits the reason", async () => {
    mockBearer({ user: MFA_USER, elevation: ELEVATION });
    vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue(
      null as never,
    );
    const err = await rejectedWith(
      requireFreshMfaOrElevationIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS),
    );
    expect(err.errorCode).toBe("auth.stepup.required");
    expect(auditLog).toHaveBeenCalledWith(
      "auth.stepup.elevation.rejected",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({ reason: "unknown" }),
      }),
    );
  });

  it("refuses a password-proved elevation: the factor is too weak for erasure", async () => {
    mockBearer({ user: MFA_USER, elevation: ELEVATION });
    mockElevationRow("password");
    const err = await rejectedWith(
      requireFreshMfaOrElevationIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS),
    );
    expect(err.errorCode).toBe("auth.stepup.required");
    expect(auditLog).toHaveBeenCalledWith(
      "auth.stepup.elevation.rejected",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "insufficient_factor" }),
      }),
    );
  });

  it("refuses an elevation minted for another token", async () => {
    mockBearer({ user: MFA_USER, elevation: ELEVATION });
    mockElevationRow("totp", { apiTokenId: "tok-other" });
    await rejectedWith(
      requireFreshMfaOrElevationIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "auth.stepup.elevation.rejected",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "wrong_token" }),
      }),
    );
  });

  it("admits a TOTP-proved elevation and spends it on commit", async () => {
    mockBearer({ user: MFA_USER, elevation: ELEVATION });
    mockElevationRow("totp");
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { method: "totp" },
    ] as never);

    const ctx = await requireFreshMfaOrElevationIfEnrolled(
      MFA_STEP_UP_MAX_AGE_SECONDS,
    );
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.authMethod).toBe("bearer");
    // Validation does not spend: the claim runs only when the route commits.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();

    await ctx.commitElevation();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("admits a security-key-only account on a webauthn-proved elevation", async () => {
    mockBearer({ user: PLAIN_USER, elevation: ELEVATION });
    vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(1 as never);
    mockElevationRow("webauthn");
    const ctx = await requireFreshMfaOrElevationIfEnrolled(
      MFA_STEP_UP_MAX_AGE_SECONDS,
    );
    expect(ctx.user.id).toBe("user-1");
  });

  it("throws at commit when the claim is lost, so a race has one winner", async () => {
    mockBearer({ user: MFA_USER, elevation: ELEVATION });
    mockElevationRow("totp");
    const ctx = await requireFreshMfaOrElevationIfEnrolled(
      MFA_STEP_UP_MAX_AGE_SECONDS,
    );
    // Between validation and commit the elevation was spent elsewhere.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    mockElevationRow("totp", { consumedAt: new Date() });
    await rejectedWith(ctx.commitElevation());
    expect(auditLog).toHaveBeenCalledWith(
      "auth.stepup.elevation.rejected",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "consumed" }),
      }),
    );
  });
});
