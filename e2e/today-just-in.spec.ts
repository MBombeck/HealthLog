import { expect, test } from "./setup/test";
import pg from "pg";

import { E2E_USER, STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.31.0 — Today reacts in place.
 *
 * The milestone's actual moment: new data lands, and the ALREADY-OPEN
 * dashboard starts reading differently on the cadence it already runs. No new
 * poll, no push, no socket — a state change, not a notification.
 *
 * The spec drives that end-to-end against the real read path:
 *
 *   0. give the account a reason to paint a hero at all — one integration
 *      needing a reconnect, which is an ordinary Today for someone whose
 *      readings sync from devices;
 *   1. load the dashboard with last night's sleep still missing, and prove
 *      it reads provisional with the pending note up;
 *   2. land it through the REAL batch endpoint, and the arrival marker the
 *      spine's worker would have written;
 *   3. surface the tab's real visibility-change signal — the browser event
 *      TanStack Query's focus manager consumes for
 *      `refetchOnWindowFocus: "always"` (alongside the 120 s foreground poll);
 *      using that existing trigger keeps the test inside the real cadence
 *      while staying well under the poll interval;
 *   4. assert the phase flipped and the pending note cleared — in place, no
 *      reload.
 *
 * The hero used to carry a "just in" chip here; it is gone, because under a
 * number "just in" never said what had arrived. What the milestone was
 * always about survives it: the open page reads differently on its own
 * cadence.
 *
 * Step 0 is what the chip's removal exposed rather than caused. The arrival
 * was the only thing keeping the hero on screen for this bare fixture
 * account, so the spec was watching the day flip on a hero its own subject
 * was propping up — and on whatever data a sibling spec happened to leave
 * behind. It now establishes its own precondition, so the hero is there for
 * a reason a reader would recognise and the run order cannot decide the
 * outcome. `today-hero-just-in.test.tsx` pins the same composition at the
 * component, since this file cannot be run without a built app.
 *
 * The marker is seeded directly rather than waited for from pg-boss: whether
 * the queue drains inside the e2e web server is the SPINE's contract and has
 * its own tests. What this spec owns is everything downstream of a marker
 * existing — the read path, the DTO, and the surface.
 *
 * Assertions anchor on `data-slot` / `data-phase`, never on visible text:
 * responsive `sm:hidden` classes have broken `getByText` in this repo before.
 */
test.use({ storageState: STORAGE_STATE_PATH });

/** The user's local day, in the same profile-tz space the digest files under. */
function localDayKey(at: Date, timeZone: string): string {
  // en-CA renders ISO-ordered YYYY-MM-DD, which is exactly the key shape.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

test("a fresh arrival flips the day in place", async ({ page }) => {
  const dbUrl = process.env.DATABASE_URL;
  test.skip(!dbUrl, "DATABASE_URL is required to seed the arrival marker");

  const pool = new pg.Pool({ connectionString: dbUrl });
  const client = await pool.connect();

  try {
    // Both Playwright projects deliberately exercise this real-data flow, but
    // they share the one authenticated fixture user. Keep the two viewport
    // runs from deleting/inserting the same arrival marker concurrently; the
    // lock is scoped to this database session and releases even if the test
    // fails. This preserves real Desktop + Mobile coverage instead of hiding
    // the race behind a project skip.
    await client.query(
      "SELECT pg_advisory_lock(hashtext('e2e:today-just-in'))",
    );

    const { rows } = await client.query<{
      id: string;
      timezone: string | null;
    }>("SELECT id, timezone FROM users WHERE username = $1", [
      E2E_USER.username,
    ]);
    expect(rows.length, "seeded e2e user must exist").toBe(1);
    const userId = rows[0].id;
    const timezone = rows[0].timezone ?? "UTC";

    // A clean reaction slate: no marker and no final morning-refresh stamp.
    // Older health data may remain, but it must not masquerade as newly
    // arrived data before this scenario records its own sleep sample.
    await client.query("DELETE FROM arrival_reactions WHERE user_id = $1", [
      userId,
    ]);
    await client.query(
      "UPDATE users SET morning_digest_refreshed_on = NULL WHERE id = $1",
      [userId],
    );
    // And no sleep sample from an earlier run of THIS spec — the desktop
    // project runs first and leaves one behind, and the day reads `final`
    // for as long as last night's sleep is in the record, which would make
    // the provisional assertion below unreachable on every run after the
    // first. Scoped to the external ids this file writes: it is the only
    // e2e spec that records sleep for the fixture account (the two v1427
    // specs mock the route in the browser and write nothing), so nothing
    // else can be depending on these rows.
    //
    // Deleted through the APP rather than with a `DELETE FROM measurements`,
    // and that difference is the whole reason this scenario used to fail on
    // the second project: a fixture that mutates rows behind the app's back
    // inherits the app's caching. `sleepLastSeenDaysAgo` is read off the
    // dashboard snapshot, which is an SWR cell in the analytics bucket
    // (60 s fresh, one HOUR of stale-serve), so the desktop run's
    // "sleep is in" snapshot outlived the rows it was built from and the
    // mobile run read `final` from cache against an empty table.
    //
    // `bulk-delete` specifically: it hard-evicts that bucket
    // (`invalidateUserMeasurements(userId, { evict: true })`, pinned by its
    // own route test), tombstones the rows the way the management list
    // does, and recomputes the rollup buckets the snapshot reads through.
    // The delete-by-external-id route would have been the closer fit for
    // how this spec names its rows, but it invalidates WITHOUT `evict` —
    // a marked-stale cell is served immediately while it revalidates, so
    // the next read would still have been the stale `final` one.
    //
    // Ids come from SQL rather than from `GET /api/measurements`: that
    // list collapses overlapping sources to one canonical row per day, so
    // it can hide a row that is still in the table and still counts.
    //
    // Deliberately NOT moved into the `finally` block. The eviction only
    // happens when the delete actually removes something, so cleaning up
    // at the end of each run would leave the next one with nothing to
    // delete, no eviction, and the same stale snapshot.
    const stale = await client.query<{ id: string }>(
      `SELECT id FROM measurements
        WHERE user_id = $1
          AND external_id LIKE 'e2e-just-in-%'
          AND deleted_at IS NULL
        LIMIT 200`,
      [userId],
    );
    if (stale.rows.length > 0) {
      const purge = await page.request.post("/api/measurements/bulk-delete", {
        data: { ids: stale.rows.map((row) => row.id) },
      });
      expect(
        purge.ok(),
        `purging ${stale.rows.length} stale sleep rows must be accepted (got ${purge.status()})`,
      ).toBe(true);
    }

    // A night from earlier in the week, so this is a record that expects
    // sleep at all. The digest waits for last night only when sleep actually
    // reaches the account (a night inside the last seven days); without one
    // the purge above leaves a record with no sleep source, which reads
    // `final` by design and puts the provisional assertion below out of
    // reach. Written through the same ingest route as the fresh night, and
    // swept by the same `e2e-just-in-` purge on the next run.
    const priorNight = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const priorWoke = new Date(priorNight.getTime() + 7 * 60 * 60_000);
    const priorBatch = await page.request.post("/api/measurements/batch", {
      data: {
        entries: [
          {
            hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
            value: 420,
            unit: "min",
            startDate: priorNight.toISOString(),
            endDate: priorWoke.toISOString(),
            externalId: `e2e-just-in-prior-${priorNight.getTime()}`,
            sleepStage: 3,
          },
        ],
      },
    });
    expect(
      priorBatch.ok(),
      `prior-night sleep batch must be accepted (got ${priorBatch.status()})`,
    ).toBe(true);

    // The account needs a reason to paint a hero that is not the arrival
    // itself. A connection needing a reconnect is that reason: the digest
    // reads `integration_statuses` fresh on every request rather than
    // through the dashboard snapshot's SWR cell, so unlike a seeded score
    // or a seeded briefing (both of which ride that cell) it
    // cannot lose a race with a cached snapshot, and `buildSyncIssueItems`
    // admits it unconditionally — no module gate, no window, and
    // `sync_issue` carries no dismiss path that a previous run could have
    // silenced. Removed again in the `finally` below.
    await client.query(
      `INSERT INTO integration_statuses (id, user_id, integration, state, updated_at)
       VALUES ($1, $2, 'withings', 'error_reauth', NOW())
       ON CONFLICT (user_id, integration) DO UPDATE SET state = 'error_reauth'`,
      [`c${Date.now()}syncissue000`, userId],
    );

    // ── BEFORE ────────────────────────────────────────────────────────────
    // Wait until the digest settles, then pin the starting state. The two
    // assertions that matter here are the ones that make the AFTER block
    // mean something: a note that was never rendered is also absent at the
    // end, and a day that was already final also reads final at the end.
    await page.goto("/");
    // No wait on the skeleton being gone: it is also gone while the protected
    // shell holds the whole page behind its hydration gate, so it resolves
    // before the digest has rendered anything. The hero count below is the
    // wait, and it is a wait on the content itself.
    const hero = page.locator('[data-slot="today-hero"]');
    // Counts rather than visibility, matching the AFTER block: the two are
    // then the same assertion with the expected number flipped, and neither
    // can pass because a responsive class happened to hide the element.
    await expect(hero).toHaveCount(1, { timeout: 20_000 });
    await expect(hero).toHaveAttribute("data-phase", "provisional");
    await expect(
      hero.locator('[data-slot="today-hero-sleep-pending"]'),
    ).toHaveCount(1);
    // Nothing on it may name an arrival: that chip was removed.
    await expect(page.locator('[data-slot="today-hero-just-in"]')).toHaveCount(
      0,
    );

    // ── NEW DATA LANDS ────────────────────────────────────────────────────
    // Last night's sleep through the real ingest route, on the session the
    // storage state already carries.
    const now = new Date();
    const wokeAt = new Date(now.getTime() - 60 * 60_000);
    const fellAsleepAt = new Date(wokeAt.getTime() - 7 * 60 * 60_000);

    const batch = await page.request.post("/api/measurements/batch", {
      data: {
        entries: [
          {
            hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
            value: 420,
            unit: "min",
            startDate: fellAsleepAt.toISOString(),
            endDate: wokeAt.toISOString(),
            externalId: `e2e-just-in-${now.getTime()}`,
            sleepStage: 3,
          },
        ],
      },
    });
    expect(
      batch.ok(),
      `sleep batch must be accepted (got ${batch.status()})`,
    ).toBe(true);

    // The marker the spine's worker writes on a salient arrival, plus the
    // morning-refresh stamp it rides alongside — the two rows that together
    // make the day final and the arrival news.
    const localDate = localDayKey(now, timezone);
    await client.query(
      `INSERT INTO arrival_reactions
         (id, user_id, kind, local_date, occurred_at, arrived_at, created_at)
       VALUES ($1, $2, 'sleep_night', $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, kind, local_date) DO UPDATE
         SET occurred_at = EXCLUDED.occurred_at,
             arrived_at = NOW()`,
      [`c${now.getTime()}justin000000`, userId, localDate, wokeAt],
    );
    await client.query(
      "UPDATE users SET morning_digest_refreshed_on = $2 WHERE id = $1",
      [userId, localDate],
    );

    // The tab becomes visible — the browser signal TanStack Query's focus
    // manager consumes. The digest refetches in place; the page never reloads.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );

    await expect(hero).toHaveAttribute("data-phase", "final", {
      timeout: 20_000,
    });
    // Sleep is in, so the provisional freshness note is gone with it.
    await expect(
      hero.locator('[data-slot="today-hero-sleep-pending"]'),
    ).toHaveCount(0);
    // And the arrival still raises no chip of its own, on either pass.
    await expect(page.locator('[data-slot="today-hero-just-in"]')).toHaveCount(
      0,
    );
  } finally {
    await client
      .query(
        "DELETE FROM integration_statuses WHERE user_id = (SELECT id FROM users WHERE username = $1) AND integration = 'withings'",
        [E2E_USER.username],
      )
      // The account is shared, so the seeded row must go even when an
      // assertion above threw — but a cleanup that throws would replace a
      // real failure with a confusing one.
      .catch(() => {});
    client.release();
    await pool.end();
  }
});
