/**
 * Read-only before/after count of correlation findings per account, for the
 * release-candidate dry run of the v1.42 statistics change.
 *
 * v1.42 changes what the discovery engine accepts: trend and season are
 * removed from both series before correlating, p-values use the effective
 * sample size, shrinkage and the phrasing tier read that effective size, and
 * the weather channels are tested once over the averaged day-before-and-same-
 * day exposure instead of a next-day lag. Every one of those can make an
 * existing finding disappear. This script answers "how many, and where",
 * on a copy of production, before the release ships.
 *
 * For each account it builds the matrix exactly as the correlations route
 * does (same assembler, same 180-day window, same module map, same tiered
 * read) and scans it twice:
 *
 *  - BEFORE: the pre-v1.42 rules, restated here from the engine's own
 *    exported pieces (lag join at 1 day, Pearson with df = n − 2, BH-FDR,
 *    shrinkage and tier by n), over the raw daily weather values;
 *  - AFTER: the engine as it now ships.
 *
 * It prints counts only. No correlation, p-value, metric value or account
 * identifier leaves the database: accounts are listed by a short hash of
 * their id, channels by their stable key family. Nothing is written — the
 * pattern store is not synced, no cache is touched.
 *
 * Run (inside the app container, which has DATABASE_URL):
 *   pnpm dlx tsx scripts/compare-correlation-findings.ts [--limit N]
 */
import "dotenv/config";

import { createHash } from "node:crypto";

import { prisma } from "@/lib/db";
import { resolveModuleMap } from "@/lib/modules/gate";
import { assembleDiscoveryMatrix } from "@/lib/insights/discovery-matrix";
import { MIN_PAIRED_N, pearson } from "@/lib/insights/correlations";
import {
  benjaminiHochberg,
  confidenceTier,
  discoverCorrelations,
  discoverEmergingCorrelations,
  EARLY_FDR_Q,
  EARLY_MIN_PAIRS,
  EARLY_WINDOW_DAYS,
  FDR_Q,
  filterSeriesToWindow,
  lagJoin,
  metricFamily,
  shrinkEstimate,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import { ENVIRONMENT_FIELDS } from "@/lib/environment/fields";
import {
  isSurfaceVisible,
  correlationChannelSurfaceId,
} from "@/lib/modules/surface";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

const MS_PER_DAY = 86_400_000;
/** The correlations route's window. */
const WINDOW_DAYS = 180;

interface Finding {
  behaviour: string;
  outcome: string;
}

interface LegacyFinding extends Finding {
  tier: ReturnType<typeof confidenceTier>;
}

/** The pre-v1.42 discovery rules, restated from the engine's parts. */
function legacyDiscover(
  series: NamedSeries[],
  opts: { minPairs: number; fdrQ: number },
): { found: LegacyFinding[]; pairsTested: number } {
  const behaviours = series.filter((s) => s.role === "behaviour");
  const outcomes = series.filter((s) => s.role === "outcome");
  const tested: Array<Finding & { n: number; r: number; pValue: number }> = [];
  for (const b of behaviours) {
    for (const o of outcomes) {
      if (metricFamily(b.key) === metricFamily(o.key)) continue;
      const { xs, ys } = lagJoin(b.points, o.points, 1);
      if (xs.length < opts.minPairs) continue;
      const result = pearson({ xs, ys, minPairs: opts.minPairs });
      if (result.status !== "ok") continue;
      tested.push({
        behaviour: b.key,
        outcome: o.key,
        n: result.n,
        r: result.r,
        pValue: result.pValue,
      });
    }
  }
  const q = benjaminiHochberg(tested.map((t) => t.pValue));
  const found = tested
    .filter((t, i) => t.pValue < 0.05 && q[i] <= opts.fdrQ)
    .map((t) => ({
      behaviour: t.behaviour,
      outcome: t.outcome,
      tier: confidenceTier(shrinkEstimate(t.r, t.n), t.n),
    }))
    .filter((t) => t.tier !== null);
  return { found, pairsTested: tested.length };
}

/** The pre-v1.42 emerging pass: same rules, trailing window, no faint tier. */
function legacyEmerging(
  series: NamedSeries[],
  retrospective: Finding[],
  recentFromDayKey: string,
): Finding[] {
  const recent = legacyDiscover(
    filterSeriesToWindow(series, recentFromDayKey),
    { minPairs: EARLY_MIN_PAIRS, fdrQ: EARLY_FDR_Q },
  );
  const established = new Set(retrospective.map(key));
  return recent.found
    .filter((f) => f.tier !== "faint")
    .filter((f) => !established.has(key(f)));
}

function key(f: Finding): string {
  return `${f.behaviour}␟${f.outcome}`;
}

function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The weather channels as the engine read them before v1.42: one raw daily
 * value per field, no averaging. Read here directly because the shipped
 * series now carries the averaged window.
 */
async function legacyEnvironmentSeries(
  userId: string,
  since: Date,
): Promise<Map<string, DailySeriesPoint[]>> {
  // Same UTC lower bound the engine's own environment read uses.
  const sinceKey = since.toISOString().slice(0, 10);
  const rows = await prisma.environmentContext.findMany({
    where: { userId, date: { gte: sinceKey } },
    orderBy: { date: "asc" },
    take: 1000,
  });
  const out = new Map<string, DailySeriesPoint[]>();
  for (const field of ENVIRONMENT_FIELDS) {
    const points: DailySeriesPoint[] = [];
    for (const row of rows) {
      const raw = row[field.column];
      if (raw == null || !Number.isFinite(raw)) continue;
      const value =
        field.column === "sunshineSec" || field.column === "daylightSec"
          ? raw / 3600
          : raw;
      points.push({ day: row.date, value });
    }
    out.set(field.key, points);
  }
  return out;
}

/** Channel family label for the aggregate table (no user data). */
function familyLabel(channel: string): string {
  if (channel.startsWith("ENV_")) return "ENVIRONMENT";
  if (channel.startsWith("CUSTOM_METRIC:")) return "CUSTOM_METRIC";
  if (channel.startsWith("SYMPTOM:")) return "SYMPTOM_EVENT";
  if (channel.startsWith("FACTOR:")) return "MOOD_FACTOR";
  return channel;
}

interface Tally {
  before: number;
  after: number;
}

function bump(map: Map<string, Tally>, k: string, side: keyof Tally) {
  const t = map.get(k) ?? { before: 0, after: 0 };
  t[side]++;
  map.set(k, t);
}

function parseLimit(argv: string[]): number | undefined {
  const i = argv.indexOf("--limit");
  if (i === -1) return undefined;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  const users = await prisma.user.findMany({
    select: { id: true, timezone: true },
    orderBy: { createdAt: "asc" },
    ...(limit ? { take: limit } : {}),
  });

  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY);
  const byBehaviour = new Map<string, Tally>();
  const byOutcome = new Map<string, Tally>();
  const totals = {
    accounts: 0,
    scanned: 0,
    retroBefore: 0,
    retroAfter: 0,
    recentBefore: 0,
    recentAfter: 0,
    kept: 0,
    lost: 0,
    gained: 0,
  };

  console.log(
    "account   tested(b/a)  retro b→a  recent b→a  kept lost new  env b→a",
  );
  for (const user of users) {
    totals.accounts++;
    const tz = user.timezone ?? DEFAULT_TIMEZONE;
    const modules = await resolveModuleMap(user.id);
    const { series } = await assembleDiscoveryMatrix(user.id, {
      tz,
      since,
      fetchMode: "tiered",
      modules,
    });
    const envVisible = isSurfaceVisible(
      correlationChannelSurfaceId(ENVIRONMENT_FIELDS[0].key),
      modules,
    );
    const rawEnv = envVisible
      ? await legacyEnvironmentSeries(user.id, since)
      : new Map<string, DailySeriesPoint[]>();
    const legacySeries: NamedSeries[] = series.map((s) =>
      s.key.startsWith("ENV_")
        ? { key: s.key, role: s.role, points: rawEnv.get(s.key) ?? [] }
        : { key: s.key, role: s.role, label: s.label, points: s.points },
    );

    const recentFromDayKey = tzDayKey(
      new Date(now.getTime() - EARLY_WINDOW_DAYS * MS_PER_DAY),
      tz,
    );

    const legacy = legacyDiscover(legacySeries, {
      minPairs: MIN_PAIRED_N,
      fdrQ: FDR_Q,
    });
    const before = legacy.found;
    const beforeRecent = legacyEmerging(legacySeries, before, recentFromDayKey);
    const after = discoverCorrelations(series, { locale: "en" });
    const afterRecent = discoverEmergingCorrelations(series, after, {
      recentFromDayKey,
      locale: "en",
    });

    if (legacy.pairsTested === 0 && after.pairsTested === 0) continue;
    totals.scanned++;

    const beforeKeys = new Set(before.map(key));
    const afterKeys = new Set(after.discovered.map(key));
    const kept = [...afterKeys].filter((k) => beforeKeys.has(k)).length;
    const lost = beforeKeys.size - kept;
    const gained = afterKeys.size - kept;
    const envBefore = before.filter((f) => f.behaviour.startsWith("ENV_"));
    const envAfter = after.discovered.filter((f) =>
      f.behaviour.startsWith("ENV_"),
    );

    for (const f of before) {
      bump(byBehaviour, familyLabel(f.behaviour), "before");
      bump(byOutcome, familyLabel(f.outcome), "before");
    }
    for (const f of after.discovered) {
      bump(byBehaviour, familyLabel(f.behaviour), "after");
      bump(byOutcome, familyLabel(f.outcome), "after");
    }

    totals.retroBefore += before.length;
    totals.retroAfter += after.discovered.length;
    totals.recentBefore += beforeRecent.length;
    totals.recentAfter += afterRecent.emerging.length;
    totals.kept += kept;
    totals.lost += lost;
    totals.gained += gained;

    const tag = createHash("sha256").update(user.id).digest("hex").slice(0, 8);
    console.log(
      [
        tag.padEnd(9),
        `${legacy.pairsTested}/${after.pairsTested}`.padEnd(12),
        `${before.length}→${after.discovered.length}`.padEnd(10),
        `${beforeRecent.length}→${afterRecent.emerging.length}`.padEnd(11),
        String(kept).padStart(4),
        String(lost).padStart(4),
        String(gained).padStart(3),
        ` ${envBefore.length}→${envAfter.length}`,
      ].join(" "),
    );
  }

  console.log("");
  console.log(
    `accounts ${totals.accounts}, with a testable matrix ${totals.scanned}`,
  );
  console.log(
    `retrospective findings ${totals.retroBefore} → ${totals.retroAfter} (kept ${totals.kept}, lost ${totals.lost}, new ${totals.gained})`,
  );
  console.log(
    `emerging findings ${totals.recentBefore} → ${totals.recentAfter}`,
  );
  const table = (title: string, map: Map<string, Tally>) => {
    console.log("");
    console.log(`${title}: before → after`);
    for (const [k, t] of [...map.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      console.log(`  ${k.padEnd(24)} ${t.before} → ${t.after}`);
    }
  };
  table("by behaviour family", byBehaviour);
  table("by outcome family", byOutcome);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
