/**
 * `requireRecordAuth`'s scope option, and the refusal that comes with it.
 *
 * A route can now declare a narrow Bearer scope on a DELEGABLE surface, which
 * puts two admissions on one call: the route may act on somebody else's record,
 * and it accepts a credential minted for one job. The interesting cases are all
 * about the pair, not either half — a scoped credential must reach its own
 * record and be refused any other, while a session and a wildcard token keep
 * the delegation behaviour they already had.
 *
 * The load-bearing assertion is not the 403. It is that the grant lookup never
 * runs: the refusal has to sit above the sharing check rather than beside it,
 * or a future change to what a grant permits would start deciding what a
 * single-purpose token can reach.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks must be hoisted before importing the module under test. ---

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/sharing/grant-access", () => ({
  findActiveGrant: vi.fn(),
  grantAllows: vi.fn(() => true),
  grantCoversDomain: vi.fn(() => true),
  touchGrantUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/sharing/record-session-fence", () => ({
  assertRecordSessionFence: vi.fn().mockResolvedValue(undefined),
  attachRecordContextEcho: vi.fn((res: unknown) => res),
}));

const headersGet = vi.fn<(name: string) => string | null>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: headersGet })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// --- Imports use the mocked modules above. ---

import { requireRecordAuth, isScopedCredential } from "../api-handler";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/hmac";
import { auditLog } from "@/lib/auth/audit";
import { findActiveGrant } from "@/lib/sharing/grant-access";
import { ACCOUNT_SELECTOR_HEADER } from "@/lib/auth/acting-carrier";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";

const FAKE_HASH = "deadbeefcafef00d";
const RAW_TOKEN = "hlk_" + "a".repeat(64);
const OWNER_ID = "user-owner";
const HOLDER_ID = "user-holder";

const HOLDER = {
  id: HOLDER_ID,
  role: "USER" as const,
  username: "holder",
  email: "holder@example.test",
};

/** Present a Bearer with these scopes, and optionally a record selector. */
function armBearer(permissions: string[], selector?: string): void {
  headersGet.mockReset();
  headersGet.mockImplementation((name: string) => {
    const key = name.toLowerCase();
    if (key === "authorization") return `Bearer ${RAW_TOKEN}`;
    if (key === ACCOUNT_SELECTOR_HEADER) return selector ?? null;
    return null;
  });
  vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
    id: "token-1",
    userId: HOLDER_ID,
    permissions,
    revoked: false,
    expiresAt: null,
  } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(HOLDER as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hashToken).mockReturnValue(FAKE_HASH);
  vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  vi.mocked(getSession).mockResolvedValue(null as never);
});

describe("a scoped credential on its own record", () => {
  it("is admitted, and looks exactly like the un-switched request it is", async () => {
    armBearer([MEASUREMENTS_WRITE_SCOPE]);

    const auth = await requireRecordAuth("write", "measurements", {
      scope: MEASUREMENTS_WRITE_SCOPE,
    });

    expect(auth.user.id).toBe(HOLDER_ID);
    expect(auth.actor.id).toBe(HOLDER_ID);
    expect(auth.grantId).toBeNull();
    expect(findActiveGrant).not.toHaveBeenCalled();
  });

  it("reports itself as scoped, and names the scope that admitted it", async () => {
    armBearer([MEASUREMENTS_WRITE_SCOPE]);
    const auth = await requireRecordAuth("write", "measurements", {
      scope: MEASUREMENTS_WRITE_SCOPE,
    });
    expect(auth.bearerScope).toBe(MEASUREMENTS_WRITE_SCOPE);
    expect(isScopedCredential(auth)).toBe(true);
  });
});

describe("a scoped credential naming another record", () => {
  it("is refused, and the grant is never consulted", async () => {
    armBearer([MEASUREMENTS_WRITE_SCOPE], OWNER_ID);

    await expect(
      requireRecordAuth("write", "measurements", {
        scope: MEASUREMENTS_WRITE_SCOPE,
      }),
    ).rejects.toThrow();

    // The point of the whole arm: refused ABOVE the sharing check, so no
    // future reading of what a grant permits can reach a scoped credential.
    expect(findActiveGrant).not.toHaveBeenCalled();
  });

  it("is refused even when a live grant would have allowed it", async () => {
    armBearer([MEASUREMENTS_WRITE_SCOPE], OWNER_ID);
    vi.mocked(findActiveGrant).mockResolvedValue({
      id: "grant-1",
      grantorId: OWNER_ID,
      granteeId: HOLDER_ID,
    } as never);

    await expect(
      requireRecordAuth("write", "measurements", {
        scope: MEASUREMENTS_WRITE_SCOPE,
      }),
    ).rejects.toThrow();
  });

  it("writes a durable refusal row naming the reason", async () => {
    armBearer([MEASUREMENTS_WRITE_SCOPE], OWNER_ID);

    await expect(
      requireRecordAuth("write", "measurements", {
        scope: MEASUREMENTS_WRITE_SCOPE,
      }),
    ).rejects.toThrow();

    expect(auditLog).toHaveBeenCalledWith(
      "sharing.access.denied",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "narrow_scope_selector" }),
      }),
    );
  });
});

describe("the credentials this arm must not touch", () => {
  it("a wildcard token with a selector still reaches the grant lookup", async () => {
    // The control. Without it, a refusal that swallowed every delegated
    // Bearer would pass the tests above for entirely the wrong reason.
    armBearer(["*"], OWNER_ID);
    vi.mocked(findActiveGrant).mockResolvedValue(null as never);

    await expect(
      requireRecordAuth("write", "measurements", {
        scope: MEASUREMENTS_WRITE_SCOPE,
      }),
    ).rejects.toThrow();

    expect(findActiveGrant).toHaveBeenCalled();
  });

  it("a wildcard token reads as unscoped however the route was declared", async () => {
    armBearer(["*"]);
    const auth = await requireRecordAuth("write", "measurements", {
      scope: MEASUREMENTS_WRITE_SCOPE,
    });
    expect(auth.bearerScope).toBeNull();
    expect(isScopedCredential(auth)).toBe(false);
  });

  it("a cookie session reads as unscoped", async () => {
    headersGet.mockReset();
    headersGet.mockReturnValue(null);
    vi.mocked(getSession).mockResolvedValue({
      session: { id: "sess-1", expiresAt: new Date(Date.now() + 60_000) },
      user: HOLDER,
    } as never);

    const auth = await requireRecordAuth("write", "measurements", {
      scope: MEASUREMENTS_WRITE_SCOPE,
    });
    expect(isScopedCredential(auth)).toBe(false);
    expect(auth.grantId).toBeNull();
  });
});

describe("a route that declares no scope", () => {
  it("still refuses a narrow token outright", async () => {
    // The read legs on the measurements module are exactly this shape, and it
    // is what makes the new scope write-only rather than merely write-named.
    armBearer([MEASUREMENTS_WRITE_SCOPE]);

    await expect(requireRecordAuth("read", "measurements")).rejects.toThrow();
    expect(findActiveGrant).not.toHaveBeenCalled();
  });
});
