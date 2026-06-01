import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";
import { isPublicUrl } from "@/lib/validations/notifications";
import { safeFetch } from "@/lib/safe-fetch";
import {
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";
import { recomputeUserMoodRollups } from "@/lib/rollups/mood-rollups";

/**
 * Sync mood entries from a user's moodLog instance.
 * Fetches from the health-log export endpoint and upserts into local DB.
 */
export async function syncMoodLogEntries(
  userId: string,
  opts?: { fullSync?: boolean },
): Promise<number> {
  // 1. Read user credentials
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      moodLogUrlEncrypted: true,
      moodLogApiKeyEncrypted: true,
      moodLogEnabled: true,
      moodLogLastSyncedAt: true,
    },
  });

  if (
    !user?.moodLogEnabled ||
    !user.moodLogUrlEncrypted ||
    !user.moodLogApiKeyEncrypted
  ) {
    return 0;
  }

  // Park: if we already know the apiKey is rejected, skip the network
  // round-trip until the user re-saves credentials. The settings PUT
  // route clears this state (see /api/settings/moodlog).
  if (await isReauthRequired(userId, "moodlog")) {
    getEvent()?.addWarning(
      `moodlog sync skipped for ${userId}: parked at error_reauth`,
    );
    return 0;
  }

  const baseUrl = decrypt(user.moodLogUrlEncrypted);
  const apiKey = decrypt(user.moodLogApiKeyEncrypted);

  // SSRF guard at the actual fetch site. The credential write path
  // is also guarded (moodLogCredentialsSchema), but a row stored
  // before that guard landed could still point at an internal IP.
  // Re-checking here means the sync worker refuses internal targets
  // even on legacy data, and the user's apiKey is never sent there.
  if (!isPublicUrl(baseUrl)) {
    getEvent()?.addWarning(
      `moodLog sync refused for user ${userId}: stored URL points at non-public host`,
    );
    await recordSyncFailure({
      userId,
      integration: "moodlog",
      kind: "reauth_required",
      message: "Stored moodLog URL points at a non-public host",
      errorCode: "ssrf_refused",
    });
    return 0;
  }

  // 2. Determine date range
  const now = new Date();
  const to = now.toISOString().slice(0, 10); // YYYY-MM-DD

  let from: string;
  if (opts?.fullSync || !user.moodLogLastSyncedAt) {
    // Full sync: fetch all available data
    from = "2000-01-01";
  } else {
    // Incremental: from lastSyncedAt - 1 hour overlap
    const d = new Date(user.moodLogLastSyncedAt.getTime() - 3600 * 1000);
    from = d.toISOString().slice(0, 10);
  }

  // 3. Fetch from moodLog
  const url = new URL("/api/integrations/health-log/mood", baseUrl);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);

  // safeFetch keeps the no-redirect-follow guard (the apiKey would
  // otherwise leak on an attacker-controlled 302 hop) and adds a hard
  // upper bound via AbortSignal.timeout. requirePublicHost routes the
  // dial through the pinned-IP dispatcher so a DNS rebinding cannot
  // flip a public hostname to 169.254.169.254 / RFC1918 between the
  // input-time accept and the connect call.
  const timeoutMs = opts?.fullSync ? 60_000 : 15_000;
  let response: Response;
  const fetchStart = performance.now();
  try {
    response = await safeFetch(
      url.toString(),
      { headers: { Authorization: `Bearer ${apiKey}` } },
      { timeoutMs, requirePublicHost: true },
    );
  } catch (err) {
    getEvent()?.addExternalCall({
      service: "moodlog",
      method: "syncMoodLogEntries",
      duration_ms: Math.round(performance.now() - fetchStart),
    });
    const message = err instanceof Error ? err.message : String(err);
    await recordSyncFailure({
      userId,
      integration: "moodlog",
      kind: "transient",
      message,
      errorCode: "fetch_failed",
    });
    return 0;
  }
  getEvent()?.addExternalCall({
    service: "moodlog",
    method: "syncMoodLogEntries",
    duration_ms: Math.round(performance.now() - fetchStart),
    status: response.status,
  });

  // Treat any 3xx as failure (manual redirect mode surfaces them).
  if (response.status >= 300 && response.status < 400) {
    getEvent()?.addWarning(
      `moodLog sync refused redirect for user ${userId}: HTTP ${response.status}`,
    );
    await recordSyncFailure({
      userId,
      integration: "moodlog",
      kind: "transient",
      message: `moodLog sync refused redirect (HTTP ${response.status})`,
      errorCode: `http_${response.status}`,
    });
    return 0;
  }

  if (!response.ok) {
    getEvent()?.addWarning(
      `Sync failed for user ${userId}: HTTP ${response.status}`,
    );
    // 401/403 — apiKey rejected. Park the integration so we don't
    // hammer the upstream until the user re-saves credentials.
    const isAuthFailure = response.status === 401 || response.status === 403;
    await recordSyncFailure({
      userId,
      integration: "moodlog",
      kind: isAuthFailure ? "reauth_required" : "transient",
      message: `moodLog sync HTTP ${response.status}`,
      errorCode: `http_${response.status}`,
    });
    return 0;
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSyncFailure({
      userId,
      integration: "moodlog",
      kind: "transient",
      message: `moodLog sync invalid JSON: ${message}`,
      errorCode: "invalid_json",
    });
    return 0;
  }

  // Validate response has entries array
  if (
    !data ||
    typeof data !== "object" ||
    !("entries" in data) ||
    !Array.isArray((data as { entries?: unknown }).entries)
  ) {
    getEvent()?.addWarning(`Invalid response format for user ${userId}`);
    await recordSyncFailure({
      userId,
      integration: "moodlog",
      kind: "transient",
      message: "moodLog sync invalid response format (missing 'entries' array)",
      errorCode: "invalid_format",
    });
    return 0;
  }
  const entries = (data as { entries: unknown[] }).entries;

  // 4. Upsert entries (note field is intentionally NOT imported)
  //
  // v1.4.50 — entries MoodLog re-exports with `loggedVia: "HEALTHLOG"`
  // are echoes of rows HealthLog pushed via the reverse-sync POST.
  // Re-importing them would flip the `source` column from the original
  // attribution (MANUAL / WEB / TELEGRAM / iOS) to MOODLOG, losing the
  // provenance the user already established and double-counting the
  // entry in any source-segregated dashboard. Skip them on the pull
  // side so the loop closes at one round-trip.
  let imported = 0;
  let echoSkipped = 0;
  for (const e of entries) {
    const entry = e as {
      time: string;
      date: string;
      mood: string;
      score: number;
      tags?: string[];
      loggedVia?: string;
    };
    if (entry.loggedVia === "HEALTHLOG") {
      echoSkipped += 1;
      continue;
    }
    try {
      const moodLoggedAt = new Date(entry.time);
      const date = entry.date;

      await prisma.moodEntry.upsert({
        where: {
          userId_date_moodLoggedAt: {
            userId,
            date,
            moodLoggedAt,
          },
        },
        update: {
          mood: entry.mood,
          score: entry.score,
          tags: entry.tags ? JSON.stringify(entry.tags) : null,
          source: "MOODLOG",
        },
        create: {
          userId,
          date,
          mood: entry.mood,
          score: entry.score,
          tags: entry.tags ? JSON.stringify(entry.tags) : null,
          source: "MOODLOG",
          moodLoggedAt,
        },
      });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(`Failed to upsert entry: ${err}`);
    }
  }

  // 5. Update lastSyncedAt + clear sync-status streak
  await prisma.user.update({
    where: { id: userId },
    data: { moodLogLastSyncedAt: now },
  });
  await recordSyncSuccess(userId, "moodlog");

  // v1.4.50 — annotate the echo-skip count so an operator can see how
  // many reverse-sync entries the pull side filtered out per cycle.
  // Should match the user's recent `pushMoodEntriesToMoodLog` count;
  // a divergent number signals either a stale MoodLog deploy
  // (pre-HEALTHLOG-source) or a configuration drift.
  if (echoSkipped > 0) {
    getEvent()?.addExternalCall({
      service: "moodlog",
      method: "syncMoodLogEntries.echoSkipped",
      duration_ms: 0,
    });
  }

  // v1.4.39 W-MOOD — re-fold the rollup tier after a sync. The
  // sync upserts a batch spanning many days; one bounded
  // recompute is cheaper than firing N per-row hooks. Best-effort:
  // a rollup failure here must not bubble up and undo the
  // recordSyncSuccess we just committed.
  if (imported > 0) {
    try {
      await recomputeUserMoodRollups(userId, { granularities: ["DAY"] });
    } catch (err) {
      getEvent()?.addWarning(
        `Mood rollup recompute failed after sync: ${err}`,
      );
    }
  }

  return imported;
}
