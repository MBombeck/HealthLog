/**
 * The loser of a benign concurrent rotation. The family is untouched and the
 * winner's pair is live, so the answer must not be `already_used` (wire:
 * `auth.refresh.reuse`, "device family revoked, re-pair required") but
 * `superseded`, and nothing beyond the loser's own just-minted pair may be
 * retired.
 */
import { describe, it, expect, vi } from "vitest";

const calls: Array<{ model: string; where: Record<string, unknown> }> = [];
let reads = 0;
const LIVE = {
  id: "rt_old",
  userId: "u1",
  deviceId: "dev-1",
  accessTokenHash: "acc_old",
  expiresAt: new Date(Date.now() + 86_400_000),
  familyStartedAt: new Date(),
  revokedAt: null,
  usedAt: null,
  userAgent: null,
  ipAddress: null,
};

vi.mock("@/lib/auth/hmac", () => ({ hashToken: (t: string) => `h(${t})` }));
vi.mock("@/lib/auth/issue-token", () => ({
  issueApiToken: vi.fn(async () => ({
    token: "hlk_new",
    expiresAt: new Date(Date.now() + 86_400_000),
  })),
}));
// The second-factor policy is not this file's subject: no policy applies.
vi.mock("@/lib/auth/mfa-enrollment", () => ({
  accountMfaEnrollmentRequired: vi.fn(async () => false),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    $executeRaw: vi.fn(async () => 0),
    refreshToken: {
      create: vi.fn(async () => ({ id: "rt_new" })),
      findUnique: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          reads++;
          // 1st read: the row, still live (the racing winner has not committed).
          if (reads === 1) return LIVE;
          // 2nd read: the freshly minted row's id.
          if ("tokenHash" in where) return { id: "rt_new" };
          // 3rd read (loser path): consumed by the winner, NOT revoked.
          return { revokedAt: null };
        },
      ),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          calls.push({ model: "refreshToken", where });
          // The consume guard loses: the winner already set usedAt.
          if (where.id === "rt_old") return { count: 0 };
          return { count: 1 };
        },
      ),
    },
    apiToken: {
      updateMany: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          calls.push({ model: "apiToken", where });
          return { count: 1 };
        },
      ),
    },
  },
}));

import { rotateRefreshToken } from "@/lib/auth/refresh-token";

describe("rotateRefreshToken: concurrent-rotation loser", () => {
  it("answers superseded without revoking the family", async () => {
    const result = await rotateRefreshToken({
      refreshToken: "hlr_x",
      policy: {
        policy: "native",
        tokenLabel: "iOS",
        accessTokenDays: 1,
        refreshTokenDays: 90,
      },
      deviceId: "dev-1",
    });
    expect(result).toEqual({ ok: false, reason: "superseded" });
    // No family-wide revoke ran: nothing keyed on userId, the winner's pair
    // and the old access token (sunset only by the winner) stay live.
    expect(calls.some((c) => "userId" in c.where)).toBe(false);
    // Only the loser's own just-minted pair was retired.
    expect(calls.map((c) => c.model).sort()).toEqual([
      "apiToken",
      "refreshToken",
      "refreshToken",
    ]);
  });
});
