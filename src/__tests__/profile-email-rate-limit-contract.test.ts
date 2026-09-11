/**
 * The profile email-address ceiling is the one the contract describes.
 *
 * Changing the address asks whether another account already holds it, and the
 * answer is a 409 versus a 200 — an existence check over every address on the
 * instance, available to any signed-in caller, including the native client's
 * own wildcard token. Neither route that reaches it had a ceiling of any kind,
 * and `apiHandler` supplies no default, so the sweep was bounded only by the
 * network.
 *
 * A published number is worth reading only if it cannot drift from the code,
 * so this pulls the bucket key and the window out of `prisma.$queryRaw` — the
 * technique `rate-limit-auth-surface.test.ts` and the record-write contract
 * both use — and holds the emitted OpenAPI description to what came back.
 * Reading both from the same constant would prove nothing: the sentence is
 * hand-written, deliberately, and this is what keeps the hand-written half
 * honest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROFILE_EMAIL_BUCKET_PREFIX,
  PROFILE_EMAIL_LIMIT,
  PROFILE_EMAIL_WINDOW_MS,
  checkProfileEmailRateLimit,
} from "@/lib/rate-limit";
import { buildOpenApiDocument } from "@/lib/openapi/registry";
import { profileEmailRateLimitResponse } from "@/lib/openapi/routes/shared";
import { ERROR_CODE_CATALOGUE } from "@/lib/openapi/error-codes";

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: vi.fn() } }));

import { prisma } from "@/lib/db";

/** The published sentence, read from the object the route modules spread. */
const published = profileEmailRateLimitResponse["429"].description;

/** Both doors onto the one handler that answers the conflict. */
const OPERATIONS: Array<[path: string, method: "put" | "patch"]> = [
  ["/api/auth/profile", "put"],
  ["/api/user/profile", "patch"],
];

beforeEach(() => {
  vi.mocked(prisma.$queryRaw).mockReset();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([
    { count: 1, reset_at: new Date(Date.now() + 60_000) },
  ] as never);
});

describe("the profile email-address bucket", () => {
  it("keys on the acting account under the name the contract publishes", async () => {
    await checkProfileEmailRateLimit("account-7");

    const call = vi.mocked(prisma.$queryRaw).mock.calls.at(-1)!;
    // `$queryRaw`INSERT … VALUES (${key}, …)`` lands the key at index 1 and
    // the window interval at index 2. Read from the query rather than from
    // the constant, so a renamed prefix that never reached the SQL fails.
    expect(call[1]).toBe("profile-email:account-7");
    expect(call[2]).toBe(`${PROFILE_EMAIL_WINDOW_MS} milliseconds`);
    expect(`${PROFILE_EMAIL_BUCKET_PREFIX}:account-7`).toBe(call[1]);
    expect(published).toContain("`profile-email:<accountId>`");
  });

  it("gives a different account a different bucket, not a shared one", async () => {
    await checkProfileEmailRateLimit("account-7");
    const first = vi.mocked(prisma.$queryRaw).mock.calls.at(-1)![1];
    await checkProfileEmailRateLimit("account-8");
    const second = vi.mocked(prisma.$queryRaw).mock.calls.at(-1)![1];
    expect(first).not.toBe(second);
  });

  it("refuses at the cap the contract publishes", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { count: PROFILE_EMAIL_LIMIT, reset_at: new Date(Date.now() + 60_000) },
    ] as never);
    await expect(
      checkProfileEmailRateLimit("account-7"),
    ).resolves.toMatchObject({
      allowed: true,
      limit: PROFILE_EMAIL_LIMIT,
      remaining: 0,
    });

    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      {
        count: PROFILE_EMAIL_LIMIT + 1,
        reset_at: new Date(Date.now() + 60_000),
      },
    ] as never);
    await expect(
      checkProfileEmailRateLimit("account-7"),
    ).resolves.toMatchObject({ allowed: false });

    const windowSeconds = PROFILE_EMAIL_WINDOW_MS / 1000;
    expect(published).toContain(
      `${PROFILE_EMAIL_LIMIT} requests per ${windowSeconds} seconds`,
    );
  });

  it("says the headers describe that bucket, and declares them", () => {
    expect(Object.keys(profileEmailRateLimitResponse["429"].headers)).toEqual([
      "Retry-After",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ]);
    expect(published).toContain("Retry-After");
  });

  it("publishes a code a client can branch on, and registers it", () => {
    expect(published).toContain("profile.update.emailRateLimited");
    expect(ERROR_CODE_CATALOGUE.profile).toContain(
      "profile.update.emailRateLimited",
    );
  });

  it("says this response is only for a request that asked for nothing else", () => {
    // The refusal narrows to the field when the request carries other
    // fields, so a client reading the 429 as "the whole save failed" would
    // be wrong. The sentence has to carry that or it is worse than silence.
    expect(published).toContain("rejectedFields");
    expect(published).toContain("rate_limited");
  });

  it("is published on both operations that answer it", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<
        string,
        Record<string, { responses?: Record<string, { description?: string }> }>
      >;
    };
    const unpublished = OPERATIONS.filter(
      ([path, method]) =>
        doc.paths[path]?.[method]?.responses?.["429"]?.description !==
        published,
    ).map(([path]) => path);
    expect(unpublished).toEqual([]);
  });
});
