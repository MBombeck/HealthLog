/**
 * Demo Data Seed Script for HealthLog
 *
 * Creates a realistic, aspirational demo tenant for the public `demo`
 * account (demo / demo123demo123 — credentials are intentionally public).
 * The shape is tuned so a fresh seed reads healthy, engaged, and current
 * for App-Store / marketing screenshots:
 *
 * - 1 admin user (demo/demo123demo123)
 * - 90 days of measurements (weight, BP, pulse, resting HR, body fat,
 *   sleep, steps, fortnightly waist) — flat-or-improving trends,
 *   most-recent point from today
 * - A full week of per-stage sleep nights (awake/REM/light(core)/deep),
 *   ~7.5 h each, including last night
 * - 90 days of body composition (fat/lean/muscle mass, total body water,
 *   bone mass, visceral fat, BMI) derived from the same-day weight + body fat
 * - 90 days of blood glucose in a healthy non-diabetic band (fasting +
 *   post-meal + bedtime, contexts tagged) plus a 14-day Nightscout-style CGM
 *   stream (a reading every 15 min) so the glucose panel renders fully
 * - 90 days of cardio fitness + vitals (HRV SDNN + RMSSD, SpO2, respiratory
 *   rate, VO2 max, active energy, walking/running distance, flights climbed)
 * - 90 days of WHOOP-style scores (recovery, day strain, sleep
 *   performance/efficiency/consistency) coherent with the sleep nights
 * - ~3-4 workouts/week (running, strength, cycling) with per-workout HR
 *   samples and per-workout strain
 * - 3 medications with schedules and ~90 days of intake history at high
 *   compliance, with today scheduled on-track (taken or not-yet-due)
 * - 90 days of mood entries
 * - Six mental-wellbeing screeners (WHO-5, PHQ-9, GAD-7) spread over the
 *   window, item answers encrypted the way the check-in route writes them
 * - Vorsorge (preventive-care) reminders — upcoming dental + annual physical
 * - Two lab panels of biomarkers across two dates (quantitative with
 *   reference ranges + qualitative "negativ" rows)
 * - Two illness episodes — a resolved acute cold with a day-by-day symptom
 *   curve, and a recurring condition with a resolved spring flare; nothing
 *   is left open, so the account is not in Rest Mode
 * - Cycle tracking opted in: ~5 observed cycles with biphasic basal body
 *   temperature, period flow, fertile-window mucus/OPK, per-day symptoms,
 *   and a cached forward prediction
 * - Two practitioners, a knee arthroscopy with its operative report and
 *   discharge letter linked (small generated PDFs), its follow-up visit, and
 *   a check-up booked for tomorrow morning
 * - An AI-configured Coach with five sample conversations spread from
 *   today back over a few weeks
 * - App settings (registration disabled, English locale, the key-backup
 *   step confirmed for the key the demo runs with)
 * - A multi-year history before the 90-day window (about four and a half
 *   years) for the timeline and the day view: blood pressure in bursts with
 *   real gaps, weekly weight, phone steps, watch resting heart rate / HRV /
 *   sleep from the third year, yearly blood panels, a resolved chronic
 *   condition and infections, ramipril with a dose change and a sick-day
 *   pause, flu shots, visits, life events at day / month / year precision,
 *   a sealed home location with a holiday period, and stored weather, air
 *   quality and pollen for every day. The timeline module is switched on.
 *
 * Every date is relative to "now" so the demo stays fresh on every re-seed.
 * What ages is the SEEDED DATA, not the script: the pillar windows keep
 * moving after a seed, so about four weeks on, activity (21 of the last
 * 28 days) and sleep (14 of 28 nights) fall out of their windows and the
 * Health Score narrows to whatever cardiometabolic data is still fresh.
 * Since v1.38 that is a labelled partial score rather than a blank card,
 * but it is still not the demo at its best — re-seed to restore breadth.
 *
 * The five areas of health the score can span all have data here on
 * purpose: cardiometabolic (BP, glucose, lipids), activity (steps),
 * sleep, adiposity (waist) and wellbeing (screeners). Removing any one
 * of them does not break the seed; it quietly narrows what the demo's
 * score can show.
 *
 * Usage: npx tsx scripts/seed-demo.ts
 * Requires DATABASE_URL env var. The Coach sample conversations additionally
 * needs ENCRYPTION_KEYS / ENCRYPTION_KEY (the same key the app runs with).
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import pg from "pg";
import { encryptToBytes } from "../src/lib/ai/coach/bytes-codec";
import {
  encrypt,
  encryptBytes,
  getActiveKeyId,
  getKeyFingerprint,
} from "../src/lib/crypto";
import { ENVIRONMENT_LOCATION_AAD } from "../src/lib/crypto/encrypted-columns";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  serializeDashboardLayout,
} from "../src/lib/dashboard-layout";
import {
  INSTRUMENT_MEASUREMENT_TYPE,
  scoreTotal,
  severityBand,
} from "../src/lib/mental-health/instruments";
import { VALUE_RANGES } from "../src/lib/validations/measurement";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Every timestamp column here is `timestamp without time zone` holding UTC,
// which is how Prisma reads it. node-postgres serialises a Date in the host's
// local zone by default and Postgres drops the offset on the cast, so a seed
// run from a machine on Berlin time stored every instant two hours in the
// future (today's Coach thread stamped after "now", the CGM stream running
// into the evening). Sending Dates as UTC makes the result independent of
// the seed host's clock zone.
pg.defaults.parseInputDatesAsUTC = true;

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// ── Helpers ──────────────────────────────────────

function cuid(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "c";
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(
    7 + Math.floor(Math.random() * 3),
    Math.floor(Math.random() * 60),
    0,
    0,
  );
  return d;
}

// A specific local instant N days ago, at a fixed wall-clock time. Used for
// the per-stage sleep segments and the on-track intake slots where the hour
// matters (a random morning hour would scatter the sleep stages).
function daysAgoAt(n: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// The UTC instant of `hh:mm` Europe/Berlin local on the Berlin calendar day
// that contains `ref`. This mirrors `localHmAsUtc` (src/lib/tz/local-day.ts):
// the medication scheduling engine mints today's dose-slot anchor as the UTC
// instant of the schedule's window_start in the user's timezone (the demo
// user is Europe/Berlin). The dashboard's slot-resolution matches a taken
// intake row to a slot only when the row's `scheduled_for` sits on (or, for a
// slot-anchored row, within ±6h of) that canonical instant. We must compute
// the same instant here — independent of the seed host's own clock zone — so
// today's taken rows satisfy the 08:00 slot rather than floating beside it.
function berlinHmAsUtc(hour: number, minute = 0, ref: Date = new Date()): Date {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(ref).map((p) => [p.type, p.value]),
  );
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  // `hour` can come back as "24" at midnight in some runtimes; normalise.
  const refHour = Number(parts.hour) % 24;
  const localTargetAsUtc = Date.UTC(y, mo - 1, d, hour, minute, 0, 0);
  const localNowAsUtc = Date.UTC(
    y,
    mo - 1,
    d,
    refHour,
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = Math.round((localNowAsUtc - ref.getTime()) / 60000) * 60000;
  return new Date(localTargetAsUtc - offsetMs);
}

// The day key the insight read paths compare against. The per-metric status
// cards stamp `dateKey = toBerlinDayKey(now)` (src/lib/tz/resolver.ts) and the
// read serves a row only when its `dateKey` equals today's Berlin key. The
// demo user is Europe/Berlin, so we mint the same key here so the baked cards
// always read as "today" on every re-seed, never stale.
function berlinDayKey(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Smooth random walk with mean reversion
function randomWalk(
  start: number,
  target: number,
  days: number,
  volatility: number,
  // Optional physiological band. A free walk can drift below the floor and
  // mint an out-of-range row (a systolic-0 BP reading was observed in a
  // fresh seed — iOS #33); clamping every step keeps the series inside the
  // same band the input validator enforces.
  clamp?: { min: number; max: number },
): number[] {
  const values: number[] = [start];
  for (let i = 1; i < days; i++) {
    const prev = values[i - 1];
    const drift = (target - prev) * 0.03; // mean reversion
    const noise = (Math.random() - 0.5) * volatility;
    let next = Math.round((prev + drift + noise) * 10) / 10;
    if (clamp) next = Math.min(clamp.max, Math.max(clamp.min, next));
    values.push(next);
  }
  return values;
}

// A one-page PDF carrying a few lines of Helvetica text, built by hand so the
// seed needs no PDF library. The byte offsets in the cross-reference table are
// computed, so viewers and the thumbnail renderer open it as a normal file.
function simplePdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = lines
    .map((line, i) =>
      i === 0
        ? `BT /F1 16 Tf 56 780 Td (${esc(line)}) Tj ET`
        : `BT /F1 11 Tf 56 ${760 - i * 18} Td (${esc(line)}) Tj ET`,
    )
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets)
    body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// Pin a series' last point (today) to the median of the four weeks before it.
// A free walk can end on a tail value, and the vitals check holds today's
// reading against exactly that personal band: a demo whose oxygen saturation
// happened to land low read "below your range" on the start page. The median
// sits inside the band by construction, so today reads as an ordinary day.
function settleLatest(values: number[], lookback = 28): void {
  if (values.length < 2) return;
  const prior = values
    .slice(Math.max(0, values.length - 1 - lookback), values.length - 1)
    .sort((a, b) => a - b);
  const mid = Math.floor(prior.length / 2);
  const median =
    prior.length % 2 === 1 ? prior[mid] : (prior[mid - 1] + prior[mid]) / 2;
  values[values.length - 1] = Math.round(median * 10) / 10;
}

// ── Multi-year history ───────────────────────
// The timeline and the day view read years, not weeks. Everything before the
// 90-day window is written by `seedHistory` below; these anchors place its
// story (all in days before "now") so the sections that share a date agree.

/** How far back the record reaches: about four and a half years. */
const HISTORY_DAYS = 1650;
/** Ramipril 2.5 mg starts after a blood-pressure work-up. */
const RAMIPRIL_START_DAYS_AGO = 1130;
/** Ramipril raised to 5 mg when the readings stay above target. */
const RAMIPRIL_DOSE_UP_DAYS_AGO = 760;
/** A sick-day pause of ramipril during a stomach bug. */
const RAMIPRIL_PAUSE = { from: 425, to: 416 };
/** Vitamin D3 from the winter before last. */
const VITAMIN_D_START_DAYS_AGO = 400;
/** A daughter is born; sleep and the blood-pressure habit both suffer. */
const DAUGHTER_BORN_DAYS_AGO = 650;
/** A watch arrives at the start of the record's third year. */
const WATCH_FROM_DAYS_AGO = 912;
/** One summer holiday away from home. */
const HOLIDAY = { from: 470, to: 457 };

/** The demo's home: a neutral German city, coarse (one decimal). */
const DEMO_HOME = { lat: 48.0, lon: 7.8, label: "Freiburg" };
/** The holiday location, coarse; its label is never shown on a surface. */
const DEMO_HOLIDAY_PLACE = { lat: 54.1, lon: 12.1, label: "Holiday" };

/**
 * Piecewise-linear target through `[daysAgo, value]` knots, oldest first.
 * Outside the knots the nearest end holds.
 */
function knotValue(knots: Array<[number, number]>, n: number): number {
  if (n >= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [d0, v0] = knots[i - 1];
    const [d1, v1] = knots[i];
    if (n <= d0 && n >= d1) {
      const f = d0 === d1 ? 0 : (d0 - n) / (d0 - d1);
      return v0 + (v1 - v0) * f;
    }
  }
  return knots[knots.length - 1][1];
}

/** Uniform noise in `[-amp, amp]`. */
function jitter(amp: number): number {
  return (Math.random() * 2 - 1) * amp;
}

/** The calendar quarter of a Berlin day key, e.g. `2025-Q3`. */
function quarterOf(dayKey: string): string {
  const month = Number(dayKey.slice(5, 7));
  return `${dayKey.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
}

/** Day of the year (1–366) of a `YYYY-MM-DD` key. */
function dayOfYear(dayKey: string): number {
  const d = Date.UTC(
    Number(dayKey.slice(0, 4)),
    Number(dayKey.slice(5, 7)) - 1,
    Number(dayKey.slice(8, 10)),
  );
  return (
    Math.floor((d - Date.UTC(Number(dayKey.slice(0, 4)), 0, 1)) / 864e5) + 1
  );
}

/** Seal a coarse location the way `sealLocation` does in the app. */
function sealDemoLocation(loc: {
  lat: number;
  lon: number;
  label: string;
}): Buffer {
  return encryptBytes(
    Buffer.from(
      JSON.stringify({ lat: loc.lat, lon: loc.lon, label: loc.label }),
      "utf8",
    ),
    ENVIRONMENT_LOCATION_AAD,
  );
}

/**
 * Multi-row INSERT in chunks, so a few thousand history rows do not cost a
 * round trip each. `rows` are positional, in `columns` order.
 */
async function bulkInsert(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  chunk = 500,
): Promise<void> {
  for (let start = 0; start < rows.length; start += chunk) {
    const slice = rows.slice(start, start + chunk);
    const params: unknown[] = [];
    const tuples = slice.map((row) => {
      const marks = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${marks.join(", ")})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`,
      params,
    );
  }
}

/** Pollen season bump: 0 outside `[from, to]`, peaking at `peak` mid-season. */
function pollenSeason(
  doy: number,
  from: number,
  to: number,
  peak: number,
): number {
  if (doy < from || doy > to) return 0;
  const phase = (doy - from) / (to - from);
  return peak * Math.sin(Math.PI * phase) ** 2;
}

/** Hours of daylight at latitude `lat` on day-of-year `doy`. */
function daylightHours(lat: number, doy: number): number {
  const rad = Math.PI / 180;
  const decl = 23.44 * Math.sin(rad * (360 / 365) * (284 + doy));
  const x = -Math.tan(lat * rad) * Math.tan(decl * rad);
  const ha = Math.acos(Math.min(1, Math.max(-1, x))) / rad;
  return (2 * ha) / 15;
}

// ── Main ─────────────────────────────────────────

async function seed() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log("Cleaning existing data...");
    await client.query("DELETE FROM coach_messages");
    await client.query("DELETE FROM coach_conversations");
    await client.query("DELETE FROM consent_receipts");
    await client.query("DELETE FROM insight_narratives");
    await client.query("DELETE FROM insight_status_caches");
    await client.query("DELETE FROM illness_symptom_links");
    await client.query("DELETE FROM illness_day_logs");
    await client.query("DELETE FROM illness_episodes");
    await client.query("DELETE FROM cycle_symptom_links");
    await client.query("DELETE FROM cycle_day_logs");
    await client.query("DELETE FROM cycle_predictions");
    await client.query("DELETE FROM menstrual_cycles");
    await client.query("DELETE FROM cycle_profiles");
    await client.query("DELETE FROM lab_results");
    await client.query("DELETE FROM measurement_reminders");
    await client.query("DELETE FROM mood_entries");
    await client.query("DELETE FROM workout_samples");
    await client.query("DELETE FROM workouts");
    await client.query("DELETE FROM medication_intake_events");
    await client.query("DELETE FROM medication_schedules");
    await client.query("DELETE FROM reminder_phase_configs");
    await client.query("DELETE FROM medications");
    await client.query("DELETE FROM measurements");
    await client.query("DELETE FROM user_achievements");
    await client.query("DELETE FROM audit_logs");
    await client.query("DELETE FROM sessions");
    await client.query("DELETE FROM passkeys");
    await client.query("DELETE FROM auth_challenges");
    await client.query("DELETE FROM notification_channels");
    await client.query("DELETE FROM push_subscriptions");
    await client.query("DELETE FROM api_tokens");
    await client.query("DELETE FROM data_backups");
    await client.query("DELETE FROM users");

    // ── User ──────────────────────────────────
    console.log("Creating demo user...");
    const userId = cuid();
    // argon2id hash of "demo123demo123" — pre-computed
    // We'll use a bcrypt-compatible approach: register via API later
    // For now, insert with a placeholder and we'll set it via the app
    const passwordHash =
      "$argon2id$v=19$m=65536,t=3,p=4$Kips6OxPAl0vmspO9SoKZQ$oX9gLgwHVnnENCqBloyM13ewuqmhPnw8EpLoemS3MNI";

    // AI Coach is configured to the Anthropic provider so the Coach surface
    // reads as connected. The stored key is a placeholder ciphertext: the
    // public demo never makes a live provider call (the sample conversation
    // below supplies the visible content), so no real credential is seeded.
    const aiProvider = "ANTHROPIC";
    const aiModel = "claude-3-5-sonnet";
    const aiKeyEncrypted = encrypt("sk-ant-demo-placeholder-not-a-live-key");

    await client.query(
      `INSERT INTO users (id, username, email, password_hash, role, height_cm, date_of_birth, gender, timezone, locale, ai_provider, ai_model, ai_anthropic_key_encrypted, onboarding_completed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW(), NOW())`,
      [
        userId,
        "demo",
        "demo@healthlog.app",
        passwordHash,
        "ADMIN",
        182.0,
        "1990-05-15",
        "MALE",
        "Europe/Berlin",
        "en",
        aiProvider,
        aiModel,
        aiKeyEncrypted,
      ],
    );

    // ── Dashboard showcase layout ─────────────
    // The demo seeds rich sleep / steps / glucose / VO2max / vorsorge data,
    // so persist an explicit dashboard layout that surfaces those tiles plus
    // the daily-verdict hero. The v1.20.0 defaults already turn the data
    // tiles on, but writing the layout verbatim keeps the public demo's home
    // page stable regardless of future default tweaks. Derived from
    // DEFAULT_DASHBOARD_LAYOUT with the seeded-rich strip tiles forced on.
    const SHOWCASE_TILE_IDS = new Set([
      "sleep",
      "steps",
      "glucose",
      "vo2Max",
      "recentWorkouts",
    ]);
    const demoDashboardLayout = serializeDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) =>
        SHOWCASE_TILE_IDS.has(w.id) ? { ...w, tileVisible: true } : w,
      ),
    });
    await client.query(
      `UPDATE users SET dashboard_widgets_json = $1 WHERE id = $2`,
      [JSON.stringify(demoDashboardLayout), userId],
    );

    // ── Measurements (90 days) ────────────────
    // The loop runs i = 0..days (inclusive) so the final iteration lands a
    // point for TODAY (daysAgo(0)) — every headline metric has a current
    // reading for the dashboard, not one from yesterday.
    console.log("Creating 90 days of measurements...");
    const days = 90;
    const span = days + 1; // include today

    // Weight: 86.5 → trending down to a stable ~82 (healthy BMI ~24.7 at 182cm)
    const weights = randomWalk(86.5, 82.0, span, 0.6);
    // Systolic BP: 128 → settled in the optimal band ~118 (clamped)
    const sysBP = randomWalk(
      128,
      118,
      span,
      3,
      VALUE_RANGES.BLOOD_PRESSURE_SYS,
    );
    // Diastolic BP: 82 → settled ~76 (clamped)
    const diaBP = randomWalk(
      82,
      76,
      span,
      2.5,
      VALUE_RANGES.BLOOD_PRESSURE_DIA,
    );
    // Spot pulse (daytime heart rate): ~72, gently lower
    const pulse = randomWalk(74, 70, span, 3, VALUE_RANGES.PULSE);
    // Resting heart rate: clean ~60, the metric the resting-pulse tile scores
    const restingHr = randomWalk(
      64,
      58,
      span,
      2,
      VALUE_RANGES.RESTING_HEART_RATE,
    );
    // Body fat: 24% → trending to a healthy ~19%
    const bodyFat = randomWalk(24.0, 19.0, span, 0.4, VALUE_RANGES.BODY_FAT);
    // Sleep duration in MINUTES (the SLEEP_DURATION unit): ~7h → ~7h40m.
    // Kept close to the ~7.5 h per-stage nights below, which the start page
    // holds against this trailing average: a looser walk drifted to almost
    // nine hours and last night read as "1h 4m less than usual".
    const sleepMin = randomWalk(
      420,
      460,
      span,
      12,
      VALUE_RANGES.SLEEP_DURATION,
    );
    // Steps: 6500 → a solid ~9000
    const steps = randomWalk(6500, 9000, span, 1500);
    for (const series of [weights, sysBP, diaBP, pulse, restingHr]) {
      settleLatest(series);
    }

    for (let i = 0; i < span; i++) {
      const date = daysAgo(days - i);

      // Weight (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'WEIGHT', $3, 'kg', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, weights[i], date],
      );

      // Blood pressure (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'BLOOD_PRESSURE_SYS', $3, 'mmHg', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(sysBP[i]), date],
      );
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'BLOOD_PRESSURE_DIA', $3, 'mmHg', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(diaBP[i]), date],
      );

      // Spot pulse (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'PULSE', $3, 'bpm', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(pulse[i]), date],
      );

      // Resting heart rate (daily) — scored by the resting-pulse tile
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'RESTING_HEART_RATE', $3, 'bpm', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(restingHr[i]), date],
      );

      // Body fat (every 2-3 days)
      if (i % 2 === 0 || Math.random() > 0.5) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'BODY_FAT', $3, '%', 'MANUAL', $4, $4, $4)`,
          [cuid(), userId, bodyFat[i], date],
        );
      }

      // Sleep duration (daily, in minutes). This single aggregate row keeps
      // the 90-day sleep series continuous for the trend chart. The most
      // recent seven nights are instead written as per-stage breakdowns below
      // (one row per stage); skip the aggregate for those so a night is not
      // double-counted (aggregate + summed stages).
      const nightsAgo = days - i;
      if (nightsAgo >= 7) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'SLEEP_DURATION', $3, 'minutes', 'MANUAL', $4, $4, $4)`,
          [cuid(), userId, Math.round(sleepMin[i]), date],
        );
      }

      // Steps (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'ACTIVITY_STEPS', $3, 'steps', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(steps[i]), date],
      );

      // Waist circumference (fortnightly, plus today). The Health Score's
      // adiposity pillar scores waist-to-height against NICE 2022's 0.5,
      // and it is the ONLY route into that area of health — weight and
      // body fat feed the trends, never the score. Without a waist row
      // the demo account has no adiposity standing at all, so the score
      // rests on three areas instead of five. 96 cm down to 88 cm over
      // the window is 0.527 → 0.484 at the demo's 182 cm: the ratio
      // crosses the threshold inside the seeded span, which is what
      // makes the pillar worth looking at rather than flat green.
      const daysBack = days - i;
      if (daysBack % 14 === 0) {
        const waistCm = 96 - (8 * i) / (span - 1);
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'WAIST_CIRCUMFERENCE', $3, 'cm', 'MANUAL', $4, $4, $4)`,
          [cuid(), userId, Math.round(waistCm * 10) / 10, date],
        );
      }
    }

    // ── Mental-wellbeing screeners ────────────
    // WHO-5, PHQ-9 and GAD-7 over the same 90-day window. The score's
    // wellbeing pillar reads the FRESHEST completed screener, so the last
    // one written decides what that area of health says; the earlier ones
    // give the history view something to draw. Totals sit in the calm
    // bands on purpose — a demo is not the place to model a person in
    // distress, and item 9 is answered zero throughout, which also keeps
    // the pillar out of its crisis-signposting arm.
    //
    // Item answers are encrypted the way the check-in route writes them
    // (`{ items, schema: 1 }` through the shared Bytes codec), and each
    // administration gets its COMPUTED projection measurement so the
    // trend chart and the assessment history agree.
    console.log("Creating mental-wellbeing screeners...");
    const screeners: Array<{
      instrument: "WHO5" | "PHQ9" | "GAD7";
      items: number[];
      daysAgo: number;
    }> = [
      { instrument: "WHO5", items: [3, 3, 3, 2, 3], daysAgo: 76 },
      { instrument: "PHQ9", items: [1, 1, 0, 1, 0, 0, 1, 0, 0], daysAgo: 62 },
      { instrument: "GAD7", items: [1, 1, 0, 1, 0, 0, 0], daysAgo: 48 },
      { instrument: "WHO5", items: [4, 3, 4, 3, 3], daysAgo: 34 },
      { instrument: "PHQ9", items: [0, 1, 0, 0, 0, 0, 1, 0, 0], daysAgo: 20 },
      { instrument: "WHO5", items: [4, 4, 4, 3, 4], daysAgo: 6 },
    ];
    for (const screener of screeners) {
      const total = scoreTotal(screener.instrument, screener.items);
      const takenAt = daysAgoAt(screener.daysAgo, 20, 15);
      const assessmentId = cuid();
      await client.query(
        `INSERT INTO mental_health_assessments
           (id, user_id, instrument, locale, version, responses_encrypted, total_score, severity_band,
            item9_flagged, taken_at, tz, source, created_at, updated_at)
         VALUES ($1, $2, $3, 'en', 'standard', $4, $5, $6, false, $7, 'Europe/Berlin', 'WEB', $7, $7)`,
        [
          assessmentId,
          userId,
          screener.instrument,
          Buffer.from(
            encryptToBytes(
              JSON.stringify({ items: screener.items, schema: 1 }),
            ),
          ),
          total,
          severityBand(screener.instrument, total),
          takenAt,
        ],
      );
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, external_id, measured_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'score', 'COMPUTED', $5, $6, $6, $6)`,
        [
          cuid(),
          userId,
          INSTRUMENT_MEASUREMENT_TYPE[screener.instrument],
          total,
          `assessment:${assessmentId}`,
          takenAt,
        ],
      );
    }

    // ── Per-stage sleep nights (last 7 nights, incl. last night) ──
    // One SLEEP_DURATION row per stage, all stamped at the same wake instant,
    // mirroring how a HealthKit night lands (AWAKE / REM / CORE / DEEP, with
    // the legacy aggregate kept above). The reader sums the stages for the
    // night's total. Durations target a healthy ~7.5 h with a normal stage
    // mix (~55% core, ~22% REM, ~18% deep, ~5% awake). Source APPLE_HEALTH
    // with device_type 'watch' so the night reads as device-tracked rather
    // than a manual estimate.
    console.log("Creating per-stage sleep nights (7 nights)...");
    const sleepStages: Array<{ stage: string; fraction: number }> = [
      { stage: "AWAKE", fraction: 0.05 },
      { stage: "REM", fraction: 0.22 },
      { stage: "CORE", fraction: 0.55 },
      { stage: "DEEP", fraction: 0.18 },
    ];
    for (let n = 1; n <= 7; n++) {
      // Wake at ~06:50 with small per-night jitter; total ~7.5 h.
      const wake = daysAgoAt(n - 1, 6, 40 + Math.floor(Math.random() * 25));
      const totalMin = 440 + Math.floor(Math.random() * 40); // 7h20m – 8h
      for (const { stage, fraction } of sleepStages) {
        const stageMin = Math.round(totalMin * fraction);
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, sleep_stage, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'SLEEP_DURATION', $3, 'minutes', 'APPLE_HEALTH', $4, 'watch', $5, $5, $5)`,
          [cuid(), userId, stageMin, stage, wake],
        );
      }
    }

    // ── Body composition (smart-scale series) ──
    // A full scale-style breakdown, written every 2–3 days like a real
    // body-composition scale would record. Every component is DERIVED from
    // the same-day weight + body-fat series above so the numbers reconcile:
    // fat mass = weight × bodyFat%, fat-free mass = weight − fat mass, and
    // the muscle / water / bone / BMI components hang off those so the demo
    // never contradicts its own headline weight + body-fat tiles. Source
    // APPLE_HEALTH with device_type 'scale' so they read as device-tracked.
    // Canonical units (see prisma/schema.prisma + VALUE_RANGES): mass
    // components in kg, VISCERAL_FAT a 1–12 rating, BODY_MASS_INDEX kg/m².
    console.log("Creating body composition series...");
    const HEIGHT_M = 1.82;
    for (let i = 0; i < span; i++) {
      // Roughly every other day, jittered, so the cadence reads organic.
      if (i % 2 !== 0 && Math.random() > 0.4) continue;
      const date = daysAgo(days - i);
      const weightKg = weights[i];
      const fatPct = bodyFat[i];
      const fatMass = Math.round(weightKg * (fatPct / 100) * 10) / 10;
      const fatFree = Math.round((weightKg - fatMass) * 10) / 10;
      // Skeletal muscle is a subset of fat-free mass (~75% of it for a lean
      // adult male); lean body mass ≈ fat-free mass.
      const muscleMass = Math.round(fatFree * 0.75 * 10) / 10;
      const leanMass = fatFree;
      // Total body water ≈ 73% of fat-free mass (kg of water).
      const bodyWater = Math.round(fatFree * 0.73 * 10) / 10;
      const boneMass =
        Math.round((3.1 + (Math.random() - 0.5) * 0.2) * 10) / 10;
      // Visceral-fat rating on Withings' 1–12 scale; a healthy ~6, easing
      // down slightly as the body fat trends down.
      const visceralFat = Math.round(7 - (i / span) * 1.5);
      const bmi = Math.round((weightKg / (HEIGHT_M * HEIGHT_M)) * 10) / 10;

      const composition: Array<{ type: string; value: number; unit: string }> =
        [
          { type: "FAT_MASS", value: fatMass, unit: "kg" },
          { type: "FAT_FREE_MASS", value: fatFree, unit: "kg" },
          { type: "LEAN_BODY_MASS", value: leanMass, unit: "kg" },
          { type: "MUSCLE_MASS", value: muscleMass, unit: "kg" },
          { type: "TOTAL_BODY_WATER", value: bodyWater, unit: "kg" },
          { type: "BONE_MASS", value: boneMass, unit: "kg" },
          { type: "VISCERAL_FAT", value: visceralFat, unit: "rating" },
          { type: "BODY_MASS_INDEX", value: bmi, unit: "kg/m²" },
        ];
      for (const c of composition) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'APPLE_HEALTH', 'scale', $6, $6, $6)`,
          [cuid(), userId, c.type, c.value, c.unit, date],
        );
      }
    }

    // ── Blood glucose (healthy non-diabetic series) ──
    // A few readings per day over the full window, every value in a healthy
    // non-diabetic band: fasting ~85–95 mg/dL, a well-controlled post-meal
    // peak ~110–135, and a calm bedtime ~95–105. Canonical storage is mg/dL
    // (schema note on BLOOD_GLUCOSE); the per-reading context lands in the
    // glucose_context column (FASTING / POSTPRANDIAL / BEDTIME) so the
    // glucose panel can apply the right target band per reading.
    console.log("Creating blood glucose series...");
    const glucoseReadings: Array<{
      context: string;
      hour: number;
      base: number;
      jitter: number;
    }> = [
      { context: "FASTING", hour: 7, base: 89, jitter: 6 },
      { context: "POSTPRANDIAL", hour: 13, base: 122, jitter: 12 },
      { context: "POSTPRANDIAL", hour: 19, base: 118, jitter: 12 },
      { context: "BEDTIME", hour: 22, base: 99, jitter: 6 },
    ];
    // Glucose stops at yesterday. The vitals check compares a day's mean
    // against the band of full days, so a part day seeded up to the current
    // hour (fasting and breakfast only) read "below your range", and seeding
    // the whole day put the afternoon in the future. Yesterday's full day is
    // what the start page then reads.
    for (let i = 0; i < span - 1; i++) {
      for (const r of glucoseReadings) {
        const at = daysAgoAt(days - i, r.hour, Math.floor(Math.random() * 30));
        const value = Math.round(r.base + (Math.random() - 0.5) * r.jitter);
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, glucose_context, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'BLOOD_GLUCOSE', $3, 'mg/dL', 'APPLE_HEALTH', $4, 'phone', $5, $5, $5)`,
          [cuid(), userId, value, r.context, at],
        );
      }
    }

    // ── Continuous glucose (Nightscout-style CGM stream) ──
    // The clinical glucose panel above gives the spot fasting / post-meal /
    // bedtime contexts; a real CGM additionally streams a reading every few
    // minutes. Seed a dense, realistic 24 h-cycle stream for the most recent
    // 14 days (one sample every 15 min) so the glucose feature's CGM / time-
    // in-range surfaces render fully. Values follow a healthy circadian curve:
    // a calm overnight ~90, a dawn rise, gentle post-meal bumps at ~8/13/19h
    // that settle back inside range — every reading stays in the non-diabetic
    // band (70–140 mg/dL). Source NIGHTSCOUT with a stable external_id so the
    // (userId, type, source, externalId) immutable key makes the stream
    // idempotent across re-seeds (the real Nightscout sync's dedup key). The
    // measurements_glucose_context_requires_type CHECK forces a non-NULL
    // glucose_context on every BLOOD_GLUCOSE row, so each CGM sample is tagged
    // RANDOM (a free-running sensor reading has no meal context).
    console.log("Creating continuous glucose (CGM) stream...");
    const cgmDays = 14;
    const cgmStepMin = 15;
    // The stream ends with yesterday, for the reason given above the spot
    // readings.
    for (let d = cgmDays; d >= 1; d--) {
      for (let minute = 0; minute < 24 * 60; minute += cgmStepMin) {
        const hour = minute / 60;
        // Baseline overnight ~90; dawn phenomenon lifts it slightly toward
        // morning. Meal bumps are smooth gaussians centred on 8/13/19h.
        const dawn = hour >= 4 && hour <= 8 ? (hour - 4) * 2.5 : 0;
        const meal = (centre: number, peak: number, width: number) =>
          peak * Math.exp(-((hour - centre) ** 2) / (2 * width * width));
        const base =
          90 + dawn + meal(8, 28, 1.1) + meal(13, 34, 1.3) + meal(19, 30, 1.3);
        const value = Math.round(
          Math.min(140, Math.max(72, base + (Math.random() - 0.5) * 6)),
        );
        const at = daysAgoAt(d, Math.floor(hour), minute % 60);
        const externalId = `cgm-${formatDate(at)}-${minute}`;
        // The measurements_glucose_context_requires_type CHECK requires a
        // non-NULL glucose_context on every BLOOD_GLUCOSE row. A free-running
        // CGM sample carries no meal context, so RANDOM ("any time,
        // non-fasting, non-post-meal") is the correct enum value.
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, glucose_context, external_id, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'BLOOD_GLUCOSE', $3, 'mg/dL', 'NIGHTSCOUT', 'RANDOM', $4, $5, $5, $5)`,
          [cuid(), userId, value, externalId, at],
        );
      }
    }

    // ── Cardio fitness + vitals ───────────────
    // The dashboard + insights surface these device-tracked vitals. All
    // recent (full window, latest point today), all in healthy/aspirational
    // bands. Canonical units per schema + VALUE_RANGES: HRV ms,
    // OXYGEN_SATURATION percent, RESPIRATORY_RATE breaths/min, VO2_MAX
    // mL/(kg·min), ACTIVE_ENERGY_BURNED kcal, WALKING_RUNNING_DISTANCE metres,
    // FLIGHTS_CLIMBED count. Source APPLE_HEALTH device_type 'watch'.
    console.log("Creating cardio fitness + vitals series...");
    // HRV SDNN: a healthy ~55 ms, gently rising; also write the RMSSD variant.
    const hrvSdnn = randomWalk(
      48,
      58,
      span,
      5,
      VALUE_RANGES.HEART_RATE_VARIABILITY,
    );
    const hrvRmssd = randomWalk(42, 52, span, 5, VALUE_RANGES.HRV_RMSSD);
    // SpO2: 97–99%.
    const spo2 = randomWalk(98, 98, span, 0.8, VALUE_RANGES.OXYGEN_SATURATION);
    // Respiratory rate: 13–16 breaths/min.
    const respRate = randomWalk(
      15,
      14,
      span,
      0.8,
      VALUE_RANGES.RESPIRATORY_RATE,
    );
    // Active energy: ~550 kcal/day.
    const activeKcal = randomWalk(
      480,
      600,
      span,
      80,
      VALUE_RANGES.ACTIVE_ENERGY_BURNED,
    );
    // Walking + running distance (metres): ~6–8 km/day, tracks steps.
    const distM = randomWalk(
      6200,
      7800,
      span,
      900,
      VALUE_RANGES.WALKING_RUNNING_DISTANCE,
    );
    // Flights climbed: ~8–14/day.
    const flights = randomWalk(9, 13, span, 4, VALUE_RANGES.FLIGHTS_CLIMBED);
    for (const series of [hrvSdnn, hrvRmssd, spo2, respRate]) {
      settleLatest(series);
    }

    for (let i = 0; i < span; i++) {
      const date = daysAgo(days - i);
      const vitals: Array<{ type: string; value: number; unit: string }> = [
        {
          type: "HEART_RATE_VARIABILITY",
          value: Math.round(hrvSdnn[i]),
          unit: "ms",
        },
        { type: "HRV_RMSSD", value: Math.round(hrvRmssd[i]), unit: "ms" },
        {
          type: "OXYGEN_SATURATION",
          value: Math.round(spo2[i] * 10) / 10,
          unit: "%",
        },
        {
          type: "RESPIRATORY_RATE",
          value: Math.round(respRate[i] * 10) / 10,
          unit: "count/min",
        },
        {
          type: "ACTIVE_ENERGY_BURNED",
          value: Math.round(activeKcal[i]),
          unit: "kcal",
        },
        {
          type: "WALKING_RUNNING_DISTANCE",
          value: Math.round(distM[i]),
          unit: "m",
        },
        {
          type: "FLIGHTS_CLIMBED",
          value: Math.round(flights[i]),
          unit: "count",
        },
      ];
      for (const v of vitals) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'APPLE_HEALTH', 'watch', $6, $6, $6)`,
          [cuid(), userId, v.type, v.value, v.unit, date],
        );
      }
      // VO2 max: only every ~10 days (Apple samples it rarely), ~46–49.
      if (i % 10 === 0) {
        const vo2 = Math.round((46 + (i / span) * 3) * 10) / 10;
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'VO2_MAX', $3, 'mL/(kg·min)', 'APPLE_HEALTH', 'watch', $4, $4, $4)`,
          [cuid(), userId, vo2, date],
        );
      }
    }

    // ── Recovery / strain / sleep scores (WHOOP-style) ──
    // The WHOOP-style readiness surface. These are stored as Measurement rows
    // (type RECOVERY_SCORE / DAY_STRAIN / SLEEP_PERFORMANCE / SLEEP_EFFICIENCY
    // / SLEEP_CONSISTENCY, unit 'score' or '%') with source WHOOP, distinct
    // from the COMPUTED engine's own rows. Coherent with the seeded sleep:
    // well-slept nights pair with high recovery + efficiency, and day-strain
    // sits in a sustainable band. RECOVERY_SCORE / sleep percentages are
    // 0–100; DAY_STRAIN is on WHOOP's 0–21 scale.
    console.log("Creating recovery / strain / sleep scores...");
    const recovery = randomWalk(68, 78, span, 8, VALUE_RANGES.RECOVERY_SCORE);
    const dayStrain = randomWalk(11, 13, span, 2.5, VALUE_RANGES.DAY_STRAIN);
    const sleepPerf = randomWalk(
      82,
      90,
      span,
      6,
      VALUE_RANGES.SLEEP_PERFORMANCE,
    );
    const sleepEff = randomWalk(88, 93, span, 4, VALUE_RANGES.SLEEP_EFFICIENCY);
    const sleepConsistency = randomWalk(
      74,
      84,
      span,
      6,
      VALUE_RANGES.SLEEP_CONSISTENCY,
    );
    for (let i = 0; i < span; i++) {
      // Anchor scores to the morning wake instant so a night's recovery sits
      // on the day it belongs to.
      const at = daysAgoAt(days - i, 7, 0);
      const scores: Array<{ type: string; value: number; unit: string }> = [
        {
          type: "RECOVERY_SCORE",
          value: Math.round(recovery[i]),
          unit: "score",
        },
        {
          type: "DAY_STRAIN",
          value: Math.round(dayStrain[i] * 10) / 10,
          unit: "score",
        },
        {
          type: "SLEEP_PERFORMANCE",
          value: Math.round(sleepPerf[i]),
          unit: "%",
        },
        { type: "SLEEP_EFFICIENCY", value: Math.round(sleepEff[i]), unit: "%" },
        {
          type: "SLEEP_CONSISTENCY",
          value: Math.round(sleepConsistency[i]),
          unit: "%",
        },
      ];
      for (const s of scores) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'WHOOP', 'band', $6, $6, $6)`,
          [cuid(), userId, s.type, s.value, s.unit, at],
        );
      }
    }

    // ── Workouts ──────────────────────────────
    // ~3–4 sessions/week across the window: a mix of running, strength, and
    // cycling, with the fields the workout tiles render — duration, energy,
    // avg/max HR, distance (running/cycling). Each workout carries a sparse
    // HR sample series in WorkoutSamples (the per-workout HR chart) and its
    // per-workout strain in metadata (WORKOUT_STRAIN lives on the workout row
    // per the schema note, not as a free-floating Measurement). Distances in
    // metres, energy in kcal, durations in seconds — matching the model.
    console.log("Creating workouts...");
    const workoutPlan: Array<{
      sport: string;
      durationMin: number;
      kcal: number;
      avgHr: number;
      maxHr: number;
      distanceM: number | null;
      strain: number;
    }> = [
      {
        sport: "running",
        durationMin: 38,
        kcal: 420,
        avgHr: 148,
        maxHr: 171,
        distanceM: 6500,
        strain: 13.4,
      },
      {
        sport: "strength",
        durationMin: 52,
        kcal: 360,
        avgHr: 118,
        maxHr: 152,
        distanceM: null,
        strain: 10.2,
      },
      {
        sport: "cycling",
        durationMin: 65,
        kcal: 520,
        avgHr: 134,
        maxHr: 158,
        distanceM: 24000,
        strain: 12.1,
      },
    ];
    // Step backwards through the window placing ~2 sessions a week per slot
    // so the cadence lands around 3–4/week without overlapping.
    let planIdx = 0;
    for (let dayOffset = days - 1; dayOffset >= 1; dayOffset -= 2) {
      // Skip ~25% of slots so the week isn't perfectly regular.
      if (Math.random() < 0.25) continue;
      const plan = workoutPlan[planIdx % workoutPlan.length];
      planIdx += 1;
      const startHour = 17 + Math.floor(Math.random() * 3);
      const startedAt = daysAgoAt(
        dayOffset,
        startHour,
        Math.floor(Math.random() * 50),
      );
      const durationSec = plan.durationMin * 60;
      const endedAt = new Date(startedAt.getTime() + durationSec * 1000);
      const workoutId = cuid();
      await client.query(
        `INSERT INTO workouts (id, user_id, sport_type, started_at, ended_at, duration_sec, total_energy_kcal, total_distance_m, avg_heart_rate, max_heart_rate, source, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'APPLE_HEALTH', $11, $4, $4)`,
        [
          workoutId,
          userId,
          plan.sport,
          startedAt,
          endedAt,
          durationSec,
          plan.kcal,
          plan.distanceM,
          plan.avgHr,
          plan.maxHr,
          JSON.stringify({ workoutStrain: plan.strain }),
        ],
      );
      // A sparse HR series — one sample every ~5 minutes across the session,
      // rising into the working band and easing at the end. The per-workout
      // HR chart renders straight from this WorkoutSamples blob.
      const sampleCount = Math.max(2, Math.round(plan.durationMin / 5));
      const samples: Array<{ t: string; hr: number }> = [];
      for (let s = 0; s < sampleCount; s++) {
        const frac = s / (sampleCount - 1);
        // Warm up from ~60% to the avg, peak near the max around 70% through.
        const peakBias = 1 - Math.abs(frac - 0.7) * 0.6;
        const hr = Math.round(
          plan.avgHr + (plan.maxHr - plan.avgHr) * peakBias * 0.7,
        );
        const t = new Date(startedAt.getTime() + frac * durationSec * 1000);
        samples.push({ t: t.toISOString(), hr });
      }
      await client.query(
        `INSERT INTO workout_samples (id, workout_id, samples, sample_count, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [cuid(), workoutId, JSON.stringify(samples), samples.length],
      );
    }

    // ── Medications ───────────────────────────
    console.log("Creating medications...");

    // Medication 1: Ramipril (blood pressure). Started about three years
    // back at 2.5 mg and raised to 5 mg a year later; the multi-year history
    // section below writes the dose changes, a short sick-day pause and the
    // intakes before the 90-day window. `starts_on` is the stated start the
    // timeline lane draws from.
    const med1Id = cuid();
    await client.query(
      `INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, starts_on, created_at, updated_at)
       VALUES ($1, $2, 'Ramipril', '5mg', true, true, $3, $4, $4)`,
      [
        med1Id,
        userId,
        formatDate(daysAgo(RAMIPRIL_START_DAYS_AGO)),
        daysAgo(RAMIPRIL_START_DAYS_AGO),
      ],
    );
    const sched1Id = cuid();
    await client.query(
      `INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
       VALUES ($1, $2, '08:00', '10:00', 'Morning')`,
      [sched1Id, med1Id],
    );

    // Medication 2: Vitamin D3
    const med2Id = cuid();
    await client.query(
      `INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, starts_on, created_at, updated_at)
       VALUES ($1, $2, 'Vitamin D3', '2000 IU', true, true, $3, $4, $4)`,
      [
        med2Id,
        userId,
        formatDate(daysAgo(VITAMIN_D_START_DAYS_AGO)),
        daysAgo(VITAMIN_D_START_DAYS_AGO),
      ],
    );
    const sched2Id = cuid();
    await client.query(
      `INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
       VALUES ($1, $2, '08:00', '10:00', 'Morning')`,
      [sched2Id, med2Id],
    );

    // Medication 3: Magnesium (evening)
    const med3Id = cuid();
    await client.query(
      `INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, created_at, updated_at)
       VALUES ($1, $2, 'Magnesium', '400mg', true, true, $3, $3)`,
      [med3Id, userId, daysAgo(60)],
    );
    const sched3Id = cuid();
    await client.query(
      `INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
       VALUES ($1, $2, '20:00', '22:00', 'Evening')`,
      [sched3Id, med3Id],
    );

    // ── Medication Intake Events ──────────────
    // High compliance with no overdue doses. Historical days (i < days) carry
    // a taken/skip row at ~95%+ adherence. TODAY is handled separately below
    // so the dashboard always reads on-track (morning doses taken, the
    // evening dose left as a not-yet-due pending row — never a miss).
    console.log("Creating intake events (90 days)...");

    for (let i = 0; i < days; i++) {
      const date = daysAgo(days - i);
      // Anchor each historical intake's scheduled_for on its med's canonical
      // Berlin dose-slot for that day (08:00 morning, 20:00 evening) — the
      // same instant the scheduling engine attributes a take to — so taken
      // rows are slot-anchored (scheduled_for ≠ taken_at, resolved within the
      // ±6h radius) and skips land exactly on the slot. Anchoring on the slot
      // rather than a random morning hour keeps the compliance rollups and the
      // overdue search reading these past days as resolved.
      const morningSlotFor = berlinHmAsUtc(8, 0, date);
      const eveningSlotFor = berlinHmAsUtc(20, 0, date);

      // Ramipril: 98% compliance (miss ~1 every 50 days)
      const takeMed1 = Math.random() > 0.02;
      if (takeMed1) {
        const takenTime = new Date(morningSlotFor);
        takenTime.setMinutes(
          takenTime.getMinutes() + Math.floor(Math.random() * 45) + 1,
        );
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5, $5)`,
          [cuid(), userId, med1Id, morningSlotFor, takenTime],
        );
      } else {
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, true, 'WEB', $4, $4)`,
          [cuid(), userId, med1Id, morningSlotFor],
        );
      }

      // Vitamin D3: 95% compliance
      const takeMed2 = Math.random() > 0.05;
      if (takeMed2) {
        const takenTime = new Date(morningSlotFor);
        takenTime.setMinutes(
          takenTime.getMinutes() + Math.floor(5 + Math.random() * 50) + 1,
        );
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5, $5)`,
          [cuid(), userId, med2Id, morningSlotFor, takenTime],
        );
      } else {
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, true, 'WEB', $4, $4)`,
          [cuid(), userId, med2Id, morningSlotFor],
        );
      }

      // Magnesium: only last 60 days, 94% compliance
      if (i >= 30) {
        const takeMed3 = Math.random() > 0.06;
        if (takeMed3) {
          const takenTime = new Date(eveningSlotFor);
          takenTime.setMinutes(
            takenTime.getMinutes() + Math.floor(Math.random() * 60) + 1,
          );
          await client.query(
            `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5, $5)`,
            [cuid(), userId, med3Id, eveningSlotFor, takenTime],
          );
        } else {
          await client.query(
            `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
             VALUES ($1, $2, $3, $4, NULL, true, 'WEB', $4, $4)`,
            [cuid(), userId, med3Id, eveningSlotFor],
          );
        }
      }
    }

    // ── Today's doses (on-track, no overdue) ──
    // The dashboard today-tile attributes a taken intake to a computed dose
    // slot, where the slot's canonical instant is the schedule's window_start
    // in the user's timezone (08:00 Europe/Berlin for the morning meds). A
    // taken row only RESOLVES that slot when it is "slot-anchored"
    // (scheduled_for ≠ taken_at — then a ±6h radius applies); a row whose
    // scheduled_for equals taken_at to the millisecond is treated as an
    // ad-hoc take that only resolves a slot within ±60s, so an 08:30 ad-hoc
    // row leaves the 08:00 slot reading "overdue" while the take floats beside
    // it (the "2/6 today · overdue" screenshot). We therefore anchor
    // scheduled_for on the EXACT canonical slot instant (08:00 Berlin) and set
    // taken_at slightly later (08:30) so the row is slot-anchored and resolves
    // the morning slot cleanly. Both morning meds taken; evening Magnesium is
    // a pending row anchored on tonight's 20:00 Berlin slot — its anchor is in
    // the future until 20:00 local, so the overdue search never fires on it
    // and the compliance engine excludes a plain pending row from the
    // denominator. The result reads on-track at any daytime screenshot clock.
    console.log("Creating today's on-track doses...");
    const morningSlot = berlinHmAsUtc(8, 0); // canonical 08:00 slot instant
    const morningTaken = berlinHmAsUtc(8, 30); // taken inside the window
    await client.query(
      `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5, $5)`,
      [cuid(), userId, med1Id, morningSlot, morningTaken],
    );
    await client.query(
      `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5, $5)`,
      [cuid(), userId, med2Id, morningSlot, morningTaken],
    );
    const eveningSlot = berlinHmAsUtc(20, 0); // canonical 20:00 slot instant
    await client.query(
      `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, auto_missed, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, false, false, 'WEB', $4, $4)`,
      [cuid(), userId, med3Id, eveningSlot],
    );

    // ── AI-processing consent receipt ─────────
    // The Coach surface is gated behind an active AI-consent receipt whenever
    // the deployment resolves a server-managed (operator-key) provider chain.
    // The read path (`latestActiveReceipt`, src/lib/consent/receipts.ts)
    // filters only on { user_id, kind, revoked_at IS NULL } and never parses
    // the artefact, so a single active `ai_full` row — the master grant that
    // satisfies both the Coach and Insights surfaces — is enough to render the
    // seeded conversation on the read-only demo with no client-side accept
    // (which the read-only tenant would reject). The partial unique index
    // consent_receipts_user_id_kind_active_key allows exactly one active row
    // per (user, kind); we seed one. artefact is a clearly-labelled demo
    // placeholder (any non-empty value satisfies the gate).
    console.log("Creating AI-processing consent receipt...");
    await client.query(
      `INSERT INTO consent_receipts (id, user_id, kind, artefact, signed_at, revoked_at, created_at)
       VALUES ($1, $2, 'ai_full', $3, NOW(), NULL, NOW())`,
      [
        cuid(),
        userId,
        JSON.stringify({ source: "demo-seed", scope: "ai_full" }),
      ],
    );

    // ── Mood Entries ─────────────────────────
    console.log("Creating mood entries (90 days)...");

    const moodOptions = ["SUPER_GUT", "GUT", "OKAY", "SCHLECHT", "LAUSIG"];
    const tagOptions = [
      ["productive", "exercise", "well-rested"],
      ["focused", "social", "creative"],
      ["tired", "stressed"],
      ["anxious", "low-energy"],
      ["exhausted", "pain"],
    ];

    // Mood trend: starts solid (~3.5) and improves to ~4.4 — flat-or-up, so
    // the score never dips into an alarming band.
    const moodTrend = randomWalk(3.5, 4.4, span, 0.7);

    for (let i = 0; i < span; i++) {
      // Skip ~5% of days (forgot to log)
      if (Math.random() < 0.05) continue;

      const date = daysAgo(days - i);
      const rawScore = Math.round(Math.min(5, Math.max(1, moodTrend[i])));
      const mood = moodOptions[5 - rawScore]; // invert: score 5 = SUPER_GUT
      const tags = tagOptions[5 - rawScore];
      const loggedAt = new Date(date);
      loggedAt.setHours(21, Math.floor(Math.random() * 59), 0);
      // Today's evening entry has not happened yet when the seed runs
      // earlier in the day; it is logged a few minutes ago instead.
      if (loggedAt.getTime() > Date.now()) {
        loggedAt.setTime(Date.now() - 5 * 60_000);
      }

      await client.query(
        `INSERT INTO mood_entries (id, user_id, date, mood, score, tags, source, mood_logged_at, synced_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'WEB', $7, $7, $7, $7)`,
        [
          cuid(),
          userId,
          formatDate(date),
          mood,
          rawScore,
          JSON.stringify(tags),
          loggedAt,
        ],
      );
    }

    // ── Vorsorge reminders (preventive care) ──
    // User-created (origin VORSORGE) checklist reminders with no auto-resolve
    // measurement target. Both anchored to fire comfortably in the future so
    // the Vorsorge surface shows sensible upcoming items, not overdue ones.
    console.log("Creating Vorsorge reminders...");
    const dentalNextDue = daysAgo(-45); // ~6 weeks out
    await client.query(
      `INSERT INTO measurement_reminders (id, user_id, label, interval_days, anchor_date, origin, notify_hour, location, next_due_at, created_at, updated_at)
       VALUES ($1, $2, 'Dental check-up', 365, $3, 'VORSORGE', 9, 'Dentist', $4, NOW(), NOW())`,
      [cuid(), userId, daysAgo(320), dentalNextDue],
    );
    const physicalNextDue = daysAgo(-90); // ~3 months out
    await client.query(
      `INSERT INTO measurement_reminders (id, user_id, label, interval_days, anchor_date, origin, notify_hour, location, next_due_at, created_at, updated_at)
       VALUES ($1, $2, 'Annual physical', 365, $3, 'VORSORGE', 9, 'Family doctor', $4, NOW(), NOW())`,
      [cuid(), userId, daysAgo(275), physicalNextDue],
    );

    // ── Lab panels (biomarkers across two dates) ──
    // Two grouped panels so the labs list / detail / sort / delete all have
    // content: a recent annual blood panel (~10 days ago) and an older one
    // (~7 months ago) so the per-analyte trend has at least two points, plus a
    // couple of qualitative rows ("negativ" / "nicht nachweisbar") on the
    // recent panel. Exactly one of value / value_text is set per row per the
    // schema's quantitative-vs-qualitative invariant. Numeric analytes sit
    // comfortably inside their reference range; the older panel runs slightly
    // higher so the improvement reads as real, earned movement.
    console.log("Creating lab panels...");
    type QuantLab = {
      analyte: string;
      value: number;
      unit: string;
      low: number;
      high: number;
    };
    type QualLab = { analyte: string; valueText: string; unit: string };

    const recentPanelAt = daysAgo(10);
    const recentQuant: QuantLab[] = [
      {
        analyte: "Total Cholesterol",
        value: 178,
        unit: "mg/dL",
        low: 0,
        high: 200,
      },
      { analyte: "LDL", value: 98, unit: "mg/dL", low: 0, high: 130 },
      { analyte: "HDL", value: 58, unit: "mg/dL", low: 40, high: 100 },
      { analyte: "Triglycerides", value: 92, unit: "mg/dL", low: 0, high: 150 },
      { analyte: "HbA1c", value: 5.2, unit: "%", low: 4.0, high: 5.6 },
      {
        analyte: "Fasting Glucose",
        value: 89,
        unit: "mg/dL",
        low: 70,
        high: 99,
      },
      { analyte: "Vitamin D", value: 42, unit: "ng/mL", low: 30, high: 100 },
      { analyte: "TSH", value: 1.8, unit: "mIU/L", low: 0.4, high: 4.0 },
      { analyte: "Ferritin", value: 120, unit: "ng/mL", low: 30, high: 400 },
      { analyte: "CRP", value: 0.8, unit: "mg/L", low: 0, high: 3.0 },
      { analyte: "Creatinine", value: 0.9, unit: "mg/dL", low: 0.7, high: 1.3 },
    ];
    const recentQual: QualLab[] = [
      { analyte: "Urine Glucose", valueText: "negativ", unit: "" },
      {
        analyte: "Hepatitis B Surface Antigen",
        valueText: "negativ",
        unit: "",
      },
      { analyte: "Urine Protein", valueText: "nicht nachweisbar", unit: "" },
    ];

    // An older draw of the same numeric markers, mostly a touch higher, so the
    // per-analyte history renders a trend rather than a single point.
    const olderPanelAt = daysAgo(210);
    const olderQuant: QuantLab[] = [
      {
        analyte: "Total Cholesterol",
        value: 196,
        unit: "mg/dL",
        low: 0,
        high: 200,
      },
      { analyte: "LDL", value: 119, unit: "mg/dL", low: 0, high: 130 },
      { analyte: "HDL", value: 51, unit: "mg/dL", low: 40, high: 100 },
      {
        analyte: "Triglycerides",
        value: 128,
        unit: "mg/dL",
        low: 0,
        high: 150,
      },
      { analyte: "HbA1c", value: 5.5, unit: "%", low: 4.0, high: 5.6 },
      { analyte: "Vitamin D", value: 31, unit: "ng/mL", low: 30, high: 100 },
      { analyte: "TSH", value: 2.2, unit: "mIU/L", low: 0.4, high: 4.0 },
      { analyte: "Ferritin", value: 88, unit: "ng/mL", low: 30, high: 400 },
    ];

    const insertQuant = async (panel: string, lab: QuantLab, takenAt: Date) => {
      await client.query(
        `INSERT INTO lab_results (id, user_id, panel, analyte, value, value_text, unit, reference_low, reference_high, taken_at, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, 'MANUAL', NOW(), NOW())`,
        [
          cuid(),
          userId,
          panel,
          lab.analyte,
          lab.value,
          lab.unit,
          lab.low,
          lab.high,
          takenAt,
        ],
      );
    };
    const insertQual = async (panel: string, lab: QualLab, takenAt: Date) => {
      await client.query(
        `INSERT INTO lab_results (id, user_id, panel, analyte, value, value_text, unit, reference_low, reference_high, taken_at, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, NULL, NULL, $7, 'MANUAL', NOW(), NOW())`,
        [cuid(), userId, panel, lab.analyte, lab.valueText, lab.unit, takenAt],
      );
    };

    for (const lab of recentQuant) {
      await insertQuant("Annual blood panel", lab, recentPanelAt);
    }
    for (const lab of recentQual) {
      await insertQual("Annual blood panel", lab, recentPanelAt);
    }
    for (const lab of olderQuant) {
      await insertQuant("Blood panel (last year)", lab, olderPanelAt);
    }
    const labResults = [...recentQuant, ...recentQual, ...olderQuant];

    // ── Illness / condition journal ───────────
    // Two episodes so the journal + per-condition timeline both render with
    // signal: (1) a short, fully-resolved cold ~7 weeks ago with a day-by-day
    // symptom curve, and (2) a recurring condition (seasonal allergic
    // rhinitis) with a spring FLARE that hangs off it. Each episode gets
    // IllnessDayLog rows (functional impact + optional fever + an encrypted
    // note) and per-day symptom links from the seeded catalogue, so the
    // retrospective curve + symptom chips have content. Day-log + episode
    // notes are AES-256-GCM Bytes (the `*Encrypted` convention), written with
    // the same codec the app uses — never plaintext.
    console.log("Creating illness / condition journal...");
    // The pollen flare starts about 24 weeks back, in the spring of the
    // year the seed runs in, and every day of it is placed from this anchor.
    const FLARE_ONSET_DAYS_AGO = 170;

    // Resolve a catalogue symptom id by its stable machine key.
    const illnessSymptomId = async (key: string): Promise<string> => {
      const { rows } = await client.query(
        `SELECT id FROM illness_symptoms WHERE key = $1`,
        [key],
      );
      return rows[0].id as string;
    };
    const encBytes = (text: string) => Buffer.from(encryptToBytes(text));

    // Insert one IllnessDayLog with its symptom links.
    const insertIllnessDay = async (params: {
      episodeId: string;
      date: Date;
      functionalImpact: number;
      feverC: number | null;
      note: string;
      symptoms: Array<{ key: string; severity: number }>;
    }) => {
      const dayLogId = cuid();
      await client.query(
        `INSERT INTO illness_day_logs (id, user_id, episode_id, date, functional_impact, fever_c, note_encrypted, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
        [
          dayLogId,
          userId,
          params.episodeId,
          formatDate(params.date),
          params.functionalImpact,
          params.feverC,
          encBytes(params.note),
        ],
      );
      for (const s of params.symptoms) {
        await client.query(
          `INSERT INTO illness_symptom_links (day_log_id, symptom_id, severity, created_at)
           VALUES ($1, $2, $3, NOW())`,
          [dayLogId, await illnessSymptomId(s.key), s.severity],
        );
      }
    };

    // (1) Resolved acute cold, day 49 → day 43.
    const coldId = cuid();
    await client.query(
      `INSERT INTO illness_episodes (id, user_id, label, type, lifecycle, onset_at, resolved_at, note_encrypted, created_at, updated_at)
       VALUES ($1, $2, 'Common cold', 'INFECTION', 'ACUTE', $3, $4, $5, NOW(), NOW())`,
      [
        coldId,
        userId,
        daysAgo(49),
        daysAgo(43),
        encBytes("Picked it up after a long-haul flight. Rested it off."),
      ],
    );
    // A six-day curve: worst on days 2–3, easing toward recovery.
    const coldDays: Array<{
      offset: number;
      impact: number;
      fever: number | null;
      note: string;
      symptoms: Array<{ key: string; severity: number }>;
    }> = [
      {
        offset: 49,
        impact: 1,
        fever: null,
        note: "Scratchy throat starting in the evening.",
        symptoms: [
          { key: "sore_throat", severity: 2 },
          { key: "fatigue", severity: 1 },
        ],
      },
      {
        offset: 48,
        impact: 2,
        fever: 37.8,
        note: "Heavy head, runny nose all day.",
        symptoms: [
          { key: "runny_nose", severity: 3 },
          { key: "headache", severity: 2 },
          { key: "fatigue", severity: 2 },
        ],
      },
      {
        offset: 47,
        impact: 2,
        fever: 38.1,
        note: "Worst day — stayed in bed, low fever.",
        symptoms: [
          { key: "stuffy_nose", severity: 3 },
          { key: "body_aches", severity: 2 },
          { key: "cough", severity: 2 },
          { key: "fatigue", severity: 3 },
        ],
      },
      {
        offset: 46,
        impact: 1,
        fever: 37.4,
        note: "Fever broke overnight, congestion lingering.",
        symptoms: [
          { key: "stuffy_nose", severity: 2 },
          { key: "cough", severity: 2 },
        ],
      },
      {
        offset: 44,
        impact: 1,
        fever: null,
        note: "Mostly a dry cough left now.",
        symptoms: [{ key: "cough", severity: 1 }],
      },
      {
        offset: 43,
        impact: 0,
        fever: null,
        note: "Back to normal — calling it resolved.",
        symptoms: [],
      },
    ];
    for (const d of coldDays) {
      await insertIllnessDay({
        episodeId: coldId,
        date: daysAgo(d.offset),
        functionalImpact: d.impact,
        feverC: d.fever,
        note: d.note,
        symptoms: d.symptoms,
      });
    }

    // (2) A recurring condition with a flare hanging off it, both closed.
    // Any episode left open puts the account in Rest Mode (an ongoing chronic
    // condition deliberately included), and an open one dated 400 days back
    // greeted every demo visitor with "Rest mode, day 401" and a score marked
    // as not penalised. The season and its flare therefore sit in the spring
    // and are resolved; the illness pages still show the whole history.
    const allergyId = cuid();
    await client.query(
      `INSERT INTO illness_episodes (id, user_id, label, type, lifecycle, onset_at, resolved_at, note_encrypted, created_at, updated_at)
       VALUES ($1, $2, 'Seasonal allergic rhinitis', 'ALLERGY', 'RECURRING', $3, $4, $5, NOW(), NOW())`,
      [
        allergyId,
        userId,
        daysAgo(400),
        daysAgo(FLARE_ONSET_DAYS_AGO - 14),
        encBytes("Tree pollen each spring. Antihistamine helps."),
      ],
    );
    // The flare: a bout at the height of the pollen season, referencing the
    // parent, resolved a week after it started.
    const flareId = cuid();
    await client.query(
      `INSERT INTO illness_episodes (id, user_id, label, type, lifecycle, onset_at, resolved_at, parent_condition_id, note_encrypted, created_at, updated_at)
       VALUES ($1, $2, 'Pollen flare', 'ALLERGY', 'FLARE', $3, $4, $5, $6, NOW(), NOW())`,
      [
        flareId,
        userId,
        daysAgo(FLARE_ONSET_DAYS_AGO),
        daysAgo(FLARE_ONSET_DAYS_AGO - 7),
        allergyId,
        encBytes("High pollen count this week — symptoms back."),
      ],
    );
    const flareDays: Array<{
      offset: number;
      impact: number;
      note: string;
      symptoms: Array<{ key: string; severity: number }>;
    }> = [
      {
        offset: FLARE_ONSET_DAYS_AGO,
        impact: 1,
        note: "Itchy eyes and sneezing started today.",
        symptoms: [
          { key: "sneezing", severity: 2 },
          { key: "runny_nose", severity: 2 },
        ],
      },
      {
        offset: FLARE_ONSET_DAYS_AGO - 1,
        impact: 1,
        note: "Pollen high again — runny nose all morning.",
        symptoms: [
          { key: "runny_nose", severity: 3 },
          { key: "sneezing", severity: 2 },
        ],
      },
      {
        offset: FLARE_ONSET_DAYS_AGO - 3,
        impact: 1,
        note: "Antihistamine taking the edge off.",
        symptoms: [
          { key: "stuffy_nose", severity: 2 },
          { key: "fatigue", severity: 1 },
        ],
      },
      {
        offset: FLARE_ONSET_DAYS_AGO - 6,
        impact: 1,
        note: "Still sniffly but manageable.",
        symptoms: [{ key: "runny_nose", severity: 1 }],
      },
    ];
    for (const d of flareDays) {
      await insertIllnessDay({
        episodeId: flareId,
        date: daysAgo(d.offset),
        functionalImpact: d.impact,
        feverC: null,
        note: d.note,
        symptoms: d.symptoms,
      });
    }

    // ── Cycle tracking ────────────────────────
    // The cycle module resolves through isCycleEnabled(gender, CycleProfile):
    // a NULL flag derives from gender, so this account explicitly opts in
    // (cycle_tracking_enabled = true) — the same posture the e2e seed takes —
    // so the cycle vertical renders. Seed ~5 observed cycles of realistic
    // length with a full symptothermal day-log: biphasic basal body
    // temperature (lower follicular, a sustained ~0.3 °C luteal shift after
    // ovulation), period flow on the bleeding days, fertile-window mucus + a
    // positive OPK around ovulation, and per-day symptoms. Each BBT also lands
    // as a BODY_TEMPERATURE Measurement (the schema's documented dual-write so
    // the temperature charts elsewhere have the series). A cached
    // CyclePrediction forward-mints the next period + fertile window so the
    // prediction surface has signal. All date strings are anchored to the
    // user's Europe/Berlin timezone.
    console.log("Creating cycle tracking...");
    const CYCLE_TZ = "Europe/Berlin";

    await client.query(
      `INSERT INTO cycle_profiles (id, user_id, goal, cycle_tracking_enabled, typical_cycle_length, typical_period_length, luteal_phase_length, secondary_symptom, prediction_enabled, created_at, updated_at)
       VALUES ($1, $2, 'TRYING_TO_CONCEIVE', true, 29, 5, 14, 'MUCUS', true, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET cycle_tracking_enabled = true, updated_at = NOW()`,
      [cuid(), userId],
    );

    // Resolve a cycle-symptom catalogue id by its stable machine key.
    const cycleSymptomId = async (key: string): Promise<string> => {
      const { rows } = await client.query(
        `SELECT id FROM cycle_symptoms WHERE key = $1`,
        [key],
      );
      return rows[0].id as string;
    };

    // Build cycles backwards from the most recent period start. Lengths jitter
    // a little around the 29-day typical so the variability-aware predictor has
    // something to chew on. The most recent cycle is left open-ended (no
    // endDate) — its next period is what the prediction forecasts.
    const cycleLengths = [29, 28, 30, 29, 27]; // most-recent first
    const periodLen = 5;
    // Most recent period started 8 days ago (so today sits early-follicular,
    // a few days after this cycle's bleed) — keeps the wheel mid-cycle.
    let cursor = 8;
    const cycleStartsAgo: number[] = [];
    for (const len of cycleLengths) {
      cycleStartsAgo.push(cursor);
      cursor += len;
    }

    // One Berlin YYYY-MM-DD per day offset.
    const berlinDateString = (offset: number): string =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: CYCLE_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(daysAgo(offset));

    for (let c = 0; c < cycleStartsAgo.length; c++) {
      const startAgo = cycleStartsAgo[c];
      const length = cycleLengths[c];
      const isMostRecent = c === 0;
      // endDate / length only known once the next cycle anchors it.
      const endAgo = isMostRecent ? null : cycleStartsAgo[c - 1] + 1;
      const ovulationAgo = startAgo - (length - 14); // luteal = 14d
      const cycleId = cuid();
      await client.query(
        `INSERT INTO menstrual_cycles (id, user_id, start_date, end_date, period_end_date, length_days, ovulation_date, ovulation_confirmed, is_predicted, tz, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, false, $8, NOW(), NOW())`,
        [
          cycleId,
          userId,
          berlinDateString(startAgo),
          endAgo === null ? null : berlinDateString(endAgo),
          berlinDateString(startAgo - (periodLen - 1)),
          isMostRecent ? null : length,
          berlinDateString(ovulationAgo),
          CYCLE_TZ,
        ],
      );

      // Day-by-day log across the cycle span (start day back to the day before
      // the next period). For the most recent open cycle, only log up to today.
      const lastDayAgo = isMostRecent ? 0 : cycleStartsAgo[c - 1] + 1;
      for (let dayAgo = startAgo; dayAgo >= lastDayAgo; dayAgo--) {
        const cycleDay = startAgo - dayAgo + 1; // 1-based day in cycle
        const daysFromOvulation = ovulationAgo - dayAgo; // <0 pre, 0 = ovu

        // Biphasic BBT: ~36.40 °C follicular, rising to ~36.70 °C in the
        // luteal phase from the day after ovulation, with small daily noise.
        const luteal = cycleDay > length - 14;
        const bbt =
          Math.round(
            ((luteal ? 36.7 : 36.4) + (Math.random() - 0.5) * 0.12) * 100,
          ) / 100;

        // Flow on the first `periodLen` days, tapering.
        let flow: string | null = null;
        if (cycleDay <= periodLen) {
          flow =
            cycleDay <= 2 ? "MEDIUM" : cycleDay <= 4 ? "LIGHT" : "SPOTTING";
        }

        // Fertile-window mucus + OPK around ovulation.
        let mucus: string | null = null;
        let opk: string | null = null;
        if (daysFromOvulation >= -4 && daysFromOvulation <= 1) {
          mucus =
            daysFromOvulation >= -1 && daysFromOvulation <= 0
              ? "EGG_WHITE"
              : daysFromOvulation === -2
                ? "WATERY"
                : "CREAMY";
          opk = daysFromOvulation === -1 ? "POSITIVE_LH_SURGE" : "NEGATIVE";
        } else if (cycleDay > periodLen) {
          mucus = luteal ? "STICKY" : "DRY";
        }

        const dayLogId = cuid();
        await client.query(
          `INSERT INTO cycle_day_logs (id, user_id, date, cycle_id, flow, basal_body_temp_c, ovulation_test, cervical_mucus, source, tz, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'MANUAL', $9, NOW(), NOW())
           ON CONFLICT (user_id, date) DO NOTHING`,
          [
            dayLogId,
            userId,
            berlinDateString(dayAgo),
            cycleId,
            flow,
            bbt,
            opk,
            mucus,
            CYCLE_TZ,
          ],
        );

        // BBT also as a BODY_TEMPERATURE Measurement (schema dual-write).
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'BODY_TEMPERATURE', $3, 'celsius', 'MANUAL', $4, $4, $4)`,
          [cuid(), userId, bbt, daysAgoAt(dayAgo, 6, 30)],
        );

        // Per-day symptoms: cramps + back pain during the period, mood swings
        // + cravings + breast tenderness in the late-luteal PMS window.
        const symptoms: Array<{ key: string; severity: number }> = [];
        if (cycleDay <= 3) {
          symptoms.push({ key: "cramps", severity: cycleDay <= 2 ? 3 : 2 });
          symptoms.push({ key: "back_pain", severity: 2 });
          symptoms.push({ key: "fatigue", severity: 2 });
        }
        if (cycleDay > length - 4 && cycleDay <= length) {
          symptoms.push({ key: "mood_swings", severity: 2 });
          symptoms.push({ key: "food_cravings", severity: 2 });
          symptoms.push({ key: "breast_tenderness", severity: 2 });
        }
        for (const s of symptoms) {
          await client.query(
            `INSERT INTO cycle_symptom_links (day_log_id, symptom_id, severity, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (day_log_id, symptom_id) DO NOTHING`,
            [dayLogId, await cycleSymptomId(s.key), s.severity],
          );
        }
      }
    }

    // Cached forward prediction (the stale-while-revalidate cache the read
    // surface serves). Next period ~21 days out (most recent cycle started 8
    // days ago, typical 29), with a ±2 day band, a fertile window ~12 days
    // before that, and the matching ovulation estimate.
    const nextStartAgo = cycleStartsAgo[0] - 29;
    await client.query(
      `INSERT INTO cycle_predictions (id, user_id, method, next_period_start, next_period_start_low, next_period_start_high, fertile_window_start, fertile_window_end, predicted_ovulation, confidence, cycles_observed, generated_at, created_at, updated_at)
       VALUES ($1, $2, 'SYMPTOTHERMAL', $3, $4, $5, $6, $7, $8, 0.82, $9, NOW(), NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         method = EXCLUDED.method,
         next_period_start = EXCLUDED.next_period_start,
         next_period_start_low = EXCLUDED.next_period_start_low,
         next_period_start_high = EXCLUDED.next_period_start_high,
         fertile_window_start = EXCLUDED.fertile_window_start,
         fertile_window_end = EXCLUDED.fertile_window_end,
         predicted_ovulation = EXCLUDED.predicted_ovulation,
         confidence = EXCLUDED.confidence,
         cycles_observed = EXCLUDED.cycles_observed,
         generated_at = NOW(),
         updated_at = NOW()`,
      [
        cuid(),
        userId,
        berlinDateString(nextStartAgo),
        berlinDateString(nextStartAgo + 2),
        berlinDateString(nextStartAgo - 2),
        berlinDateString(nextStartAgo + 17),
        berlinDateString(nextStartAgo + 12),
        berlinDateString(nextStartAgo + 14),
        cycleLengths.length,
      ],
    );

    // ── Visits, a procedure and its documents ──
    // Two practitioners, a past knee arthroscopy with its two letters linked,
    // the follow-up visit that came after it, and a check-up booked for
    // tomorrow morning. The booked visit is what the start page's Today
    // overview and worth-a-look rail read; the procedure with linked files is
    // what gives the documents page its procedure filter. Documents are real
    // (tiny) PDFs, encrypted with the binary codec the upload path writes.
    console.log("Creating visits, a procedure and its documents...");
    const familyPracticeId = cuid();
    const orthopaedicsId = cuid();
    for (const [id, name, specialty] of [
      [familyPracticeId, "Family practice", "General practice"],
      [orthopaedicsId, "Orthopaedic clinic", "Orthopaedics"],
    ]) {
      await client.query(
        `INSERT INTO practitioners (id, user_id, name, specialty, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [id, userId, name, specialty],
      );
    }
    const insertEncounter = async (params: {
      occurredAt: Date;
      status: "DONE" | "PLANNED";
      kind: "ROUTINE" | "PROCEDURE" | "PREVENTIVE" | "SPECIALIST" | "ACUTE";
      practitionerId: string;
      reason: string;
      outcome?: string;
      bodySite?: string;
      laterality?: "LEFT" | "RIGHT";
    }): Promise<string> => {
      const id = cuid();
      await client.query(
        `INSERT INTO encounters (id, user_id, occurred_at, status, kind, practitioner_id, reason_encrypted, outcome_encrypted, body_site_encrypted, laterality, created_at, updated_at)
         VALUES ($1, $2, $3, $4::encounter_status, $5::encounter_kind, $6, $7, $8, $9, $10::laterality, NOW(), NOW())`,
        [
          id,
          userId,
          params.occurredAt,
          params.status,
          params.kind,
          params.practitionerId,
          encBytes(params.reason),
          params.outcome ? encBytes(params.outcome) : null,
          params.bodySite ? encBytes(params.bodySite) : null,
          params.laterality ?? null,
        ],
      );
      return id;
    };
    const procedureAt = daysAgoAt(150, 8, 30);
    const procedureId = await insertEncounter({
      occurredAt: procedureAt,
      status: "DONE",
      kind: "PROCEDURE",
      practitionerId: orthopaedicsId,
      reason: "Arthroscopy for a torn meniscus after a running injury.",
      outcome:
        "Partial meniscectomy, day surgery. Physiotherapy for six weeks, " +
        "back to easy running after that.",
      bodySite: "knee",
      laterality: "LEFT",
    });
    await insertEncounter({
      occurredAt: daysAgoAt(136, 10, 15),
      status: "DONE",
      kind: "ROUTINE",
      practitionerId: orthopaedicsId,
      reason: "Follow-up two weeks after the arthroscopy.",
      outcome: "Healing well, full range of motion. Physiotherapy continues.",
    });
    await insertEncounter({
      occurredAt: daysAgoAt(-1, 9, 30),
      status: "PLANNED",
      kind: "ROUTINE",
      practitionerId: familyPracticeId,
      reason: "Annual check-up with a blood panel.",
    });
    const procedureDocs: Array<{
      kind: "DOCTOR_REPORT" | "DISCHARGE_LETTER";
      title: string;
      filename: string;
      date: Date;
      lines: string[];
    }> = [
      {
        kind: "DOCTOR_REPORT",
        title: "Operative report, knee arthroscopy",
        filename: "operative-report-knee-arthroscopy.pdf",
        date: procedureAt,
        lines: [
          "Operative report",
          "Procedure: arthroscopic partial meniscectomy, left knee",
          "Anaesthesia: general, day surgery",
          "Findings: radial tear of the medial meniscus, cartilage intact",
          "Course: uneventful",
        ],
      },
      {
        kind: "DISCHARGE_LETTER",
        title: "Discharge letter, day surgery",
        filename: "discharge-letter-day-surgery.pdf",
        date: procedureAt,
        lines: [
          "Discharge letter",
          "Discharged the same afternoon in good condition",
          "Weight-bearing as tolerated, crutches for three days",
          "Physiotherapy: twice a week for six weeks",
          "Follow-up in the clinic after two weeks",
        ],
      },
    ];
    for (const doc of procedureDocs) {
      const pdf = simplePdf(doc.lines);
      const docId = cuid();
      await client.query(
        `INSERT INTO inbound_documents (id, user_id, kind, title, filename, mime_type, byte_size, content_encrypted, content_sha256, content_codec, status, document_date, created_at, updated_at)
         VALUES ($1, $2, $3::inbound_document_kind, $4, $5, 'application/pdf', $6, $7, $8, 'binary2', 'STORED', $9, $9, $9)`,
        [
          docId,
          userId,
          doc.kind,
          doc.title,
          doc.filename,
          pdf.byteLength,
          Buffer.from(encryptBytes(pdf)),
          createHash("sha256").update(pdf).digest("hex"),
          doc.date,
        ],
      );
      await client.query(
        `INSERT INTO encounter_document_links (id, encounter_id, document_id, user_id, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [cuid(), procedureId, docId, userId],
      );
    }

    // ── Achievements ─────────────────────────
    // ── Multi-year history ────────────────────
    // The 90-day window above is what the dashboard reads; the timeline and
    // the day view read years. This section writes the record before that
    // window, about four and a half years back, with the density a real one
    // has: blood pressure in bursts with a quarter of silence after the
    // daughter's birth, weight weekly, a phone's step count all along, and a
    // watch's resting heart rate, HRV and sleep from the third year on. Around
    // it: the blood-pressure work-up that started ramipril, its dose change
    // and sick-day pause, illnesses with start and end, flu shots, check-ups
    // with their blood panels, life events at day, month and year precision,
    // the home location with a summer holiday, and the stored weather, air
    // quality and pollen for every day of the record. Every value is invented.
    console.log("Creating multi-year history...");
    const today = berlinDayKey();
    const dayKeyAgo = (n: number) => berlinDayKey(daysAgoAt(n, 12));

    // Measurements before the 90-day window.
    const historyRows: unknown[][] = [];
    const addMeasurement = (
      type: string,
      value: number,
      unit: string,
      source: string,
      at: Date,
    ) => {
      historyRows.push([cuid(), userId, type, value, unit, source, at, at, at]);
    };
    // Blood pressure: a quarter without a reading after the birth (the line
    // breaks into a dashed bridge there) and one early quarter with only two
    // readings (drawn hollow).
    const silentBpQuarter = quarterOf(dayKeyAgo(DAUGHTER_BORN_DAYS_AGO - 45));
    const thinBpQuarter = quarterOf(dayKeyAgo(1380));
    const thinWeightQuarter = silentBpQuarter;
    const quarterCounts = new Map<string, number>();
    const sysKnots: Array<[number, number]> = [
      [HISTORY_DAYS, 134],
      [1160, 143],
      [RAMIPRIL_START_DAYS_AGO, 142],
      [1000, 136],
      [RAMIPRIL_DOSE_UP_DAYS_AGO, 135],
      [600, 130],
      [91, 128],
    ];
    const diaKnots: Array<[number, number]> = [
      [HISTORY_DAYS, 86],
      [1160, 92],
      [RAMIPRIL_START_DAYS_AGO, 91],
      [1000, 87],
      [RAMIPRIL_DOSE_UP_DAYS_AGO, 86],
      [600, 83],
      [91, 82],
    ];
    const weightKnots: Array<[number, number]> = [
      [HISTORY_DAYS, 83.4],
      [1180, 85.2],
      [DAUGHTER_BORN_DAYS_AGO, 88.6],
      [420, 87.9],
      [91, 86.5],
    ];
    const restingKnots: Array<[number, number]> = [
      [WATCH_FROM_DAYS_AGO, 63],
      [DAUGHTER_BORN_DAYS_AGO, 65],
      [500, 63],
      [91, 64],
    ];
    const hrvKnots: Array<[number, number]> = [
      [WATCH_FROM_DAYS_AGO, 46],
      [DAUGHTER_BORN_DAYS_AGO, 39],
      [480, 45],
      [91, 48],
    ];
    const sleepKnots: Array<[number, number]> = [
      [WATCH_FROM_DAYS_AGO, 445],
      [DAUGHTER_BORN_DAYS_AGO + 5, 440],
      [DAUGHTER_BORN_DAYS_AGO - 10, 365],
      [480, 410],
      [91, 420],
    ];
    const stepKnots: Array<[number, number]> = [
      [HISTORY_DAYS, 6300],
      [DAUGHTER_BORN_DAYS_AGO, 5600],
      [560, 7400],
      [91, 6500],
    ];
    // The watch is off the wrist for a fortnight one summer (a broken strap).
    const watchOff = { from: 300, to: 287 };

    for (let n = HISTORY_DAYS; n > days; n--) {
      const at = daysAgo(n);
      const key = dayKeyAgo(n);
      const quarter = quarterOf(key);
      const paused = n <= RAMIPRIL_PAUSE.from && n >= RAMIPRIL_PAUSE.to;

      // Blood pressure, in bursts: daily during the work-up, a few times a
      // week once treatment settled, now and then before it all started.
      const bpChance =
        n > 1165
          ? 0.12
          : n > 1090
            ? 0.9
            : n > RAMIPRIL_DOSE_UP_DAYS_AGO - 30 &&
                n < RAMIPRIL_DOSE_UP_DAYS_AGO + 20
              ? 0.7
              : paused || (n < RAMIPRIL_PAUSE.to && n > RAMIPRIL_PAUSE.to - 14)
                ? 0.9
                : 0.3;
      const bpTaken = quarterCounts.get(`bp:${quarter}`) ?? 0;
      const bpAllowed =
        quarter === silentBpQuarter
          ? false
          : quarter === thinBpQuarter
            ? bpTaken < 2
            : true;
      if (bpAllowed && Math.random() < bpChance) {
        quarterCounts.set(`bp:${quarter}`, bpTaken + 1);
        const bump = paused ? 7 : 0;
        const sys = Math.round(knotValue(sysKnots, n) + bump + jitter(6));
        const dia = Math.round(knotValue(diaKnots, n) + bump / 2 + jitter(4));
        addMeasurement("BLOOD_PRESSURE_SYS", sys, "mmHg", "MANUAL", at);
        addMeasurement("BLOOD_PRESSURE_DIA", dia, "mmHg", "MANUAL", at);
        addMeasurement(
          "PULSE",
          Math.round(72 + jitter(6)),
          "bpm",
          "MANUAL",
          at,
        );
      }

      // Weight, once a week on the bathroom scale (thin after the birth).
      if (n % 7 === 3) {
        const wTaken = quarterCounts.get(`w:${quarter}`) ?? 0;
        if (quarter !== thinWeightQuarter || wTaken < 2) {
          quarterCounts.set(`w:${quarter}`, wTaken + 1);
          addMeasurement(
            "WEIGHT",
            Math.round((knotValue(weightKnots, n) + jitter(0.6)) * 10) / 10,
            "kg",
            "WITHINGS",
            at,
          );
        }
      }

      // Steps from the phone, every day of the record.
      addMeasurement(
        "ACTIVITY_STEPS",
        Math.max(1200, Math.round(knotValue(stepKnots, n) + jitter(2200))),
        "steps",
        "APPLE_HEALTH",
        at,
      );

      // The watch: resting heart rate, HRV and sleep, daily from year three.
      const wearing =
        n <= WATCH_FROM_DAYS_AGO &&
        !(n <= watchOff.from && n >= watchOff.to) &&
        Math.random() > 0.04;
      if (wearing) {
        addMeasurement(
          "RESTING_HEART_RATE",
          Math.round(knotValue(restingKnots, n) + jitter(3)),
          "bpm",
          "APPLE_HEALTH",
          at,
        );
        addMeasurement(
          "HEART_RATE_VARIABILITY",
          Math.round(knotValue(hrvKnots, n) + jitter(7)),
          "ms",
          "APPLE_HEALTH",
          at,
        );
        addMeasurement(
          "SLEEP_DURATION",
          Math.round(knotValue(sleepKnots, n) + jitter(40)),
          "minutes",
          "APPLE_HEALTH",
          at,
        );
      }
    }
    await bulkInsert(
      client,
      "measurements",
      [
        "id",
        "user_id",
        "type",
        "value",
        "unit",
        "source",
        "measured_at",
        "created_at",
        "updated_at",
      ],
      historyRows,
    );

    // Ramipril and Vitamin D3 intakes before the 90-day window, at the same
    // slot anchoring as the window itself, and none while ramipril is paused.
    const intakeRows: unknown[][] = [];
    const addIntake = (medicationId: string, n: number, compliance: number) => {
      const slot = berlinHmAsUtc(8, 0, daysAgo(n));
      if (Math.random() < compliance) {
        const taken = new Date(
          slot.getTime() + (5 + Math.floor(Math.random() * 50)) * 60_000,
        );
        intakeRows.push([
          cuid(),
          userId,
          medicationId,
          slot,
          taken,
          false,
          "WEB",
          taken,
          taken,
        ]);
      } else {
        intakeRows.push([
          cuid(),
          userId,
          medicationId,
          slot,
          null,
          true,
          "WEB",
          slot,
          slot,
        ]);
      }
    };
    for (let n = RAMIPRIL_START_DAYS_AGO; n > days; n--) {
      if (n <= RAMIPRIL_PAUSE.from && n >= RAMIPRIL_PAUSE.to) continue;
      addIntake(med1Id, n, 0.97);
      if (n <= VITAMIN_D_START_DAYS_AGO) addIntake(med2Id, n, 0.94);
    }
    await bulkInsert(
      client,
      "medication_intake_events",
      [
        "id",
        "user_id",
        "medication_id",
        "scheduled_for",
        "taken_at",
        "skipped",
        "source",
        "created_at",
        "updated_at",
      ],
      intakeRows,
    );

    // The ramipril dose history and its sick-day pause.
    for (const [n, value] of [
      [RAMIPRIL_START_DAYS_AGO, 2.5],
      [RAMIPRIL_DOSE_UP_DAYS_AGO, 5],
    ] as const) {
      await client.query(
        `INSERT INTO medication_dose_changes (id, medication_id, effective_from, dose_value, dose_unit, created_at)
         VALUES ($1, $2, $3, $4, 'mg', $3)`,
        [cuid(), med1Id, daysAgoAt(n, 8), value],
      );
    }
    await client.query(
      `INSERT INTO medication_pause_eras (id, medication_id, user_id, paused_at, resumed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        cuid(),
        med1Id,
        userId,
        daysAgoAt(RAMIPRIL_PAUSE.from, 9),
        daysAgoAt(RAMIPRIL_PAUSE.to - 1, 8),
        daysAgoAt(RAMIPRIL_PAUSE.from, 9),
      ],
    );
    // A finished antibiotic course for the bronchitis.
    await client.query(
      `INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, starts_on, ends_on, created_at, updated_at)
       VALUES ($1, $2, 'Amoxicillin', '1000mg', false, false, $3, $4, $5, $5)`,
      [
        cuid(),
        userId,
        formatDate(daysAgo(797)),
        formatDate(daysAgo(791)),
        daysAgo(797),
      ],
    );

    // Illnesses before the window, each with a start and an end. The back
    // pain is the chronic one; it settled after a course of physiotherapy,
    // so nothing here is left open (an open episode puts the account in
    // Rest Mode).
    for (const ep of [
      {
        label: "Chronic lower back pain",
        type: "CHRONIC",
        lifecycle: "CHRONIC_ONGOING",
        from: 1560,
        to: 1240,
        note: "Desk job and too little movement. Physiotherapy twice a week.",
      },
      {
        label: "Influenza",
        type: "INFECTION",
        lifecycle: "ACUTE",
        from: 1370,
        to: 1361,
        note: "High fever for three days, a week in bed.",
      },
      {
        label: "Acute bronchitis",
        type: "INFECTION",
        lifecycle: "ACUTE",
        from: 800,
        to: 788,
        note: "Cough that would not settle. Antibiotics from the practice.",
      },
      {
        label: "Gastroenteritis",
        type: "INFECTION",
        lifecycle: "ACUTE",
        from: 427,
        to: 422,
        note: "Stomach bug from daycare. Ramipril paused until eating again.",
      },
    ]) {
      await client.query(
        `INSERT INTO illness_episodes (id, user_id, label, type, lifecycle, onset_at, resolved_at, note_encrypted, created_at, updated_at)
         VALUES ($1, $2, $3, $4::illness_type, $5::illness_lifecycle, $6, $7, $8, $6, $7)`,
        [
          cuid(),
          userId,
          ep.label,
          ep.type,
          ep.lifecycle,
          daysAgo(ep.from),
          daysAgo(ep.to),
          encBytes(ep.note),
        ],
      );
    }

    // A cardiology practice for the work-up, then the visits over the years.
    const cardiologyId = cuid();
    await client.query(
      `INSERT INTO practitioners (id, user_id, name, specialty, created_at, updated_at)
       VALUES ($1, $2, 'Cardiology practice', 'Cardiology', $3, $3)`,
      [cardiologyId, userId, daysAgo(1140)],
    );
    const historyVisits: Array<{
      n: number;
      kind: "ROUTINE" | "PREVENTIVE" | "SPECIALIST" | "ACUTE";
      practitionerId: string;
      reason: string;
      outcome: string;
    }> = [
      {
        n: 1560,
        kind: "PREVENTIVE",
        practitionerId: familyPracticeId,
        reason: "Health check-up with a blood panel.",
        outcome: "All fine. Back pain: referral to physiotherapy.",
      },
      {
        n: 1190,
        kind: "PREVENTIVE",
        practitionerId: familyPracticeId,
        reason: "Health check-up with a blood panel.",
        outcome:
          "Blood pressure high at the practice. Home readings for two weeks.",
      },
      {
        n: 1140,
        kind: "SPECIALIST",
        practitionerId: cardiologyId,
        reason: "Blood pressure work-up with a 24-hour measurement.",
        outcome: "Mild hypertension, heart otherwise healthy. Ramipril 2.5 mg.",
      },
      {
        n: 830,
        kind: "PREVENTIVE",
        practitionerId: familyPracticeId,
        reason: "Health check-up with a blood panel.",
        outcome: "Lipids slightly up. More exercise, recheck next year.",
      },
      {
        n: 797,
        kind: "ACUTE",
        practitionerId: familyPracticeId,
        reason: "Cough and fever for five days.",
        outcome: "Acute bronchitis. Amoxicillin for seven days.",
      },
      {
        n: RAMIPRIL_DOSE_UP_DAYS_AGO,
        kind: "ROUTINE",
        practitionerId: familyPracticeId,
        reason: "Blood pressure follow-up.",
        outcome: "Still above target, ramipril raised to 5 mg.",
      },
      {
        n: 470,
        kind: "PREVENTIVE",
        practitionerId: familyPracticeId,
        reason: "Health check-up with a blood panel.",
        outcome: "Blood pressure on target. Lipids better.",
      },
      {
        n: 426,
        kind: "ACUTE",
        practitionerId: familyPracticeId,
        reason: "Vomiting and diarrhoea since yesterday.",
        outcome:
          "Gastroenteritis. Pause ramipril until eating and drinking normally.",
      },
    ];
    for (const v of historyVisits) {
      await insertEncounter({
        occurredAt: daysAgoAt(v.n, 9, 15),
        status: "DONE",
        kind: v.kind,
        practitionerId: v.practitionerId,
        reason: v.reason,
        outcome: v.outcome,
      });
    }

    // The blood panels of those check-ups: HbA1c, lipids and haemoglobin.
    const historyPanels: Array<{ n: number; values: Record<string, number> }> =
      [
        {
          n: 1560,
          values: { hba1c: 5.3, tc: 205, ldl: 128, hdl: 49, hb: 15.1 },
        },
        {
          n: 1190,
          values: { hba1c: 5.4, tc: 214, ldl: 137, hdl: 47, hb: 14.8 },
        },
        { n: 1140, values: { tc: 216, ldl: 140, hdl: 47 } },
        {
          n: 830,
          values: { hba1c: 5.6, tc: 209, ldl: 132, hdl: 48, hb: 15.0 },
        },
        {
          n: 470,
          values: { hba1c: 5.5, tc: 199, ldl: 121, hdl: 51, hb: 14.6 },
        },
      ];
    const panelLabs: Record<string, Omit<QuantLab, "value">> = {
      hba1c: { analyte: "HbA1c", unit: "%", low: 4.0, high: 5.6 },
      tc: { analyte: "Total Cholesterol", unit: "mg/dL", low: 0, high: 200 },
      ldl: { analyte: "LDL", unit: "mg/dL", low: 0, high: 130 },
      hdl: { analyte: "HDL", unit: "mg/dL", low: 40, high: 100 },
      hb: { analyte: "Hemoglobin", unit: "g/dL", low: 13.5, high: 17.5 },
    };
    for (const panel of historyPanels) {
      for (const [key, value] of Object.entries(panel.values)) {
        await insertQuant(
          "Blood panel",
          { ...panelLabs[key], value },
          daysAgoAt(panel.n, 9, 0),
        );
      }
    }

    // Vaccinations: a flu shot every autumn and a tetanus-diphtheria-
    // pertussis booster. The newest flu shot is recent, so nothing is due.
    for (const v of [
      { n: 1440, slug: "influenza", name: "Influenza" },
      { n: 1075, slug: "influenza", name: "Influenza" },
      { n: 985, slug: "tdap", name: "Tdap" },
      { n: 710, slug: "influenza", name: "Influenza" },
      { n: 345, slug: "influenza", name: "Influenza" },
      { n: 12, slug: "influenza", name: "Influenza" },
    ]) {
      const at = daysAgoAt(v.n, 10, 30);
      await client.query(
        `INSERT INTO vaccination_records (id, user_id, occurred_at, antigen_slug, vaccine_name, site, practitioner_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'LEFT_ARM'::vaccination_site, $6, $3, $3)`,
        [cuid(), userId, at, v.slug, v.name, familyPracticeId],
      );
    }

    // Life events, at the precision a person actually remembers them.
    const monthStart = (n: number) => `${dayKeyAgo(n).slice(0, 7)}-01`;
    const lastYear = Number(today.slice(0, 4)) - 1;
    const lifeEvents: Array<{
      category: "FAMILY" | "HOME" | "WORK" | "OTHER";
      start: string;
      end: string | null;
      precision: "DAY" | "MONTH" | "YEAR";
      title: string;
      note?: string;
    }> = [
      {
        category: "HOME",
        start: monthStart(HISTORY_DAYS),
        end: null,
        precision: "MONTH",
        title: "Moved to Freiburg",
      },
      {
        category: "WORK",
        start: dayKeyAgo(1185),
        end: null,
        precision: "DAY",
        title: "Started a new job",
        note: "Longer commute, more sitting.",
      },
      {
        category: "FAMILY",
        start: dayKeyAgo(DAUGHTER_BORN_DAYS_AGO),
        end: null,
        precision: "DAY",
        title: "Our daughter was born",
      },
      {
        category: "FAMILY",
        start: monthStart(DAUGHTER_BORN_DAYS_AGO - 20),
        end: monthStart(DAUGHTER_BORN_DAYS_AGO - 80),
        precision: "MONTH",
        title: "Parental leave",
      },
      {
        category: "OTHER",
        start: `${lastYear}-01-01`,
        end: null,
        precision: "YEAR",
        title: "Started running regularly",
      },
      {
        category: "HOME",
        start: dayKeyAgo(380),
        end: null,
        precision: "DAY",
        title: "Moved into a bigger flat",
      },
      {
        category: "FAMILY",
        start: dayKeyAgo(46),
        end: null,
        precision: "DAY",
        title: "First day at daycare",
        note: "Settling-in week, short days.",
      },
    ];
    for (const e of lifeEvents) {
      await client.query(
        `INSERT INTO life_events (id, user_id, category, start_date, end_date, precision, title_encrypted, note_encrypted, created_at, updated_at)
         VALUES ($1, $2, $3::life_event_category, $4, $5, $6::life_event_precision, $7, $8, NOW(), NOW())`,
        [
          cuid(),
          userId,
          e.category,
          e.start,
          e.end,
          e.precision,
          encBytes(e.title),
          e.note ? encBytes(e.note) : null,
        ],
      );
    }

    // The timeline module is opt-in; the demo shows it. The home location
    // is sealed the way the settings route writes it (readable columns null).
    const homeSince = daysAgoAt(HISTORY_DAYS, 12);
    await client.query(
      `UPDATE users
          SET module_preferences_json = $2,
              home_lat = NULL, home_lon = NULL, home_label = NULL,
              home_location_encrypted = $3,
              home_timezone = 'Europe/Berlin',
              home_since = $4,
              environment_air_quality_enabled = true
        WHERE id = $1`,
      [
        userId,
        JSON.stringify({ timeline: true }),
        sealDemoLocation(DEMO_HOME),
        homeSince,
      ],
    );
    await client.query(
      `INSERT INTO environment_travel_locations (id, user_id, start_date, end_date, location_encrypted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [
        cuid(),
        userId,
        dayKeyAgo(HOLIDAY.from),
        dayKeyAgo(HOLIDAY.to),
        sealDemoLocation(DEMO_HOLIDAY_PLACE),
      ],
    );

    // Stored weather, air quality and pollen for every day of the record,
    // written as the nightly fetch would leave them (no feed is called).
    // Seasonal shapes for a city in the south-west: mild winters, warm
    // summers, alder and birch in spring, grass into July, mugwort and
    // ragweed from late summer well into October.
    const sealedHome = sealDemoLocation(DEMO_HOME);
    const sealedHoliday = sealDemoLocation(DEMO_HOLIDAY_PLACE);
    const envRows: unknown[][] = [];
    let cloud = 55;
    const fetchedAt = new Date();
    for (let n = HISTORY_DAYS; n >= 0; n--) {
      const key = dayKeyAgo(n);
      const away = n <= HOLIDAY.from && n >= HOLIDAY.to;
      const doy = dayOfYear(key);
      const season = Math.sin((2 * Math.PI * (doy - 110)) / 365);
      cloud = Math.min(
        100,
        Math.max(0, cloud + (60 - cloud) * 0.3 + jitter(35)),
      );
      const rainy = cloud > 72 && Math.random() < 0.7;
      const tempMean =
        Math.round(
          ((away ? 9.5 : 11) +
            (away ? 8 : 9.5) * season +
            jitter(3) -
            (rainy ? 1.5 : 0)) *
            10,
        ) / 10;
      const tempMin = Math.round((tempMean - 4 - Math.random() * 2) * 10) / 10;
      const tempMax =
        Math.round(
          (tempMean + 4.5 + Math.random() * 2.5 - (rainy ? 2 : 0)) * 10,
        ) / 10;
      const daylight = daylightHours(
        away ? DEMO_HOLIDAY_PLACE.lat : DEMO_HOME.lat,
        doy,
      );
      const sunshine = Math.max(0, daylight * (1 - cloud / 100) * 0.85);
      const precip = rainy ? Math.round((1 + Math.random() * 14) * 10) / 10 : 0;
      const weatherCode = rainy
        ? tempMean < 1
          ? 71
          : precip > 8
            ? 63
            : 61
        : cloud > 80
          ? 3
          : cloud > 35
            ? 2
            : cloud > 15
              ? 1
              : 0;
      // Air: more particles in winter (heating, inversions), more ozone in
      // summer, a little cleaner on rainy days and by the sea.
      const winter = (1 - season) / 2;
      const clean = (rainy ? 0.7 : 1) * (away ? 0.6 : 1);
      const pm25Mean =
        Math.round((5 + 9 * winter + jitter(2.5)) * clean * 10) / 10;
      const pm25Max =
        Math.round(pm25Mean * (1.5 + Math.random() * 0.6) * 10) / 10;
      const pm10Mean = Math.round((pm25Mean * 1.6 + jitter(2)) * 10) / 10;
      const no2Mean =
        Math.round((12 + 10 * winter + jitter(4)) * clean * 10) / 10;
      const o3Max8h = Math.round(
        (55 + 45 * (1 - winter) + jitter(12)) * (rainy ? 0.8 : 1),
      );
      const eaqiMax = Math.round(
        Math.max(pm25Max * 1.7, pm10Mean * 0.9, o3Max8h * 0.42, no2Mean * 0.8),
      );
      const usaqiMax = Math.round(Math.max(pm25Max * 3.1, o3Max8h * 0.45));
      const uvIndexMax =
        Math.round(
          Math.max(
            0.3,
            (1 + 6.5 * (1 - winter)) * (1 - cloud / 160) + jitter(0.4),
          ) * 10,
        ) / 10;
      // Pollen, damped on rainy days, none by the sea in late summer.
      const damp = (rainy ? 0.35 : 1) * (0.7 + Math.random() * 0.6);
      const pollen = (from: number, to: number, peak: number) =>
        Math.round(pollenSeason(doy, from, to, peak) * damp);
      envRows.push([
        cuid(),
        userId,
        key,
        null,
        null,
        null,
        away ? sealedHoliday : sealedHome,
        away ? "TRAVEL" : "HOME",
        tempMin,
        tempMax,
        tempMean,
        Math.round((tempMean - (rainy ? 2 : 0.5)) * 10) / 10,
        Math.round(sunshine * 3600),
        Math.round(daylight * 3600),
        precip,
        Math.round((1016 - (rainy ? 9 : 0) + jitter(5)) * 10) / 10,
        Math.round((2 + Math.random() * (rainy ? 8 : 4)) * 10) / 10,
        Math.round(60 + cloud * 0.25 + jitter(8)),
        Math.round(cloud),
        weatherCode,
        Math.round((tempMax + (rainy ? -1 : 1.5)) * 10) / 10,
        pm25Mean,
        pm25Max,
        pm10Mean,
        no2Mean,
        Math.round(1.2 + Math.random() * 1.5),
        Math.round(180 + 120 * winter + jitter(30)),
        o3Max8h,
        eaqiMax,
        usaqiMax,
        uvIndexMax,
        Math.round(Math.random() * (doy > 90 && doy < 250 ? 18 : 4)),
        Math.round((0.08 + Math.random() * 0.2) * 100) / 100,
        pollen(35, 85, 70),
        pollen(92, 135, away ? 20 : 190),
        pollen(128, 215, 85),
        away ? 0 : pollen(195, 255, 28),
        0,
        away ? 0 : pollen(220, 305, 45),
        "cams_europe",
        24,
        fetchedAt,
        fetchedAt,
        fetchedAt,
        fetchedAt,
      ]);
    }
    await bulkInsert(
      client,
      "environment_contexts",
      [
        "id",
        "user_id",
        "date",
        "lat",
        "lon",
        "location_label",
        "location_encrypted",
        "source",
        "temp_min",
        "temp_max",
        "temp_mean",
        "apparent_mean",
        "sunshine_sec",
        "daylight_sec",
        "precip_sum",
        "pressure_mean",
        "pressure_delta",
        "humidity_mean",
        "cloud_mean",
        "weather_code",
        "apparent_max",
        "pm25_mean",
        "pm25_max",
        "pm10_mean",
        "no2_mean",
        "so2_mean",
        "co_mean",
        "o3_max_8h",
        "eaqi_max",
        "usaqi_max",
        "uv_index_max",
        "dust_max",
        "aod_max",
        "pollen_alder_max",
        "pollen_birch_max",
        "pollen_grass_max",
        "pollen_mugwort_max",
        "pollen_olive_max",
        "pollen_ragweed_max",
        "aq_domain",
        "aq_hours",
        "aq_fetched_at",
        "fetched_at",
        "created_at",
        "updated_at",
      ],
      envRows,
      200,
    );

    console.log("Creating achievements...");

    // Every id below is a real key from the achievement registry
    // (src/lib/gamification/achievements.ts) so the badge resolves to a real
    // title/icon rather than an "unknown" placeholder. Only milestones the
    // seeded history genuinely supports are unlocked (first-entry badges,
    // logging streaks, in-range BP/pulse/BMI streaks, compliance + miss-free
    // streaks, the self-context + 7-night sleep badges). The dynamic streak
    // families use the `<prefix>-<target>` naming the generator emits.
    const achievements = [
      { id: "weight-first", daysAgo: 89 },
      { id: "bp-first", daysAgo: 89 },
      { id: "pulse-first", daysAgo: 89 },
      { id: "mood-first", daysAgo: 89 },
      { id: "self-context-complete", daysAgo: 88 },
      { id: "entry-streak-7", daysAgo: 82 },
      { id: "mood-streak-7", daysAgo: 82 },
      { id: "sleep-log-7", daysAgo: 70 },
      { id: "mood-up-7", daysAgo: 68 },
      { id: "weight-50", daysAgo: 60 },
      { id: "bp-50", daysAgo: 55 },
      { id: "entry-streak-30", daysAgo: 50 },
      { id: "mood-streak-30", daysAgo: 50 },
      { id: "miss-free-7", daysAgo: 48 },
      { id: "consistent-month", daysAgo: 45 },
      { id: "bp-green-7", daysAgo: 42 },
      { id: "pulse-green-7", daysAgo: 40 },
      { id: "bmi-green-7", daysAgo: 38 },
      { id: "compliance-80-30", daysAgo: 30 },
      { id: "miss-free-30", daysAgo: 30 },
      { id: "on-time-perfect-7", daysAgo: 28 },
      { id: "measurement-weeks-4", daysAgo: 25 },
      { id: "bp-green-30", daysAgo: 12 },
      { id: "pulse-green-30", daysAgo: 10 },
      { id: "miss-free-90", daysAgo: 2 },
    ];

    for (const ach of achievements) {
      const unlocked = daysAgo(ach.daysAgo);
      await client.query(
        `INSERT INTO user_achievements (id, user_id, achievement_id, unlocked_at, created_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [cuid(), userId, ach.id, unlocked],
      );
    }

    // ── Coach sample conversations ────────────
    // Five short, encrypted exchanges spread from today back over a few
    // weeks, so the history rail groups them by day the way a used account
    // reads, and the thread that opens first (today's) carries a full answer
    // with the steps the Coach took. Messages use the same AES-256-GCM Bytes
    // codec the app writes with (encryptToBytes → encrypt() under
    // ENCRYPTION_KEYS), so they decrypt exactly like a live conversation — no
    // faked / plaintext rows.
    console.log("Creating Coach sample conversations...");

    // The provenance uses the contract tokens (`bp`, `resting_hr`, `sleep`):
    // the client names an area only through a known token, so a token it
    // cannot name never reaches the page. The steps give the answer its
    // "Looked at N sources" header the way a live turn would; they carry no
    // counts, since a count is the server's tally and the seed does not
    // run a tool.
    const WINDOW_LABEL = {
      last7days: "last 7 days",
      last30days: "last 30 days",
      last90days: "last 90 days",
    } as const;
    const seedStep = (
      id: string,
      tool: string,
      domain: string,
      domainLabel: string,
      window: keyof typeof WINDOW_LABEL = "last30days",
    ) => ({
      id,
      tool,
      labelKey: "coach.step.readWindow",
      label: `Checking: ${domainLabel}, ${WINDOW_LABEL[window]}`,
      domain,
      window,
      status: "done",
    });
    type SeedStep = ReturnType<typeof seedStep>;
    const answer = (
      content: string,
      window: SeedStep["window"],
      steps: SeedStep[],
      tokensUsed: number,
    ) => ({
      role: "assistant",
      content,
      metricSourceJson: JSON.stringify({
        windows: [window],
        metrics: [...new Set(steps.map((step) => step.domain))],
        steps,
      }),
      tokensUsed,
      model: aiModel,
    });
    const coachConversations: Array<{
      title: string;
      startedAt: Date;
      turns: Array<{
        role: string;
        content: string;
        metricSourceJson?: string;
        tokensUsed?: number;
        model?: string;
      }>;
    }> = [
      {
        title: "Recovery this week",
        // Today, shortly before the seed ran, so it is the newest thread.
        startedAt: new Date(Date.now() - 50 * 60_000),
        turns: [
          {
            role: "user",
            content:
              "How well have I been recovering this week, and is there anything I should change?",
          },
          answer(
            "This has been a well-recovered week. You slept close to seven " +
              "and a half hours on most nights, with a steady share of deep " +
              "sleep, and your resting heart rate stayed in the high fifties, " +
              "which is where it has sat for the past month.\n\n" +
              "Heart-rate variability tells the same story: it held inside " +
              "your usual range on every day this week, and the two harder " +
              "runs did not push it down the next morning. Your step count " +
              "averaged around nine thousand a day, so the load is there " +
              "without tipping into strain.\n\n" +
              "Nothing here asks for a change. If you want one thing to keep " +
              "an eye on, it is the later bedtimes on the weekend: the two " +
              "shortest nights of the week both fell on a Saturday or Sunday.",
            "last7days",
            [
              seedStep("s1", "get_sleep", "sleep", "Sleep", "last7days"),
              seedStep(
                "s2",
                "get_metric_series",
                "resting_hr",
                "Resting HR",
                "last7days",
              ),
              seedStep("s3", "get_metric_series", "hrv", "HRV", "last7days"),
              seedStep(
                "s4",
                "get_metric_series",
                "steps",
                "Steps",
                "last7days",
              ),
              seedStep(
                "s5",
                "get_workouts",
                "workouts",
                "Workouts",
                "last7days",
              ),
            ],
            2630,
          ),
        ],
      },
      {
        title: "Resting heart rate",
        startedAt: daysAgoAt(1, 19, 40),
        turns: [
          { role: "user", content: "Is my resting heart rate improving?" },
          answer(
            "Yes, gradually. Three months ago it sat in the low sixties; over " +
              "the last few weeks it has settled in the high fifties and " +
              "stayed there. That kind of slow, steady drift usually follows " +
              "regular aerobic training, which matches the running in your log.",
            "last90days",
            [
              seedStep(
                "s1",
                "get_metric_series",
                "resting_hr",
                "Resting HR",
                "last90days",
              ),
              seedStep(
                "s2",
                "get_workouts",
                "workouts",
                "Workouts",
                "last90days",
              ),
            ],
            1520,
          ),
        ],
      },
      {
        title: "Blood pressure trend",
        startedAt: daysAgo(3),
        turns: [
          {
            role: "user",
            content: "How has my blood pressure been trending lately?",
          },
          answer(
            "Your blood pressure has been settling nicely. Over the last few " +
              "weeks the morning readings have drifted into the optimal band, and " +
              "your resting heart rate is sitting in a comfortable range too. " +
              "Keeping up the steady sleep and daily movement looks like it is " +
              "paying off — worth staying consistent with the morning measurements " +
              "so the trend stays easy to read.",
            "last30days",
            [
              seedStep("s1", "get_metric_series", "bp", "Blood pressure"),
              seedStep("s2", "get_metric_series", "resting_hr", "Resting HR"),
              seedStep("s3", "get_sleep", "sleep", "Sleep"),
            ],
            1840,
          ),
        ],
      },
      {
        title: "Back to running after the knee",
        startedAt: daysAgoAt(9, 7, 55),
        turns: [
          {
            role: "user",
            content:
              "Am I back to my old activity level since the knee surgery?",
          },
          answer(
            "Yes. Across the last three months you have run, cycled and done " +
              "strength sessions three to four times a week, and your daily " +
              "steps have climbed from around six and a half thousand to about " +
              "nine thousand. Your resting heart rate came down while the load " +
              "went up, which suggests the build-up after the arthroscopy was " +
              "well paced.",
            "last90days",
            [
              seedStep(
                "s1",
                "get_metric_series",
                "steps",
                "Steps",
                "last90days",
              ),
              seedStep(
                "s2",
                "get_workouts",
                "workouts",
                "Workouts",
                "last90days",
              ),
            ],
            1710,
          ),
        ],
      },
      {
        title: "Sleep and mood",
        startedAt: daysAgoAt(24, 21, 10),
        turns: [
          {
            role: "user",
            content: "Do my sleep and my mood move together?",
          },
          answer(
            "Somewhat. On the mornings after nights shorter than about six " +
              "and a half hours, your mood entries were a little lower on " +
              "average. It is a loose pattern across a month of data, worth " +
              "watching rather than a cause and effect.",
            "last30days",
            [
              seedStep("s1", "get_sleep", "sleep", "Sleep"),
              seedStep("s2", "get_metric_series", "mood", "Mood"),
            ],
            1390,
          ),
        ],
      },
    ];
    for (const convo of coachConversations) {
      const convoId = cuid();
      const lastAt = new Date(
        convo.startedAt.getTime() + (convo.turns.length - 1) * 60_000,
      );
      // The title is sealed the way the app writes it since v1.39.3. A
      // readable `title` is picked up by the boot backfill, whose update
      // also moves `updated_at` to the moment it ran, and every thread then
      // sorted under "Today".
      await client.query(
        `INSERT INTO coach_conversations (id, user_id, title_encrypted, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          convoId,
          userId,
          Buffer.from(encryptToBytes(convo.title)),
          convo.startedAt,
          lastAt,
        ],
      );
      for (let t = 0; t < convo.turns.length; t++) {
        const turn = convo.turns[t];
        const ts = new Date(convo.startedAt.getTime() + t * 60_000);
        const encrypted = Buffer.from(encryptToBytes(turn.content));
        await client.query(
          `INSERT INTO coach_messages (id, conversation_id, role, encrypted_content, metric_source_json, provider_type, prompt_version, tokens_used, model, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            cuid(),
            convoId,
            turn.role,
            encrypted,
            turn.metricSourceJson ?? null,
            turn.role === "assistant" ? aiProvider : null,
            turn.role === "assistant" ? "demo" : null,
            turn.tokensUsed ?? null,
            turn.model ?? null,
            ts,
          ],
        );
      }
    }

    // ── Baked AI insight texts ────────────────
    // The public demo has no live AI provider (the seeded key is a
    // placeholder ciphertext), so the Insights / daily-briefing / per-metric
    // status surfaces would otherwise render empty or a "connect a provider"
    // prompt. We bake realistic, grounded English prose straight into the
    // same cache rows a real generation would have written, so the demo shows
    // finished AI output that survives every re-seed and never calls out.
    //
    // The prose follows the real generators' voice (src/lib/ai/prompts/
    // base-system.ts): second person, warm, grounded in the seeded numbers,
    // autonomy-supporting, never diagnostic, no banned positivity openers.
    // The numbers quoted below match the seeded targets (weight ~82 kg,
    // BP settling ~118/76, resting HR ~58, BMI ~24.7, mood improving,
    // compliance ~96%+).
    console.log("Creating baked AI insight texts...");

    const todayKey = berlinDayKey();
    // A real-looking provider tag for the rows that record one (the cached
    // briefing, the narratives). The text is what renders; the tag is
    // provenance only.
    const bakedProvider = "anthropic";

    // ── Comprehensive insight + daily briefing ──
    // Stored on users.insights_cached_text (JSON). The GET read parses it and
    // returns it as-is; setting insights_cached_at = NOW() keeps it inside the
    // 24 h freshness window for the dashboard-snapshot briefing path. The shape
    // is the union of insightResultSchema (summary / findings / correlations /
    // recommendations / dataQuality / disclaimer / classification) and the
    // richer optional blocks the dashboard validates (dailyBriefing with
    // paragraph + signalsOfDay + keyFindings, trendAnnotations).
    const comprehensiveInsight = {
      insightType: "comprehensive",
      summary:
        "Your numbers have moved the right way across the board this quarter. " +
        "Blood pressure has settled into the optimal band, your weight is " +
        "down to a steady place, resting heart rate is low, and your sleep " +
        "and mood have both been climbing. The consistency in your daily " +
        "logging is doing a lot of the work here.",
      classification: "optimal",
      classificationLabel: "On track",
      findings: [
        {
          label: "Blood pressure",
          value: "~118/76 mmHg",
          assessment: "positive",
          guideline: "ESH 2023 optimal range",
        },
        {
          label: "Weight",
          value: "~82 kg (BMI ~24.7)",
          assessment: "positive",
        },
        {
          label: "Resting heart rate",
          value: "~58 bpm",
          assessment: "positive",
        },
        {
          label: "Medication adherence",
          value: "96%+ over 90 days",
          assessment: "positive",
        },
        {
          label: "Mood",
          value: "trending up to ~4.4 / 5",
          assessment: "positive",
        },
      ],
      correlations: [
        {
          factor: "Sleep duration and resting heart rate",
          effect:
            "Longer, more consistent nights line up with your lower resting " +
            "heart rate readings.",
          confidence: "mittel",
        },
      ],
      primaryRecommendation:
        "Keep the morning measurement habit going — the steadier the cadence, " +
        "the easier your trends are to read.",
      recommendations: [
        {
          text:
            "Your morning blood-pressure readings are the clearest signal " +
            "you have. Keeping them at a consistent time each day will keep " +
            "the trend easy to interpret.",
          severity: "suggestion",
          rationale: {
            dataWindow: "last30days",
            comparedTo: "your own 90-day baseline",
            deviation: "systolic down ~10 mmHg from the start of the window",
          },
        },
        {
          text:
            "Sleep has been trending toward a healthy 7.5 hours. Protecting " +
            "that window on busier evenings is worth a little planning.",
          severity: "info",
          rationale: {
            dataWindow: "last30days",
            comparedTo: "your earlier nights this quarter",
            deviation: "about 45 minutes longer on average",
          },
        },
      ],
      dataQuality: {
        coverage: "90 days of daily measurements across every core metric",
        gaps: [],
        confidence: "hoch",
      },
      disclaimer:
        "This is a reasoned observation of your own data, not medical advice " +
        "or a diagnosis. Discuss any concerns with your doctor.",
      dailyBriefing: {
        paragraph:
          "Good morning. Today's picture is a calm one: your most recent " +
          "blood pressure sits comfortably in the optimal band, resting heart " +
          "rate is low, and last night's sleep landed right around your " +
          "target. Weight is holding at its new steady place and your mood " +
          "has been on a quiet upward run all week. There is nothing here " +
          "that needs fixing — the work now is simply keeping the rhythm " +
          "you have built, logging each morning and protecting your sleep " +
          "window. Small, consistent days are exactly what these trends are " +
          "made of.",
        signalsOfDay: [
          {
            sourceMetric: "bp",
            tone: "good",
            headline:
              "Your latest blood pressure is sitting in the optimal band.",
            nudge:
              "Take tomorrow's reading at the same morning time to keep the " +
              "trend clean.",
            delta: "↓ ~10 mmHg systolic vs the start of the window",
          },
          {
            sourceMetric: "sleep",
            tone: "good",
            headline: "Last night came in close to your 7.5-hour target.",
            nudge: "Aim for the same lights-out time tonight.",
            delta: null,
          },
          {
            sourceMetric: "resting_hr",
            tone: "info",
            headline: "Resting heart rate is steady around 58 bpm.",
            nudge: "Keep the daily movement going — it shows up here.",
            delta: null,
          },
        ],
        keyFindings: [
          {
            tone: "good",
            headline: "Blood pressure has settled into the optimal range.",
            detail:
              "Your 30-day average is well inside the optimal band and lower " +
              "than where the quarter began.",
            delta: "↓ ~10 mmHg",
            sourceWindow: "30d",
            sourceMetric: "bp",
          },
          {
            tone: "good",
            headline: "Weight is holding at a healthy, steady place.",
            detail:
              "After trending down earlier in the quarter, your weight has " +
              "levelled off at a BMI of about 24.7.",
            delta: null,
            sourceWindow: "90d",
            sourceMetric: "weight",
          },
          {
            tone: "good",
            headline: "Medication adherence has stayed above 96%.",
            detail:
              "You have logged your doses on time across nearly the entire " +
              "90-day window.",
            delta: null,
            sourceWindow: "90d",
            sourceMetric: "compliance",
          },
          {
            tone: "info",
            headline: "Mood has drifted gently upward.",
            detail:
              "Your entries have climbed from the mid-threes toward the " +
              "low-fours over the quarter.",
            delta: null,
            sourceWindow: "90d",
            sourceMetric: "mood",
          },
        ],
      },
      trendAnnotations: {
        bp: "Your systolic is trending down into the optimal band — a pattern worth keeping.",
        weight:
          "Weight has levelled off after an earlier decline — a stable, healthy place to hold.",
        mood: "Mood has been on a quiet upward run across the quarter.",
        sleep:
          "Nights have lengthened toward a steady 7.5 hours over the window.",
        resting_hr:
          "Resting heart rate has eased lower as your activity has held up.",
      },
    };

    await client.query(
      `UPDATE users
         SET insights_cached_text = $2,
             insights_cached_at = NOW(),
             insights_snapshot_hash = $3,
             insights_briefing_reroll_date = $4
       WHERE id = $1`,
      [
        userId,
        JSON.stringify(comprehensiveInsight),
        // A stable fingerprint. The 24 h cache window keeps the row fresh on
        // its own; this value just has to be present + non-null so a
        // hypothetical regeneration would treat the snapshot as known. The
        // demo provider can never succeed, so the baked text always survives.
        "demo-baked-comprehensive-snapshot",
        // Mark today's briefing re-roll as already done so the once-per-day
        // re-roll path is a no-op (it would fail against the placeholder key).
        todayKey,
      ],
    );

    // ── Per-metric status cards ──
    // Each card is an insight_status_caches row keyed (user, metric, locale),
    // the note encrypted with the app's codec. The read serves a note only
    // when its date_key equals today's key, so every card is stamped with
    // today's key and reads as a current assessment. The medication card also
    // carries its (empty) per-medication list. 2-4 sentences each, grounded in
    // the seeded data, in the base-system advisor voice.
    const statusCards: Array<{ scope: string; text: string }> = [
      {
        scope: "blood-pressure",
        text:
          "Your blood pressure is averaging about 118/76 over the last few " +
          "weeks — down roughly 10 mmHg systolic from where this quarter " +
          "started, and now comfortably inside the optimal band. That is a " +
          "real, earned shift, not day-to-day noise. Keeping the morning " +
          "readings on a steady schedule will make the trend even easier to " +
          "follow.",
      },
      {
        scope: "pulse",
        text:
          "Your resting heart rate is sitting around 58 bpm this week, a few " +
          "beats below your monthly mean and among your lowest readings in " +
          "the window. That tracks with the steady daily movement you have " +
          "kept up. Nothing to change here — just keep the rhythm going.",
      },
      {
        scope: "weight",
        text:
          "Your weight has settled at about 82 kg after trending down earlier " +
          "in the quarter — a stable, healthy place rather than a continuing " +
          "decline. Holding here is exactly the right goal. Weighing in at a " +
          "consistent time keeps the reading clean.",
      },
      {
        scope: "bmi",
        text:
          "Your BMI is right around 24.7, near the top of the healthy range " +
          "and steady over the last month. With your weight holding, this is " +
          "a good place to maintain. No action needed beyond keeping your " +
          "current routine.",
      },
      {
        scope: "mood",
        text:
          "Your mood entries have drifted upward over the quarter, from the " +
          "mid-threes toward the low-fours, and the recent run has been your " +
          "most positive yet. The consistency of your logging makes that " +
          "trend trustworthy. Worth noticing what has been going well and " +
          "leaning into it.",
      },
      {
        scope: "medication-compliance",
        text:
          "Your adherence has stayed above 96% across the last 90 days, with " +
          "today's morning doses already taken and the evening one not yet " +
          "due. That is a strong, durable streak. Keeping your reminders " +
          "where they are should be enough to hold it.",
      },
      {
        scope: "general",
        text:
          "Across the board your numbers are in a good place: blood pressure " +
          "in the optimal band, weight steady, resting heart rate low, and " +
          "sleep and mood both trending up. The throughline is your " +
          "consistency — daily logging is what makes all of this readable. " +
          "Keep the cadence and the picture stays clear.",
      },
    ];

    for (const card of statusCards) {
      await client.query(
        `INSERT INTO insight_status_caches
           (id, user_id, metric, locale, text_encrypted, items_encrypted,
            snapshot_hash, date_key, generated_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'en', $4, $5, $6, $7, NOW(), NOW(), NOW())
         ON CONFLICT (user_id, metric, locale) DO UPDATE SET
           text_encrypted = EXCLUDED.text_encrypted,
           items_encrypted = EXCLUDED.items_encrypted,
           snapshot_hash = EXCLUDED.snapshot_hash,
           date_key = EXCLUDED.date_key,
           generated_at = EXCLUDED.generated_at,
           retry_at = NULL,
           negative_reason = NULL,
           updated_at = NOW()`,
        [
          cuid(),
          userId,
          card.scope,
          Buffer.from(encryptToBytes(card.text)),
          card.scope === "medication-compliance"
            ? Buffer.from(encryptToBytes("[]"))
            : null,
          `demo-baked-${card.scope}`,
          todayKey,
        ],
      );
    }

    // ── Period narratives (week + month) ──
    // insight_narratives rows, one per (period, locale). The read path is pure
    // stale-while-revalidate: it returns whatever was last written regardless
    // of age, decrypting encrypted_content with the app's AES-256-GCM codec
    // (encrypt() → utf8 bytes, mirroring the CoachMessage/narrative helper).
    // provenance_json carries the labels-only envelope the UI renders.
    const nowIso = new Date().toISOString();
    const narrativeWindowFrom = daysAgo(30).toISOString();
    const periodNarratives: Array<{
      period: string;
      text: string;
      window: { from: string; to: string };
    }> = [
      {
        period: "week",
        text:
          "This week held the steady line you have been building. Your blood " +
          "pressure stayed in the optimal band every morning, resting heart " +
          "rate hovered near its low, and your nights landed close to 7.5 " +
          "hours. Adherence was perfect, and your mood entries were among " +
          "the brightest of the month. There is no single thing to fix here " +
          "— the value is in how repeatable the week was. Carrying the same " +
          "sleep and movement routine into next week is all it takes to keep " +
          "the trend intact.",
        window: { from: daysAgo(7).toISOString(), to: nowIso },
      },
      {
        period: "month",
        text:
          "Over the past month the gains from earlier in the quarter have " +
          "become your new normal. Blood pressure has held in the optimal " +
          "band rather than just dipping into it, weight has stabilised at a " +
          "healthy point, and resting heart rate has stayed low alongside " +
          "consistent daily activity. Sleep lengthened and steadied, and " +
          "your mood trend continued its quiet climb. The month reads less " +
          "like a change in progress and more like a routine that is paying " +
          "off — worth protecting exactly as it stands.",
        window: { from: narrativeWindowFrom, to: nowIso },
      },
    ];

    for (const narrative of periodNarratives) {
      const encryptedContent = Buffer.from(encrypt(narrative.text), "utf8");
      const provenance = {
        metrics: [
          "BLOOD_PRESSURE_SYS",
          "RESTING_HEART_RATE",
          "SLEEP_DURATION",
          "WEIGHT",
          "MOOD",
        ],
        window: narrative.window,
        pairsTested: 0,
        fdrQ: 0.1,
        computedAt: nowIso,
      };
      await client.query(
        `INSERT INTO insight_narratives (id, user_id, period, locale, date_key, encrypted_content, provenance_json, provider_type, prompt_version, created_at, updated_at)
         VALUES ($1, $2, $3, 'en', $4, $5, $6, $7, $8, NOW(), NOW())`,
        [
          cuid(),
          userId,
          narrative.period,
          todayKey,
          encryptedContent,
          JSON.stringify(provenance),
          bakedProvider,
          "demo",
        ],
      );
    }

    // ── App Settings ─────────────────────────
    console.log("Creating app settings...");
    // The key-backup step is confirmed for the key the demo runs with, the
    // same fields `POST /api/admin/encryption/key-backup/confirm` writes (key
    // id + its public fingerprint, never the key). The demo account is an
    // admin, so an unconfirmed step put a "Back up your encryption key"
    // banner above the dashboard for every visitor, about a key no visitor
    // can reach.
    const activeKeyId = getActiveKeyId();
    await client.query(
      `INSERT INTO app_settings (id, registration_enabled, default_locale,
         encryption_key_backup_confirmed_at, encryption_key_backup_confirmed_key_id,
         encryption_key_backup_confirmed_fingerprint, encryption_key_backup_confirmed_by_user_id)
       VALUES ('singleton', false, 'en', NOW(), $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET registration_enabled = false, default_locale = 'en',
         encryption_key_backup_confirmed_at = EXCLUDED.encryption_key_backup_confirmed_at,
         encryption_key_backup_confirmed_key_id = EXCLUDED.encryption_key_backup_confirmed_key_id,
         encryption_key_backup_confirmed_fingerprint = EXCLUDED.encryption_key_backup_confirmed_fingerprint,
         encryption_key_backup_confirmed_by_user_id = EXCLUDED.encryption_key_backup_confirmed_by_user_id`,
      [activeKeyId, getKeyFingerprint(activeKeyId), userId],
    );

    // ── Audit Log (some login entries) ──────
    console.log("Creating audit log entries...");
    for (let i = 0; i < 15; i++) {
      const loginDate = daysAgo(Math.floor(Math.random() * 30));
      await client.query(
        `INSERT INTO audit_logs (id, user_id, action, details, ip_address, created_at)
         VALUES ($1, $2, 'auth.login', '{"method":"password"}', '203.0.113.42', $3)`,
        [cuid(), userId, loginDate],
      );
    }

    await client.query("COMMIT");
    console.log("\nDemo data seeded successfully!");
    console.log(`  User: demo / demo123demo123`);
    console.log(
      `  Measurements: weight, BP, pulse, resting HR, body fat, steps, sleep, waist`,
    );
    console.log(
      `  Body composition: fat/lean/muscle mass, water, bone, visceral fat, BMI`,
    );
    console.log(
      `  Blood glucose: ${glucoseReadings.length} spot readings/day (fasting + post-meal + bedtime)`,
    );
    console.log(
      `  CGM: Nightscout-style stream, every ${cgmStepMin} min over ${cgmDays} days`,
    );
    console.log(
      `  Cardio + vitals: HRV (SDNN + RMSSD), SpO2, resp. rate, VO2max, active energy, distance, flights`,
    );
    console.log(
      `  Scores: recovery, day strain, sleep performance/efficiency/consistency`,
    );
    console.log(
      `  Sleep: 7 per-stage nights (4 stages each) + daily aggregate`,
    );
    console.log(`  Medications: 3 (high compliance, today on-track)`);
    console.log(
      `  Workouts: ~3-4/week (running, strength, cycling) with HR samples`,
    );
    console.log(`  Mood: ~${Math.round(span * 0.95)} entries`);
    console.log(`  Wellbeing screeners: 6 (WHO-5, PHQ-9, GAD-7)`);
    console.log(`  Vorsorge reminders: 2 (dental, annual physical)`);
    console.log(
      `  Lab panels: ${labResults.length} rows across 2 panels (incl. ${recentQual.length} qualitative)`,
    );
    console.log(
      `  Illness: resolved cold (day-logs) + recurring condition with a resolved flare`,
    );
    console.log(
      `  Cycle: ${cycleLengths.length} cycles with BBT, flow, mucus/OPK, symptoms + a forecast`,
    );
    console.log(
      `  Visits: knee arthroscopy (2 linked PDFs) + follow-up, check-up booked for tomorrow`,
    );
    console.log(`  Coach: ${coachConversations.length} conversations`);
    console.log(
      `  Baked AI texts: comprehensive + daily briefing, ${statusCards.length} status cards, ${periodNarratives.length} period narratives (en)`,
    );
    console.log(`  Achievements: ${achievements.length}`);
    console.log(
      `  History: ${historyRows.length} readings over ${HISTORY_DAYS} days, ${lifeEvents.length} life events, ${envRows.length} environment days`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
