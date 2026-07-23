/**
 * Unit-level checks on the elevation primitive that need no database.
 *
 * The behavioural work — binding, single use, expiry, the concurrent race, the
 * fresh-factor rule end to end — lives in
 * `tests/integration/step-up-elevation.test.ts`, because every one of those
 * claims is a claim about what Postgres does with a WHERE clause and a mocked
 * client cannot answer it. What is worth pinning here is the arithmetic and the
 * constants, both of which a mock CAN answer honestly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const createMock = vi.fn().mockResolvedValue({ id: "elevation-1" });

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        stepUpElevation: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          create: createMock,
        },
      }),
    ),
    stepUpElevation: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-step-up-unit-32-bytes-minimum-abcdefghijklmnop";

const {
  mintStepUpElevation,
  claimStepUpElevation,
  validateStepUpElevation,
  isFreshFactorMethod,
  FRESH_FACTOR_METHODS,
  STEP_UP_ELEVATION_TTL_SECONDS,
} = await import("@/lib/auth/step-up");
const { MFA_STEP_UP_MAX_AGE_SECONDS, STEP_UP_ELEVATION_HEADER } =
  await import("@/lib/api-handler");
const { hashToken } = await import("@/lib/auth/hmac");

beforeEach(() => {
  createMock.mockClear();
});

async function mint() {
  return mintStepUpElevation({
    userId: "u1",
    apiTokenId: "t1",
    method: "password",
  });
}

/** The `data` object the mint handed to Prisma. */
function lastCreateData(): { tokenHash: string; expiresAt: Date } {
  return createMock.mock.calls.at(-1)![0].data;
}

describe("the two step-up windows stay pinned together", () => {
  it("matches the cookie path's freshness window exactly", () => {
    // If these ever diverge, the looser transport quietly becomes the way in.
    // Changing one is a decision; changing one by accident is a hole.
    expect(STEP_UP_ELEVATION_TTL_SECONDS).toBe(MFA_STEP_UP_MAX_AGE_SECONDS);
  });
});

describe("the minted value", () => {
  it("is a prefixed 32-byte CSPRNG secret", async () => {
    const { token } = await mint();
    expect(token).toMatch(/^hle_[0-9a-f]{64}$/);
  });

  it("stores the HMAC and nothing derived from the plaintext", async () => {
    const { token } = await mint();
    const { tokenHash } = lastCreateData();

    // Asserted as an EQUALITY against the expected hash. The previous
    // `not.toContain` comparison was vacuous — the stored value is 64 chars and
    // the token is 68, so a 64-char string can never contain it, and storing
    // `token.slice(4)` in cleartext would have passed.
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).not.toBe(token.slice(4));
  });

  it("differs on every mint", async () => {
    const a = await mint();
    const b = await mint();
    expect(a.token).not.toBe(b.token);
  });
});

describe("the expiry that is actually written", () => {
  it("lands five minutes ahead, not five minutes' worth of milliseconds", async () => {
    // The returned `expiresInSeconds` is an echo of a constant and proves
    // nothing about the row. Dropping the `* 1000` from the mint yields a
    // 300-MILLISECOND elevation with every constant still reading 300, so the
    // computed timestamp is what has to be asserted.
    const before = Date.now();
    const { expiresAt } = await mint();
    const after = Date.now();

    const written = lastCreateData().expiresAt;
    expect(written.getTime()).toBe(expiresAt.getTime());

    const target = STEP_UP_ELEVATION_TTL_SECONDS * 1000;
    expect(written.getTime() - before).toBeGreaterThanOrEqual(target - 1_000);
    expect(written.getTime() - after).toBeLessThanOrEqual(target + 1_000);
    // And unambiguously far from the millisecond-scale mistake.
    expect(written.getTime() - before).toBeGreaterThan(60_000);
  });
});

describe("the fresh-factor rule", () => {
  it("admits only the methods the web stamps a session for", () => {
    expect([...FRESH_FACTOR_METHODS].sort()).toEqual([
      "passkey",
      "totp",
      "webauthn",
    ]);
    expect(isFreshFactorMethod("totp")).toBe(true);
    expect(isFreshFactorMethod("webauthn")).toBe(true);
    expect(isFreshFactorMethod("passkey")).toBe(true);
    // The B1 invariant: a password is not a second factor.
    expect(isFreshFactorMethod("password")).toBe(false);
  });
});

describe("a wrong-shaped value is refused before touching the database", () => {
  it.each([
    ["session secret", `hls_${"a".repeat(64)}`],
    ["access token", `hlk_${"a".repeat(64)}`],
    ["empty", ""],
  ])("refuses a %s without a query", async (_label, value) => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.$queryRaw).mockClear();
    vi.mocked(prisma.stepUpElevation.findUnique).mockClear();

    for (const fn of [claimStepUpElevation, validateStepUpElevation]) {
      const result = await fn({
        rawToken: value,
        userId: "u1",
        apiTokenId: "t1",
        requireFreshFactor: false,
      });
      expect(result).toEqual({ ok: false, reason: "malformed" });
    }

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.stepUpElevation.findUnique).not.toHaveBeenCalled();
  });
});

describe("the elevation header name is stable", () => {
  it("is the lowercase form the gate reads", () => {
    expect(STEP_UP_ELEVATION_HEADER).toBe("x-step-up");
    expect(STEP_UP_ELEVATION_HEADER).toBe(
      STEP_UP_ELEVATION_HEADER.toLowerCase(),
    );
  });
});

describe("the credential prefix lists do not drift apart", () => {
  it("the idempotency cache and the log redactor both know `hle_`", async () => {
    // Two parallel denylists guard the same class of value. They were already
    // one prefix out of step (`hls_` was in one and not the other), which is
    // how the next one gets missed.
    const idempotency = readFileSync("src/lib/idempotency.ts", "utf8");
    expect(idempotency).toContain("hle_");

    const { redactSecrets } = await import("@/lib/logging/redact");
    const secret = `hle_${"a".repeat(64)}`;
    expect(redactSecrets(`elevation=${secret}`)).not.toContain(secret);
    expect(redactSecrets(`session=hls_${"b".repeat(64)}`)).toContain(
      "[REDACTED]",
    );
  });
});
