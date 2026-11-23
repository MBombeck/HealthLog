/**
 * `GET /api/managed-profiles/{id}/activity` — who did what in a managed
 * profile (#1403).
 *
 * A managed profile has nobody who signs in to it, so every act on it is a
 * guardian's, and before this read the only place those rows showed was the
 * admin audit log. A guardian now reads the profile's feed from their own
 * account: the audit rows filed under the profile that a person performed,
 * their own and every other guardian's, inside the retention window and
 * capped like the owner's feed (`src/lib/record-activity/feed.ts`). The
 * action, the actor and the instant leave the table; a row's details never
 * do.
 *
 * An ACTOR surface, like the roster and the identity read beside it: the
 * profile is named in the path, the session is a cookie, and the caller must
 * hold an active guardian grant on a profile that is still managed. One 404
 * for "no such account", "not managed" and "not your profile", so the route
 * is not an enumeration oracle. An adult's ordinary record shared at manage
 * level is not a managed profile and is refused the same way: its owner reads
 * their own feed, and a delegate does not.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { apiListSuccess } from "@/lib/api/list-cap";
import { annotate } from "@/lib/logging/context";
import { readManagedProfileForGuardian } from "@/lib/managed-profiles/lifecycle";
import { prisma } from "@/lib/db";
import { listPage } from "@/lib/http/list-query";
import { getAuditLogRetentionDays } from "@/lib/jobs/audit-log-cleanup";
import {
  RECORD_ACTIVITY_MAX_ROWS,
  RECORD_ACTIVITY_SELECT,
  recordActivityWhere,
  toRecordActivityEntries,
} from "@/lib/record-activity/feed";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireCookieAuth();
    const { id } = await params;

    const profile = await readManagedProfileForGuardian({
      profileId: id,
      guardianId: user.id,
    });
    if (!profile) {
      return apiError("Managed profile not found", 404, {
        errorCode: "managed_profile.not_found",
      });
    }

    const retentionDays = getAuditLogRetentionDays();
    const { rows, cap } = await listPage(RECORD_ACTIVITY_MAX_ROWS, (take) =>
      prisma.auditLog.findMany({
        where: recordActivityWhere({ recordId: id, retentionDays }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: RECORD_ACTIVITY_SELECT,
      }),
    );
    const entries = await toRecordActivityEntries(rows);
    annotate({
      action: { name: "managed_profile.activity.list" },
      meta: {
        profile_id: id,
        entry_count: entries.length,
        truncated: cap.truncated,
      },
    });
    return apiListSuccess({ entries, retentionDays }, cap);
  },
);
