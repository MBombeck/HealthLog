/**
 * The single-record write ceiling is the one the contract describes.
 *
 * The batch endpoints have been capped at 60 calls a minute since they were
 * written; the per-record creates a naive or older client loops over were not
 * capped at all, which is backwards — the batch endpoint is the one a
 * well-behaved client uses. Eleven of them share one generous per-account
 * bucket now, and the operations publish its name and its cap so a client that
 * meets the ceiling can read which one it met.
 *
 * A published number is only worth reading if it cannot drift from the code, so
 * this pulls the bucket key and the limit out of `prisma.$queryRaw` — the same
 * technique `rate-limit-auth-surface.test.ts` uses — and holds the emitted
 * OpenAPI description to what came back. Reading both from the same constant
 * would prove nothing: the sentence is written by hand, deliberately, and this
 * is what keeps the hand-written half honest.
 *
 * The route half is structural: every route in the list below calls the shared
 * helper. Its limit is that it reads the file rather than the running handler,
 * so a call placed after an early return would still count as present.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RECORD_WRITE_BUCKET_PREFIX,
  RECORD_WRITE_LIMIT,
  RECORD_WRITE_WINDOW_MS,
  checkRecordWriteRateLimit,
} from "@/lib/rate-limit";
import { buildOpenApiDocument } from "@/lib/openapi/registry";
import { recordWriteRateLimitResponse } from "@/lib/openapi/routes/shared";

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: vi.fn() } }));

import { prisma } from "@/lib/db";

/**
 * The single-record writes on the shared bucket, paired with the operation
 * that publishes it. Hand-listed on purpose: the point of the list is that
 * adding a create without the limiter is a decision somebody has to make, and
 * a list derived from the routes that already call it could not notice one.
 */
const ON_THE_SHARED_BUCKET: Array<[route: string, openApiPath: string]> = [
  ["src/app/api/measurements/route.ts", "/api/measurements"],
  ["src/app/api/mood-entries/route.ts", "/api/mood-entries"],
  ["src/app/api/medications/intake/route.ts", "/api/medications/intake"],
  [
    "src/app/api/medications/[id]/intake/route.ts",
    "/api/medications/{id}/intake",
  ],
  ["src/app/api/labs/route.ts", "/api/labs"],
  [
    "src/app/api/custom-metrics/[id]/entries/route.ts",
    "/api/custom-metrics/{id}/entries",
  ],
  ["src/app/api/cycle/day-logs/route.ts", "/api/cycle/day-logs"],
  ["src/app/api/vaccinations/route.ts", "/api/vaccinations"],
  ["src/app/api/allergies/route.ts", "/api/allergies"],
  ["src/app/api/biomarkers/route.ts", "/api/biomarkers"],
  ["src/app/api/encounters/route.ts", "/api/encounters"],
];

/** The published sentence, read from the object the route modules spread. */
const published = recordWriteRateLimitResponse["429"].description;

beforeEach(() => {
  vi.mocked(prisma.$queryRaw).mockReset();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([
    { count: 1, reset_at: new Date(Date.now() + 60_000) },
  ] as never);
});

describe("the shared single-record write bucket", () => {
  it("keys on the account under the name the contract publishes", async () => {
    await checkRecordWriteRateLimit("account-7");

    const call = vi.mocked(prisma.$queryRaw).mock.calls.at(-1)!;
    // `$queryRaw\`INSERT … VALUES (${key}, …)\`` lands the key at index 1 and
    // the window interval at index 2.
    expect(call[1]).toBe("record-write:account-7");
    expect(call[2]).toBe(`${RECORD_WRITE_WINDOW_MS} milliseconds`);
    expect(published).toContain("`record-write:<accountId>`");
    expect(`${RECORD_WRITE_BUCKET_PREFIX}:account-7`).toBe(call[1]);
  });

  it("refuses at the cap the contract publishes", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { count: RECORD_WRITE_LIMIT, reset_at: new Date(Date.now() + 60_000) },
    ] as never);
    await expect(checkRecordWriteRateLimit("account-7")).resolves.toMatchObject(
      { allowed: true, limit: RECORD_WRITE_LIMIT, remaining: 0 },
    );

    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      {
        count: RECORD_WRITE_LIMIT + 1,
        reset_at: new Date(Date.now() + 60_000),
      },
    ] as never);
    await expect(checkRecordWriteRateLimit("account-7")).resolves.toMatchObject(
      { allowed: false },
    );

    const windowSeconds = RECORD_WRITE_WINDOW_MS / 1000;
    expect(published).toContain(
      `${RECORD_WRITE_LIMIT} requests per ${windowSeconds} seconds`,
    );
  });

  it("says the headers describe that bucket, and declares them", () => {
    expect(Object.keys(recordWriteRateLimitResponse["429"].headers)).toEqual([
      "Retry-After",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ]);
    expect(published).toContain("Retry-After");
  });

  it("is called by every route that publishes it", () => {
    const missing = ON_THE_SHARED_BUCKET.filter(([route]) => {
      const src = readFileSync(join(process.cwd(), route), "utf8");
      return !src.includes("checkRecordWriteRateLimit(");
    }).map(([route]) => route);
    expect(missing).toEqual([]);
  });

  it("is published on every operation that answers it", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        { post?: { responses?: Record<string, { description?: string }> } }
      >;
    };
    const unpublished = ON_THE_SHARED_BUCKET.filter(
      ([, path]) =>
        doc.paths[path]?.post?.responses?.["429"]?.description !== published,
    ).map(([, path]) => path);
    expect(unpublished).toEqual([]);
  });
});
