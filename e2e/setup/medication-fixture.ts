/**
 * Account hygiene and row-ageing for the medication-adherence journey.
 *
 * `medication-compliance-journey.spec.ts` asserts RATES — a percentage over
 * one account's own doses — and the dashboard tile sums the expected doses of
 * every active medication that account holds. Both are counts, so the spec has
 * to own the rows it counts against: a medication left by an earlier run or a
 * Playwright retry would sit in the denominator of every verdict. Everything
 * here is keyed on `E2E_MEDICATION`, the journey's own account, so neither the
 * clearing nor the ageing can be felt by a spec running in the other worker.
 *
 * The ageing is the other half. Compliance is reconstructed over
 * `[max(medication.createdAt, now − window), now]` — a medication created a
 * second ago has expected no dose yet, so its rate is the empty-set 100 % and
 * no take can move it. A journey that wants to watch a number change needs a
 * medication that has been in the cabinet for a few days, and the only honest
 * way to have one inside a test is to age the row.
 */
import pg from "pg";

import { E2E_MEDICATION } from "./global-setup";

function pool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[medication-fixture] DATABASE_URL is not set");
  return new pg.Pool({ connectionString: url });
}

async function getUserId(db: pg.Pool): Promise<string> {
  const res = await db.query<{ id: string }>(
    "SELECT id FROM users WHERE username = $1",
    [E2E_MEDICATION.username],
  );
  const id = res.rows[0]?.id;
  if (!id) {
    throw new Error(
      "[medication-fixture] medication account not seeded — global-setup must run first",
    );
  }
  return id;
}

/**
 * Clear the journey account's cabinet — through the app, not around it.
 *
 * The rows are enumerated in SQL because the list route serves a memoised
 * shape and a row that cache has not caught up with would hide from it. Every
 * removal then goes out as the caller's own `DELETE /api/medications/{id}`,
 * which is the only path that evicts the three 15-minute per-user cells
 * medication state lives in (`caches.medications`,
 * `caches.medicationCompliance`, `caches.medicationsIntake`). A raw
 * `DELETE FROM medications` reaches none of them, and the next read would
 * answer out of a cache still naming rows that no longer exist — which is
 * exactly the read this helper exists to make trustworthy. Schedules, schedule
 * revisions, pause eras and intake events cascade off the row either way.
 *
 * Safe to call from every test's `beforeEach`.
 */
export async function resetMedications(
  deleteMedication: (id: string) => Promise<void>,
): Promise<void> {
  const db = pool();
  let ids: string[];
  try {
    const userId = await getUserId(db);
    const res = await db.query<{ id: string }>(
      "SELECT id FROM medications WHERE user_id = $1",
      [userId],
    );
    ids = res.rows.map((row) => row.id);
  } finally {
    await db.end();
  }
  for (const id of ids) await deleteMedication(id);
}

/** The two stamps {@link ageMedication} writes onto the row. */
export interface MedicationAgeStamps {
  /** The instant the row should claim as its creation, as an ISO string. */
  createdAt: string;
  /** The `YYYY-MM-DD` the course should claim as its start. */
  startsOn: string;
}

/**
 * Move a medication's creation stamp and its course start into the past, so
 * the compliance engine expands the schedule over those days and the doses
 * nobody logged read as missed.
 *
 * Both stamps come from the caller rather than from the database clock, and
 * that is deliberate: `CURRENT_DATE` resolves in the database session's zone,
 * which on CI is the Postgres container's UTC, while the plan dates the spec
 * sends are computed in the browser's pinned `Europe/Berlin`. Between midnight
 * and 02:00 Berlin the two name different calendar days, and the row would
 * quietly start one day earlier than its caller asked for. `starts_on` is
 * OVERWRITTEN, not adjusted — whatever the create call sent is replaced by
 * what is passed here.
 *
 * The row is edited directly, which no cache invalidation can see: the
 * per-medication compliance payload and the dashboard's daily buckets are
 * both memoised server-side for 15 minutes, and the detail page the create
 * flow lands on has already warmed them. The caller therefore passes a
 * writer — one ordinary API write against the medication — and this helper
 * uses it to flush those cells through the app's own invalidation path.
 */
export async function ageMedication(
  medicationId: string,
  stamps: MedicationAgeStamps,
  flushCaches: () => Promise<void>,
): Promise<void> {
  const db = pool();
  try {
    const userId = await getUserId(db);
    const res = await db.query(
      `UPDATE medications
          SET created_at = $1::timestamptz,
              starts_on  = $2::date
        WHERE id = $3 AND user_id = $4`,
      [stamps.createdAt, stamps.startsOn, medicationId, userId],
    );
    if (res.rowCount !== 1) {
      throw new Error(
        `[medication-fixture] expected to age exactly one medication, updated ${res.rowCount}`,
      );
    }
  } finally {
    await db.end();
  }
  await flushCaches();
}
