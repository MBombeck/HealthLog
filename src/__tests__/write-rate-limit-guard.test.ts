/**
 * Structural guard: every mutating route meets a rate limit.
 *
 * 169 of 364 mutating handlers met no limiter at all: every PATCH and DELETE
 * on an `[id]`, and most single-record creates. The shared per-account write
 * bucket now sits on the identity resolvers (`meterAccountWrite`,
 * `src/lib/auth/write-meter.ts`), so a route that resolves its caller through
 * one of them is metered without knowing it. This guard is what keeps that
 * true for the routes added next year:
 *
 *   - a route file exporting POST, PUT, PATCH or DELETE must either resolve
 *     its caller through a metering resolver, call a limiter of its own, or
 *     stand in {@link UNMETERED} with the reason;
 *   - a route that opts out of the shared bucket (`writeBucket: "own"`) must
 *     stand in {@link OWN_BUCKET} with the reason AND call its own limiter, so
 *     the opt-out can never mean "no limit";
 *   - a helper that limits on a route's behalf is accepted only while its own
 *     source calls a limiter.
 *
 * The routes are derived from the tree, never listed by hand. The check is
 * per file, not per handler: a file whose GET resolves through a metering
 * resolver while its POST does not would pass. Comments are stripped first;
 * the planted cases at the top prove the matchers fire.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { guardSourceOf } from "./helpers/auth-guards";
import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * The resolvers that charge the shared write bucket: the guards in
 * `lib/auth/guards/`, imported by routes through `lib/api-handler.ts`.
 */
const METERING_RESOLVERS = [
  "requireAuth",
  "requireRecordAuth",
  "requireActorAuth",
  "requireGuardianAuth",
  "requireAdmin",
  "requireCookieAuth",
  "requireFreshMfa",
  "requireFreshMfaIfEnrolled",
  "requireFreshMfaOrElevationIfEnrolled",
  "requireRecentProof",
  "requireBearerAuth",
  "requireMfaManagementAuth",
];

/** Helpers that call a limiter on the route's behalf, and where they live. */
const LIMITING_HELPERS: Record<string, string[]> = {
  claimGate: ["lib/managed-profiles/claim-gate.ts"],
  applyWebhookRateLimit: [
    "lib/withings/webhook-handler.ts",
    "lib/whoop/webhook-handler.ts",
  ],
  // v1.44 — the lab and medication CSV imports: a preview bucket for a dry
  // run, the shared `import:` bucket for the import itself.
  handleRecordImport: ["lib/import/record-import-route.ts"],
};

/** Mutating routes with no limit, each with the reason it needs none. */
const UNMETERED: Record<string, string> = {
  "app/api/auth/logout/route.ts":
    "Ends the caller's own session or token and nothing else. It is idempotent, writes no record data, and refusing it would keep alive a credential its holder asked to end.",
};

/** Routes metered by a dedicated bucket instead of the shared one. */
const OWN_BUCKET: Record<string, string> = {
  "app/api/measurements/batch/route.ts":
    "The HealthKit uploader sends up to 60 batches of 500 a minute, and an outbox replay of parked pages bypasses the client pacer; the route's own 60-a-minute batch bucket meters it.",
  "app/api/workouts/batch/route.ts":
    "The workout importer sends page after page during a catch-up pass; the route's own batch bucket meters it.",
  "app/api/medications/intake/bulk/route.ts":
    "The Apple Health dose import and the standalone adoption send 200 to 500 intakes per request in sequence; the route's own bulk bucket meters it.",
  "app/api/mood-entries/bulk/route.ts":
    "The standalone adoption sends 200 entries per request in sequence; the route's own bulk bucket meters it.",
  "app/api/cycle/day-logs/bulk/route.ts":
    "The cycle HealthKit sweep sends 500-day slices in sequence; the route's own bulk bucket meters it.",
  "app/api/nutrients/batch/route.ts":
    "The nutrient sync sends 500-row batches in sequence; the route's own batch bucket meters it.",
  "app/api/insights/chat/route.ts":
    "A Coach turn is metered by the Coach's own buckets: 20 turns a minute (`coach-chat`) and one turn slot at a time.",
  "app/api/insights/chat/fenced/route.ts":
    "A fenced document chat turn is metered by its own per-account bucket, sized for model turns.",
  "app/api/documents/inbound/[id]/chat/route.ts":
    "A document chat turn is metered by its own per-account bucket, sized for model turns.",
  "app/api/insights/ecg/route.ts":
    "The ECG sweep sends one recording per request with no client-side delay, newest first, over the whole HealthKit history; the route's own 600-a-minute ingest bucket meters it.",
};

const WRITES =
  /export\s+(?:const|async\s+function)\s+(POST|PUT|PATCH|DELETE)\b/;
const OWN_LIMITER = /\b(?:check\w*RateLimit|checkRateLimit)\s*\(/;
const OPTS_OUT = /\bwriteBucket\s*:\s*["']own["']/;

function callsAny(code: string, names: readonly string[]): boolean {
  return names.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(code));
}

function limited(code: string): boolean {
  return (
    OWN_LIMITER.test(code) || callsAny(code, Object.keys(LIMITING_HELPERS))
  );
}

describe("every mutating route meets a rate limit", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
    (file) => !file.startsWith("generated/") && !file.includes("__tests__/"),
  );
  const read = (file: string) =>
    stripComments(readFileSync(join(SRC, file), "utf8"));
  const mutating = files
    .filter((f) => /^app\/.+\/route\.tsx?$/.test(f))
    .filter((f) => WRITES.test(read(f)));

  it("the matchers fire on planted sources", () => {
    expect(WRITES.test("export const PATCH = apiHandler(async () => {")).toBe(
      true,
    );
    expect(WRITES.test("export async function DELETE(req) {")).toBe(true);
    expect(WRITES.test("export const GET = apiHandler(async () => {")).toBe(
      false,
    );
    expect(
      callsAny(
        'const { user } = await requireRecordAuth("write", "labs");',
        METERING_RESOLVERS,
      ),
    ).toBe(true);
    // A resolver named in a comment or an import does not count.
    expect(
      callsAny(
        stripComments(
          "import { requireAuth } from 'x';\n// requireAuth() here",
        ),
        METERING_RESOLVERS,
      ),
    ).toBe(false);
    expect(OPTS_OUT.test('requireAuth(SCOPE, { writeBucket: "own" })')).toBe(
      true,
    );
    expect(limited("const rl = await checkRateLimit(`k:${id}`, 5, 60)")).toBe(
      true,
    );
    expect(limited("const rl = rateLimitHeaders(x)")).toBe(false);
  });

  it("finds the mutating routes", () => {
    expect(mutating.length).toBeGreaterThanOrEqual(300);
  });

  it("meters every mutating route, or names why not", () => {
    const unlimited = mutating.filter((f) => {
      if (f in UNMETERED) return false;
      const code = read(f);
      const metered =
        callsAny(code, METERING_RESOLVERS) && !OPTS_OUT.test(code);
      return !metered && !limited(code);
    });
    expect(unlimited).toEqual([]);
  });

  it("holds every opt-out to the reviewed list, and each to its own limiter", () => {
    const optedOut = mutating.filter((f) => OPTS_OUT.test(read(f))).sort();
    expect(optedOut).toEqual(Object.keys(OWN_BUCKET).sort());
    const withoutOwn = optedOut.filter((f) => !OWN_LIMITER.test(read(f)));
    expect(withoutOwn).toEqual([]);
  });

  it("accepts a limiting helper only while it calls a limiter", () => {
    for (const [helper, homes] of Object.entries(LIMITING_HELPERS)) {
      for (const home of homes) {
        const code = read(home);
        expect(code, home).toMatch(
          new RegExp(`export\\s+async\\s+function\\s+${helper}\\b`),
        );
        expect(OWN_LIMITER.test(code), home).toBe(true);
      }
    }
  });

  it("keeps the exceptions to routes that exist and still need them", () => {
    for (const route of Object.keys(UNMETERED)) {
      expect(mutating).toContain(route);
      const code = read(route);
      expect(callsAny(code, METERING_RESOLVERS) || limited(code), route).toBe(
        false,
      );
    }
  });

  it("charges the bucket in each metering resolver", () => {
    /** The resolver's source, from its signature to the next export. */
    const resolverBody = (name: string): string => {
      const signature = new RegExp(
        `export\\s+async\\s+function\\s+${name}\\s*\\(`,
      );
      const handler = guardSourceOf(name, [signature]);
      const start = handler.search(signature);
      const next = handler.indexOf("\nexport ", start + 1);
      return handler.slice(start, next === -1 ? undefined : next);
    };
    for (const name of [
      "requireAuth",
      "requireActorAuth",
      "requireRecordAuth",
      "requireGuardianAuth",
      "requireAdmin",
      "requireCookieAuth",
      "requireFreshMfa",
      "requireBearerAuth",
    ]) {
      expect(resolverBody(name), name).toMatch(/\bmeterAccountWrite\s*\(/);
    }
    // The three that only delegate reach the meter through `requireAuth`.
    for (const name of [
      "requireFreshMfaIfEnrolled",
      "requireFreshMfaOrElevationIfEnrolled",
      "requireRecentProof",
    ]) {
      expect(resolverBody(name), name).toMatch(/\brequireAuth\s*\(/);
    }
  });
});
