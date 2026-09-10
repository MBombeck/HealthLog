/**
 * The third E2E server: the one configured for mail, and the one with no
 * scheduler.
 *
 * Two things the notification-dispatch journey needs are wrong for every other
 * spec, so it gets its own process rather than bending the shared one.
 *
 * **Mail.** `SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM` are operator config, and
 * `isEmailConfigured()` is what decides whether the Email card renders at all
 * (`src/components/settings/email-card.tsx`). Putting them on the shared server
 * would put that card on `/settings/integrations` for every spec that opens the
 * route — the axe scan and the card-anatomy geometry sweep included — and make
 * this branch responsible for a surface it does not touch. Here, the shipped
 * "no SMTP, no card" state stays what every other spec observes.
 *
 * **No scheduler.** Unset, `HEALTHLOG_PROCESS_TYPE` reads "all" and
 * `src/instrumentation.ts` starts the pg-boss reminder worker inside the
 * process serving requests, which schedules `medication-reminder-check` every
 * fifteen minutes. The journey keeps a medication overdue for the length of a
 * test, and a tick inside that window either mints the missed-dose row that
 * makes the sweep skip its own dispatch or dispatches beside it and adds a
 * ledger row the count was not expecting. `web` is the shipped, documented
 * value for HTTP-without-scheduler (docs/self-hosting/scaling.md); the pg-boss
 * PRODUCER still starts, so a route that enqueues work keeps working, and the
 * journey's own trigger is a route rather than a job.
 *
 * The shared server keeps "all" deliberately, and the reason is measured
 * rather than assumed: `getWorkerStatus()` is per-process in-memory, so a `web`
 * process reports the worker stopped, `/admin` renders that row
 * `text-destructive`, and axe fails it at 3.97:1 against the muted tile. That
 * is a real contrast defect, visible to any operator running the documented
 * web/worker split, and it is not this branch's to fix. What it means here is
 * that the scheduler still exists on the suite's shared process: it is off in
 * the process the journey drives, not off in the run.
 *
 * With `E2E_SKIP_WEB_SERVER=1` no server is started for you and all three have
 * to be running — the same contract the other two already carry.
 */
export const NOTIFICATION_PORT = 3200;

export const NOTIFICATION_BASE_URL =
  process.env.E2E_NOTIFICATION_BASE_URL ??
  `http://localhost:${NOTIFICATION_PORT}`;
