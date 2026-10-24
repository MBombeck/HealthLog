/**
 * The canonical-source pick, against a real Postgres: the shipped statement
 * (group the window to `(type, day, source)` first, then `DISTINCT ON`)
 * against the statement it replaced (`DISTINCT ON` over every raw row),
 * kept verbatim below as the reference. Only its window anchor changed: it
 * counts from the same bound instant the shipped helper takes, where it read
 * `NOW()`, so both cut one window.
 *
 * Both must return exactly the same rows, for every reader shape the helper
 * serves (all types or one type, a trailing window or none), under the
 * default ladders and under user ladders that reorder them, over a fixture
 * that carries what could tell them apart: overlapping sources on the same
 * day, a source off the ladder, a day where the winning source's only row is
 * tombstoned, readings either side of UTC midnight and of a DST change in
 * the user's zone, empty days, and several readings per source per day.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { boundInstantSql } from "@/lib/analytics/request-clock-sql";
import {
  buildSourceRankCase,
  canonicalMeasurementsCte,
} from "@/lib/analytics/source-rank-sql";

import { makeUser } from "../kit/factories";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-canonical-parity";
const DAY_MS = 86_400_000;
/** The instant both statements count their window from, bound at `$2`. */
const NOW_SQL = boundInstantSql(2);

/** The pick as it stood before it grouped first. */
function legacyCanonicalMeasurementsCte(
  rankUnqualified: string,
  sinceInterval?: string,
  onlyType?: MeasurementType,
): string {
  const sinceInner = sinceInterval
    ? `AND "measured_at" >= ${NOW_SQL} - INTERVAL '${sinceInterval}'`
    : "";
  const sinceOuter = sinceInterval
    ? `AND mm."measured_at" >= ${NOW_SQL} - INTERVAL '${sinceInterval}'`
    : "";
  const typeInner = onlyType
    ? `AND "type" = '${onlyType}'::"measurement_type"`
    : "";
  const typeOuter = onlyType
    ? `AND mm."type" = '${onlyType}'::"measurement_type"`
    : "";
  return `
        SELECT mm.*
        FROM measurements mm
        JOIN (
          SELECT DISTINCT ON ("type", date_trunc('day', "measured_at"))
            "type"                           AS t,
            date_trunc('day', "measured_at") AS d,
            "source"                         AS canon
          FROM measurements
          WHERE "user_id" = $1
            AND "deleted_at" IS NULL
            ${sinceInner}
            ${typeInner}
          ORDER BY "type", date_trunc('day', "measured_at"), (${rankUnqualified}), "source"::text
        ) c
          ON c.t = mm."type"
          AND c.d = date_trunc('day', mm."measured_at")
          AND c.canon = mm."source"
        WHERE mm."user_id" = $1
          AND mm."deleted_at" IS NULL
          ${sinceOuter}
          ${typeOuter}`;
}

/** Small seeded generator, so the fixture is the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOURCES: MeasurementSource[] = [
  "APPLE_HEALTH",
  "WITHINGS",
  "WHOOP",
  "OURA",
  "MANUAL",
  // Off every ladder below: the name tiebreak decides.
  "NIGHTSCOUT",
];
const TYPES: MeasurementType[] = [
  "PULSE",
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "WEIGHT",
  "ACTIVITY_STEPS",
  "BLOOD_GLUCOSE",
];

async function seed(): Promise<number> {
  const prisma = getPrismaClient();
  await makeUser({ id: USER_ID, timezone: "Europe/Berlin" });
  const random = rng(42);
  const now = Date.now();
  const rows: Array<{
    userId: string;
    type: MeasurementType;
    source: MeasurementSource;
    value: number;
    unit: string;
    measuredAt: Date;
    deletedAt: Date | null;
  }> = [];
  // 140 days: across the 90-day window edge, and over the last DST change.
  for (let day = 0; day < 140; day++) {
    if (day % 11 === 5) continue; // an empty day
    const dayStart = Math.floor((now - day * DAY_MS) / DAY_MS) * DAY_MS;
    for (const type of TYPES) {
      const sourceCount = 1 + Math.floor(random() * 3);
      const sources = [...SOURCES]
        .sort(() => random() - 0.5)
        .slice(0, sourceCount);
      for (const source of sources) {
        const readings = 1 + Math.floor(random() * 4);
        for (let r = 0; r < readings; r++) {
          // Mostly mid-day, sometimes a minute either side of UTC midnight.
          const offset =
            r === 0 && random() < 0.2
              ? random() < 0.5
                ? 60_000
                : DAY_MS - 60_000
              : Math.floor(random() * DAY_MS);
          rows.push({
            userId: USER_ID,
            type,
            source,
            value: Math.round(random() * 1000) / 10,
            unit: "x",
            measuredAt: new Date(dayStart + offset),
            // A tombstone, sometimes the only row its source had that day.
            deletedAt: random() < 0.08 ? new Date() : null,
          });
        }
      }
    }
  }
  // The natural identity is unique; drop accidental collisions.
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const key = `${row.type}|${row.source}|${row.measuredAt.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  await prisma.measurement.createMany({ data: unique });
  return unique.length;
}

const LADDERS: Array<[string, unknown]> = [
  ["default ladders", null],
  [
    "user ladders that reorder them",
    {
      pulse: ["APPLE_HEALTH", "WITHINGS"],
      restingHeartRate: ["OURA", "APPLE_HEALTH", "WHOOP"],
      hrv: ["APPLE_HEALTH"],
      weight: ["MANUAL", "WITHINGS"],
      steps: ["WITHINGS", "APPLE_HEALTH"],
    },
  ],
];

const SHAPES: Array<[string, string | undefined, MeasurementType | undefined]> =
  [
    ["every type, 90 days", "90 days", undefined],
    ["every type, no window", undefined, undefined],
    ["one type, 366 days", "366 days", "PULSE"],
    ["one unranked type, 30 days", "30 days", "BLOOD_GLUCOSE"],
    ["one type, 7 days", "7 days", "RESTING_HEART_RATE"],
  ];

describe("canonical-source pick parity", () => {
  let seeded = 0;
  beforeAll(async () => {
    await truncateAllTables(getPrismaClient());
    seeded = await seed();
  });

  it("seeds a fixture worth comparing", () => {
    expect(seeded).toBeGreaterThan(2000);
  });

  for (const [ladderLabel, ladder] of LADDERS) {
    for (const [shapeLabel, since, onlyType] of SHAPES) {
      it(`returns the same rows: ${ladderLabel}, ${shapeLabel}`, async () => {
        const prisma = getPrismaClient();
        const rank = buildSourceRankCase(ladder, '"type"', '"source"');
        const at = new Date();
        const window = since ? { from: NOW_SQL, interval: since } : undefined;
        const select = (cte: string) =>
          prisma.$queryRawUnsafe<
            Array<{ id: string; type: string; source: string }>
          >(
            `WITH cm AS (${cte}) SELECT id, type::text AS type, source::text AS source FROM cm ORDER BY id`,
            USER_ID,
            ...(window ? [at] : []),
          );
        const [now, before] = await Promise.all([
          select(canonicalMeasurementsCte(rank, window, onlyType)),
          select(legacyCanonicalMeasurementsCte(rank, since, onlyType)),
        ]);
        expect(now.length).toBeGreaterThan(0);
        expect(now).toEqual(before);
        // The pick dropped something, so the comparison is not trivial.
        if (!onlyType || onlyType === "PULSE") {
          const live = await prisma.measurement.count({
            where: {
              userId: USER_ID,
              deletedAt: null,
              ...(onlyType ? { type: onlyType } : {}),
            },
          });
          if (!since) expect(now.length).toBeLessThan(live);
        }
      });
    }
  }
});
