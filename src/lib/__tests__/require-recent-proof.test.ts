/**
 * `requireRecentProof` / `assertRecentCookieProof` — the fresh-proof gate in
 * front of whole-record exports, share links, token minting and the admin data
 * actions.
 *
 * Cookie: an account with a second factor needs `mfaVerifiedAt` inside five
 * minutes and nothing else; one without accepts a recent sign-in, second-factor
 * stamp or password re-proof. Bearer: the rule the route names.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The second-factor policy is not this file's subject: no policy applies.
vi.mock("@/lib/auth/mfa-confinement", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/auth/mfa-confinement")>()),
  refuseConfinedBearer: vi.fn(async () => {}),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    session: { findUnique: vi.fn() },
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    webauthnMfaCredential: { count: vi.fn() },
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
  requireMfaManagementAuth,
  requireRecentProof,
  StepUpRequiredError,
} from "../api-handler";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { auditLog } from "@/lib/auth/audit";
import type { StepUpElevation } from "@/generated/prisma/client";

const MFA_USER = {
  id: "user-1",
  role: "USER" as const,
  username: "u",
  totpConfirmedAt: new Date("2020-01-01"),
  passwordHash: "argon",
};
const PLAIN_USER = { ...MFA_USER, totpConfirmedAt: null };

const NOW = () => new Date();
const OLD = () => new Date(Date.now() - 10 * 60 * 1000);

beforeEach(() => {
  vi.resetAllMocks();
  headersGet.mockReturnValue(null);
  vi.mocked(headers).mockImplementation(
    async () => ({ get: headersGet }) as never,
  );
  vi.mocked(auditLog).mockResolvedValue(undefined);
  vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.passkey.count).mockResolvedValue(0 as never);
});

function cookie(
  user: { id: string; passwordHash?: string | null },
  stamps: {
    mfaVerifiedAt?: Date | null;
    createdAt?: Date;
    reproofAt?: Date | null;
  },
) {
  // The password hash is read off the stored row, not the session user.
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    passwordHash: user.passwordHash ?? null,
  } as never);
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 1e6) },
    user,
  } as never);
  vi.mocked(prisma.session.findUnique).mockResolvedValue({
    mfaVerifiedAt: stamps.mfaVerifiedAt ?? null,
    createdAt: stamps.createdAt ?? OLD(),
    reproofAt: stamps.reproofAt ?? null,
  } as never);
}

function bearer(user: unknown, elevation: string | null = null) {
  vi.mocked(getSession).mockResolvedValue(null as never);
  headersGet.mockImplementation((n) => {
    const name = n.toLowerCase();
    if (name === "authorization") return "Bearer hlk_xyz";
    if (name === "x-step-up") return elevation;
    return null;
  });
  vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
    id: "tok-1",
    userId: "user-1",
    permissions: ["*"],
    revoked: false,
    expiresAt: null,
  } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
  vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
}

function possessionElevation(method: string): StepUpElevation {
  return {
    id: "elev-1",
    userId: "user-1",
    apiTokenId: "tok-1",
    tokenHash: "hash",
    method,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    createdAt: new Date(),
  };
}

async function refusal(p: Promise<unknown>): Promise<StepUpRequiredError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(StepUpRequiredError);
    return err as StepUpRequiredError;
  }
  throw new Error("expected a refusal");
}

describe("cookie session, account without a second factor", () => {
  it("passes on a sign-in inside five minutes", async () => {
    cookie(PLAIN_USER, { createdAt: NOW() });
    await expect(
      requireRecentProof({ bearer: "elevation" }),
    ).resolves.toBeTruthy();
  });

  it("passes on a password re-proof inside five minutes", async () => {
    cookie(PLAIN_USER, { reproofAt: NOW() });
    await expect(
      requireRecentProof({ bearer: "elevation" }),
    ).resolves.toBeTruthy();
  });

  it("refuses an old session and names the password as the way through", async () => {
    cookie(PLAIN_USER, {});
    const err = await refusal(requireRecentProof({ bearer: "token" }));
    expect(err.errorCode).toBe("auth.reproof.required");
    expect(err.extraMeta).toEqual({ methods: ["password"] });
  });

  it("offers a passkey when the account holds one", async () => {
    cookie({ ...PLAIN_USER, passwordHash: null }, {});
    vi.mocked(prisma.passkey.count).mockResolvedValue(1 as never);
    const err = await refusal(requireRecentProof({ bearer: "token" }));
    expect(err.extraMeta).toEqual({ methods: ["passkey"] });
  });
});

describe("cookie session, account with a second factor", () => {
  it("passes on a second factor inside five minutes", async () => {
    cookie(MFA_USER, { mfaVerifiedAt: NOW() });
    await expect(
      requireRecentProof({ bearer: "elevation" }),
    ).resolves.toBeTruthy();
  });

  it("a password re-proof does not stand in for the second factor", async () => {
    cookie(MFA_USER, { reproofAt: NOW() });
    const err = await refusal(requireRecentProof({ bearer: "elevation" }));
    expect(err.extraMeta).toEqual({ methods: ["totp"] });
  });

  it("nor does a fresh session without the factor (a remembered device)", async () => {
    cookie(MFA_USER, { createdAt: NOW() });
    await refusal(requireRecentProof({ bearer: "elevation" }));
  });

  it("refuses a stale second-factor stamp", async () => {
    cookie(MFA_USER, { mfaVerifiedAt: OLD() });
    await refusal(requireRecentProof({ bearer: "elevation" }));
  });
});

describe("Bearer", () => {
  it("`elevation` refuses a token without one", async () => {
    bearer(PLAIN_USER);
    const err = await refusal(requireRecentProof({ bearer: "elevation" }));
    expect(err.errorCode).toBe("auth.stepup.required");
  });

  it("`elevation-if-enrolled` passes a token on an account without a second factor", async () => {
    bearer(PLAIN_USER);
    await expect(
      requireRecentProof({ bearer: "elevation-if-enrolled" }),
    ).resolves.toBeTruthy();
  });

  it("`elevation-if-enrolled` refuses a bare token on an enrolled account", async () => {
    bearer(MFA_USER);
    await refusal(requireRecentProof({ bearer: "elevation-if-enrolled" }));
  });

  it("`elevation-if-possession` passes a token on an account with neither a second factor nor a passkey", async () => {
    bearer(PLAIN_USER);
    await expect(
      requireRecentProof({ bearer: "elevation-if-possession" }),
    ).resolves.toBeTruthy();
  });

  it("`elevation-if-possession` refuses a bare token on an enrolled account", async () => {
    bearer(MFA_USER);
    const err = await refusal(
      requireRecentProof({ bearer: "elevation-if-possession" }),
    );
    expect(err.errorCode).toBe("auth.stepup.required");
  });

  it("`elevation-if-possession` refuses a bare token on a passkey-only account", async () => {
    bearer(PLAIN_USER);
    vi.mocked(prisma.passkey.count).mockResolvedValue(1);
    const err = await refusal(
      requireRecentProof({ bearer: "elevation-if-possession" }),
    );
    expect(err.errorCode).toBe("auth.stepup.required");
  });

  it("`elevation-if-possession` accepts a passkey-proved elevation on a passkey-only account", async () => {
    bearer(PLAIN_USER, `hle_${"a".repeat(64)}`);
    vi.mocked(prisma.passkey.count).mockResolvedValue(1);
    vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue(
      possessionElevation("passkey"),
    );
    const auth = await requireRecentProof({
      bearer: "elevation-if-possession",
    });
    expect(typeof auth.commitElevation).toBe("function");
  });

  it("`elevation-if-possession` refuses a password-proved elevation on a passkey-only account", async () => {
    bearer(PLAIN_USER, `hle_${"a".repeat(64)}`);
    vi.mocked(prisma.passkey.count).mockResolvedValue(1);
    vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue(
      possessionElevation("password"),
    );
    await refusal(requireRecentProof({ bearer: "elevation-if-possession" }));
  });

  it("`token` passes on the token alone", async () => {
    bearer(MFA_USER);
    await expect(requireRecentProof({ bearer: "token" })).resolves.toBeTruthy();
  });

  it("`elevation` accepts a password-proved elevation on an account without a second factor", async () => {
    bearer(PLAIN_USER, `hle_${"a".repeat(64)}`);
    vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue({
      userId: "user-1",
      apiTokenId: "tok-1",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      method: "password",
    } as never);
    const auth = await requireRecentProof({ bearer: "elevation" });
    expect(typeof auth.commitElevation).toBe("function");
  });

  it("`elevation` refuses a password-proved elevation on an enrolled account", async () => {
    bearer(MFA_USER, `hle_${"a".repeat(64)}`);
    vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue({
      userId: "user-1",
      apiTokenId: "tok-1",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      method: "password",
    } as never);
    await refusal(requireRecentProof({ bearer: "elevation" }));
  });
});

describe("adding a factor over Bearer (`freshFactorIfEnrolled`)", () => {
  const passwordElevation = {
    userId: "user-1",
    apiTokenId: "tok-1",
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    method: "password",
  };

  it("a password-proved elevation still adds a first factor", async () => {
    bearer(PLAIN_USER, `hle_${"a".repeat(64)}`);
    vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue(
      passwordElevation as never,
    );
    const auth = await requireMfaManagementAuth({
      freshFactorIfEnrolled: true,
    });
    expect(auth.transport).toBe("bearer");
  });

  it("a password-proved elevation does not add a factor beside an existing one", async () => {
    bearer(MFA_USER, `hle_${"a".repeat(64)}`);
    vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue(
      passwordElevation as never,
    );
    await refusal(requireMfaManagementAuth({ freshFactorIfEnrolled: true }));
  });

  it("a second-factor elevation does", async () => {
    bearer(MFA_USER, `hle_${"a".repeat(64)}`);
    vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue({
      ...passwordElevation,
      method: "totp",
    } as never);
    const auth = await requireMfaManagementAuth({
      freshFactorIfEnrolled: true,
    });
    expect(auth.transport).toBe("bearer");
  });
});
