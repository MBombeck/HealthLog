/**
 * Deterministic synthetic daily series for the correlation tests.
 *
 * A fixed-seed generator (mulberry32 + Box–Muller), never `Math.random`, so
 * every simulation run is reproducible and a regression shows up as the same
 * number every time. The fixtures mirror the shapes real data has: AR(1)
 * noise (today resembles yesterday), an optional annual cycle, gaps.
 */
import type { DailySeriesPoint } from "../../correlation-discovery";

export interface Rng {
  /** Uniform in [0, 1). */
  u: () => number;
  /** Standard normal. */
  n: () => number;
}

/** mulberry32 with a Box–Muller normal on top. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = () => {
    let x = 0;
    while (x === 0) x = u();
    return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u());
  };
  return { u, n };
}

/** Stationary AR(1) noise with lag-1 autocorrelation `rho` and SD `sd`. */
export function ar1(rng: Rng, length: number, rho: number, sd: number) {
  const out: number[] = [];
  let v = rng.n() * sd;
  for (let i = 0; i < length; i++) {
    v = rho * v + Math.sqrt(1 - rho * rho) * sd * rng.n();
    out.push(v);
  }
  return out;
}

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` of `start` plus `offset` days. */
export function dayKey(start: string, offset: number): string {
  const [y, m, d] = start.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + offset * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * Day-keyed points from an array starting at `start`; `null` entries are gaps
 * (no point emitted).
 */
export function toSeries(
  values: ReadonlyArray<number | null>,
  start = "2025-01-01",
): DailySeriesPoint[] {
  const out: DailySeriesPoint[] = [];
  values.forEach((value, i) => {
    if (value != null) out.push({ day: dayKey(start, i), value });
  });
  return out;
}

/**
 * A behaviour/outcome pair with a real next-day coupling: the outcome on day
 * D+1 is `slope` × the behaviour on day D plus independent noise. Both arms
 * are mildly autocorrelated, like real daily vitals.
 */
export function coupledPair(
  seed: number,
  length: number,
  slope: number,
  opts: { noiseSd?: number; behaviourRho?: number; outcomeRho?: number } = {},
): { behaviour: number[]; outcome: number[] } {
  const rng = seededRng(seed);
  const behaviour = ar1(rng, length, opts.behaviourRho ?? 0.2, 1);
  const noise = ar1(rng, length, opts.outcomeRho ?? 0.2, opts.noiseSd ?? 1);
  const outcome = noise.map(
    (e, d) => 50 + e + (d > 0 ? slope * behaviour[d - 1] : 0),
  );
  return { behaviour: behaviour.map((v) => 10 + v), outcome };
}

export interface SeasonalScenario {
  /** Days in the scenario. */
  days: number;
  /**
   * Day of the year the scenario starts on (0 = 1 January). `"random"` draws
   * a phase per run from the same seeded stream.
   */
  startDoy: number | "random";
  /**
   * True next-day effect of the temperature ANOMALY on systolic, mmHg per K.
   * 0 is the null scenario: the two series share the season and nothing else.
   */
  beta?: number;
  /** Fraction of days dropped at random from each series. */
  missing?: number;
  /** Length of one contiguous block missing from the systolic series. */
  block?: number;
}

/**
 * The simulation model behind the v1.42 statistics change (#615 research):
 *
 *   temperature = 10 + 8·sin(2π·doy/365) + AR(1)(ρ 0.7, sd 3)
 *   systolic    = 125 − 3·sin(2π·doy/365) + AR(1)(ρ 0.3, sd 8)
 *                 + beta · temperatureAnomaly(day − 1)
 *
 * Temperature is warm in summer, blood pressure lower: with `beta = 0` the
 * two share only the season, so any "finding" is a false positive. Returns
 * day-keyed series in 2025 (+ following year as needed).
 */
export function seasonalScenario(
  seed: number,
  scenario: SeasonalScenario,
): {
  temperature: DailySeriesPoint[];
  systolic: DailySeriesPoint[];
} {
  const rng = seededRng(seed);
  const doy0 =
    scenario.startDoy === "random"
      ? Math.floor(rng.u() * 365)
      : scenario.startDoy;
  const { days } = scenario;
  const beta = scenario.beta ?? 0;
  const tempNoise = ar1(rng, days, 0.7, 3);
  const sysNoise = ar1(rng, days, 0.3, 8);
  const temp: Array<number | null> = [];
  const sys: Array<number | null> = [];
  for (let d = 0; d < days; d++) {
    const phase = (2 * Math.PI * (doy0 + d)) / 365;
    temp.push(10 + 8 * Math.sin(phase) + tempNoise[d]);
    sys.push(
      125 -
        3 * Math.sin(phase) +
        sysNoise[d] +
        (d > 0 ? beta * tempNoise[d - 1] : 0),
    );
  }
  const missing = scenario.missing ?? 0;
  const drop = (values: Array<number | null>) =>
    values.map((v) => (rng.u() < missing ? null : v));
  const tempOut = drop(temp);
  const sysOut = drop(sys);
  const block = scenario.block ?? 0;
  if (block > 0) {
    const startAt = Math.floor(rng.u() * (days - block));
    for (let d = startAt; d < startAt + block; d++) sysOut[d] = null;
  }
  const start = dayKey("2025-01-01", doy0);
  return {
    temperature: toSeries(tempOut, start),
    systolic: toSeries(sysOut, start),
  };
}
