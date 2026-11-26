/**
 * The time-of-day greeting has ONE evaluator.
 *
 * The dashboard header and the insights hero both open with a salutation
 * bucketed by the wall-clock hour. For a long time three different pieces
 * of code answered "what hour is it":
 *
 *   - the dashboard snapshot builder, which computed a `greetingHour` in
 *     the user's zone and shipped it on the payload "so the client never
 *     has to run its own Intl" — and which no client ever read;
 *   - the insights hero, through the shared `hourInTz` (profile zone,
 *     Europe/Berlin when the zone will not resolve);
 *   - the dashboard header, through a local helper that fell back to the
 *     DEVICE clock whenever the zone would not resolve.
 *
 * At one instant, for one account, those three returned 20, 21 and 05.
 *
 * The server value lost. It is not a derived fact about the record, it is
 * a clock read, and the snapshot body is served stale-while-revalidate for
 * up to an hour — long enough for a baked-in hour to name a salutation the
 * clock had left behind. What the server IS authoritative for is the zone,
 * and that already reaches every client on the same payload.
 *
 * This guard fails if either end drifts back:
 *   T1 — the snapshot builder or its OpenAPI schema starts carrying a
 *        greeting hour again.
 *   T2 — a greeting surface reads a clock that is not `hourInTz` — the
 *        device zone via `Date#getHours`, or a hand-rolled `Intl` walk.
 *   T3 — behaviourally, the shared helper stays on the profile zone even
 *        when the device sits elsewhere and the zone will not resolve.
 *
 * T1/T2 are grep-shaped and assert a non-zero match count, so an empty
 * sweep fails loudly instead of passing silently.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hourInTz, DEFAULT_TIMEZONE } from "@/lib/tz/format";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const SERVER_FILES = [
  "lib/dashboard/snapshot.ts",
  "lib/openapi/routes/insights/schemas.ts",
] as const;

/** Every surface that paints a time-of-day salutation. */
const GREETING_SURFACES = [
  "components/dashboard/dashboard-header.tsx",
] as const;

describe("T1 — the snapshot payload carries no wall-clock hour", () => {
  it.each(SERVER_FILES)("%s declares no greeting hour", (rel) => {
    const src = read(rel);
    expect(src.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/greetingHour/);
    expect(src).not.toMatch(/hourInTimezone/);
  });

  it("still resolves the zone the clients read", () => {
    const src = read("lib/dashboard/snapshot.ts");
    expect(src).toMatch(/timezone:\s*userTz/);
  });
});

describe("T2 — every greeting surface reads the shared helper", () => {
  it.each(GREETING_SURFACES)("%s derives its hour from hourInTz", (rel) => {
    const src = read(rel);
    expect(src.length).toBeGreaterThan(0);
    // Imported from the shared module, not re-implemented next door.
    expect(src).toMatch(
      /import[\s\S]*?\bhourInTz\b[\s\S]*?from "@\/lib\/tz\/format"/,
    );
    const calls = src.match(/\bhourInTz\s*\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(GREETING_SURFACES)("%s reads no device-local clock", (rel) => {
    const src = read(rel);
    // `getHours()` is the device zone by definition; a hand-rolled
    // `Intl.DateTimeFormat` for the hour is the second evaluator this
    // guard exists to prevent.
    expect(src).not.toMatch(/\.getHours\s*\(/);
    expect(src).not.toMatch(/Intl\.DateTimeFormat/);
    expect(src).not.toMatch(/getHourForTimeZone/);
  });

  it("the retired header helper is gone from the tree", () => {
    const src = read("components/dashboard/range-display.tsx");
    expect(src.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/getHourForTimeZone/);
  });
});

describe("T3 — the profile zone beats the device zone", () => {
  const INSTANT = new Date("2026-03-01T20:30:00Z");
  const originalTz = process.env.TZ;

  afterAll(() => {
    vi.useRealTimers();
    process.env.TZ = originalTz;
  });

  it("follows the configured zone while the device sits ten hours away", () => {
    process.env.TZ = "Asia/Tokyo";
    vi.useFakeTimers();
    vi.setSystemTime(INSTANT);

    // The device says 05:30 (morning). The account is configured for
    // Berlin, where it is 21:30 (evening).
    expect(new Date().getHours()).toBe(5);
    expect(hourInTz(new Date(), "Europe/Berlin")).toBe(21);
  });

  it("falls back to the shared default, never to the device clock", () => {
    process.env.TZ = "Asia/Tokyo";
    vi.useFakeTimers();
    vi.setSystemTime(INSTANT);

    // A zone this runtime cannot resolve — a recently added IANA entry on
    // an older engine is the realistic case. The header helper used to
    // answer with the device hour here, splitting the two greetings by
    // sixteen hours for the same account at the same instant.
    const unresolvable = hourInTz(new Date(), "Europe/Atlantis");
    expect(unresolvable).toBe(hourInTz(new Date(), DEFAULT_TIMEZONE));
    expect(unresolvable).not.toBe(new Date().getHours());
  });
});
