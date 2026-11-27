/**
 * `GET /api/account/activity` — who opened this account's record, and when.
 *
 * The owner's side of the audit actor. Every row filed under this account that
 * somebody ELSE performed, newest first: the day-coalesced read rows the
 * delegated resolver writes, and any delegated action that lands an audit row
 * of its own. Rows the owner performed themselves are absent by construction —
 * `actorUserId` is null for those, and this feed is not a second copy of the
 * security-activity feed.
 *
 * **The window is published, not implied.** `retentionDays` rides the response
 * because audit rows are purged on a schedule the operator configures
 * (`AUDIT_LOG_RETENTION_DAYS`, 365 by default) and a view that showed "the
 * activity" without saying how far back it goes would claim a completeness it
 * does not have. The number is resolved server-side from the same function the
 * purge job uses, so the sentence in the UI cannot drift from the job that
 * makes it true — an instance running a 90-day window says 90.
 *
 * **And the window is now enforced, not only stated.** The query is bounded to
 * it. Without the filter the two halves of the same sentence disagreed: the
 * revoke dialog promised attribution "for the next N days" while this read
 * returned whatever the last hundred rows happened to be, which on a quiet
 * record reaches back past a shortened retention window and on a busy one
 * covers a fortnight. The bound the copy states is the bound the query uses.
 *
 * **The row cap says when it was hit.** A hundred rows is a display bound, and
 * a list that silently stops at its own ceiling is the more dangerous of the
 * two completeness lies — an owner scrolling to the bottom reads the oldest
 * line as the beginning. `truncated` is true when the cap was reached, and the
 * view says it is showing the most recent activity rather than all of it.
 * `false` means the list IS everything inside the window.
 *
 * Not delegable to an adult's delegate: `requireAuth()` refuses them under a
 * switch. A delegate must not be able to read the owner's record of who has
 * been in it — that list names other delegates, and a grant is not an
 * introduction to the household. A managed profile's guardian reads it, as the
 * profile's owner would (#1615): it is how they see what was done in the
 * profile and by whom.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiListSuccess } from "@/lib/api/list-cap";
import { prisma } from "@/lib/db";
import { listPage } from "@/lib/http/list-query";
import { getAuditLogRetentionDays } from "@/lib/jobs/audit-log-cleanup";
import {
  RECORD_ACTIVITY_MAX_ROWS,
  RECORD_ACTIVITY_SELECT,
  recordActivityWhere,
  toRecordActivityEntries,
} from "@/lib/record-activity/feed";

export type { RecordActivityEntry } from "@/lib/record-activity/feed";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // A switch into one's own record is not a delegation and has nothing to
  // report. `actingActorFor` already refuses to stamp one, so leaving the
  // owner's rows out is the second end of that rule rather than its only
  // enforcement.
  const retentionDays = getAuditLogRetentionDays();
  const { rows, cap } = await listPage(RECORD_ACTIVITY_MAX_ROWS, (take) =>
    prisma.auditLog.findMany({
      where: recordActivityWhere({
        recordId: user.id,
        excludeActorId: user.id,
        retentionDays,
      }),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: RECORD_ACTIVITY_SELECT,
    }),
  );
  const entries = await toRecordActivityEntries(rows);

  annotate({
    action: { name: "sharing.activity.list" },
    meta: { entry_count: entries.length, truncated: cap.truncated },
  });

  return apiListSuccess(
    {
      entries,
      // The bound the view states out loud. Resolved here so the UI never has to
      // hardcode a number the operator can change.
      retentionDays,
      // Deprecated copy of `meta.truncated`. It was a required field of `data`
      // through v1.43.6, and a client built against that contract must keep
      // decoding it; it goes in a minor release. The web reads `meta`.
      truncated: cap.truncated,
    },
    // Whether the list is everything inside that window, or its most recent
    // hundred rows, rides the envelope like every capped list's (`meta`).
    cap,
  );
});
