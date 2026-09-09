/**
 * Account hygiene and row-ageing for the medication-adherence journey.
 *
 * `medication-compliance-journey.spec.ts` asserts RATES — a percentage over
 * the seeded account's own doses — and the dashboard tile sums the expected
 * doses of every active medication the account holds. Both are counts, so the
 * spec has to own the rows it counts against: a medication left by an earlier
 * run or a Playwright retry would sit in the denominator of every verdict.
 * `resetMedications` is the delete-then-count guarantee, keyed by the seeded
 * user's id; every other e2e spec that touches `/api/medications` stubs the
 * route, so nothing else has live rows here to lose.
 *
 * The ageing is the other half. Compliance is reconstructed over
 * `[max(medication.createdAt, now − window), now]` — a medication created a
 * second ago has expected no dose yet, so its rate is the empty-set 100 % and
 * no take can move it. A journey that wants to watch a number change needs a
 * medication that has been in the cabinet for a few days, and the only honest
 * way to have one inside a test is to age the row.
 */
import pg from "pg";

import { E2E_USER } from "./global-setup";

function pool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[medication-fixture] DATABASE_URL is not set");
  return new pg.Pool({ connectionString: url });
}

async function getUserId(db: pg.Pool): Promise<string> {
  const res = await db.query<{ id: string }>(
    "SELECT id FROM users WHERE username = $1",
    [E2E_USER.username],
  );
  const id = res.rows[0]?.id;
  if (!id) {
    throw new Error(
      "[medication-fixture] e2e user not seeded — global-setup must run first",
    );
  }
  return id;
}

/**
 * Drop the seeded e2e user's medications. Schedules, schedule revisions,
 * pause eras and intake events all cascade off `medications`, so the one
 * delete clears the whole cabinet. Safe to call from every test's
 * `beforeEach`.
 */
export async function resetMedications(): Promise<void> {
  const db = pool();
  try {
    const userId = await getUserId(db);
    await db.query("DELETE FROM medications WHERE user_id = $1", [userId]);
  } finally {
    await db.end();
  }
}

/**
 * Move a medication's creation stamp (and its course start) `days` into the
 * past, so the compliance engine expands the schedule over those days and the
 * doses nobody logged read as missed.
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
  days: number,
  flushCaches: () => Promise<void>,
): Promise<void> {
  const db = pool();
  try {
    const userId = await getUserId(db);
    const res = await db.query(
      `UPDATE medications
          SET created_at = now() - make_interval(days => $1),
              starts_on  = (CURRENT_DATE - make_interval(days => $1))::date
        WHERE id = $2 AND user_id = $3`,
      [days, medicationId, userId],
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
