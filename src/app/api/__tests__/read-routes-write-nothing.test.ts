/**
 * Structural guard: the three read routes that used to write must stay reads.
 *
 * `src/lib/auth/guards/context.ts` states the invariant next to `READ_HTTP_METHODS` —
 * an MCP-audience token is admitted on GET/HEAD/OPTIONS on the REST surface
 * because those methods are assumed side-effect-free, and adding a
 * side-effecting GET silently widens that token's reach. These three routes
 * each broke it once. The runtime tests beside each route prove the specific
 * write is gone; this one fails on a NEW one.
 *
 * Deliberately scoped to these three files and to writes issued directly in
 * the handler. A repo-wide version is not written today because it cannot be
 * written without false positives: several read routes call helpers that
 * legitimately upsert a lazily-created row (`getOrCreateCycleProfile` behind
 * `requireCycleEnabled` is the clearest one), and a text matcher cannot tell
 * that apart from a real side effect. Widening this guard means resolving
 * those cases first, not loosening the pattern.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { stripComments } from "../../../__tests__/helpers/source-files";

/** Mutating Prisma model methods, as they appear at a call site. */
const PRISMA_WRITE =
  /\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany|executeRaw|executeRawUnsafe)\s*\(/;

/**
 * Write helpers these routes used to reach for. A helper hides its writes
 * from the pattern above, so each one that mattered here is named.
 */
const WRITE_HELPERS =
  /\b(persistPredictionCache|markSyncCheckpoint|auditLog\s*\()/;

const ROUTES = [
  "sync/state/route.ts",
  "gamification/achievements/route.ts",
  "cycle/calendar/route.ts",
];

function sourceOf(relative: string): string {
  return readFileSync(join(__dirname, "..", relative), "utf8");
}

/**
 * Strip comments before matching. Every one of these files DESCRIBES the
 * write it no longer performs, and a guard that reads prose as code is a
 * guard that fires on its own documentation.
 */
function code(source: string): string {
  return stripComments(source);
}

describe("read routes issue no writes", () => {
  it("the patterns actually match a write — otherwise every case below is vacuous", () => {
    expect(
      PRISMA_WRITE.test(`await prisma.user.update({ where: { id } });`),
    ).toBe(true);
    expect(
      PRISMA_WRITE.test(`prisma.userAchievement.createMany({ data });`),
    ).toBe(true);
    expect(WRITE_HELPERS.test(`void persistPredictionCache(userId, p);`)).toBe(
      true,
    );
    // And do NOT match the reads these routes are made of.
    expect(PRISMA_WRITE.test(`await prisma.measurement.findMany({});`)).toBe(
      false,
    );
    expect(PRISMA_WRITE.test(`await prisma.moodEntry.count({});`)).toBe(false);
  });

  it("scans all three routes and finds real source in each", () => {
    // An empty read set would pass every assertion below without looking at
    // anything.
    expect(ROUTES).toHaveLength(3);
    for (const route of ROUTES) {
      expect(code(sourceOf(route)).length).toBeGreaterThan(500);
    }
  });

  for (const route of ROUTES) {
    it(`${route} calls no mutating Prisma method`, () => {
      expect(code(sourceOf(route))).not.toMatch(PRISMA_WRITE);
    });

    it(`${route} calls no known write helper`, () => {
      expect(code(sourceOf(route))).not.toMatch(WRITE_HELPERS);
    });
  }
});
