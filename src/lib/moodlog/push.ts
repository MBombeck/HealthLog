import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";
import { isPublicUrl } from "@/lib/validations/notifications";
import { safeFetch } from "@/lib/safe-fetch";

/**
 * v1.4.50 — reverse-sync push: HealthLog → MoodLog.
 *
 * The historic sync direction (`syncMoodLogEntries` in `sync.ts`)
 * polls MoodLog every 15 minutes and imports new rows. That's a
 * one-way bridge: anything the user logs INSIDE HealthLog (the iOS
 * app's mood reminder, the web form, a Telegram nudge handler) never
 * reaches MoodLog. Marc's report: he taps a mood in iOS, the entry
 * lands in HealthLog, but never appears in MoodLog's timeline.
 *
 * This helper closes that gap. Every successful create on
 * `POST /api/mood-entries` and `POST /api/mood-entries/bulk` triggers
 * a fire-and-forget push to MoodLog's `POST /api/integrations/health-
 * log/mood` (added in MoodLog's matching release). The push:
 *
 *   - Skips rows whose `source` is already `MOODLOG` — those came
 *     FROM MoodLog via the pull side, pushing them back would echo.
 *   - Uses the same per-user `moodLogUrlEncrypted` + `moodLogApiKey
 *     Encrypted` credentials the pull side reads, plus the same
 *     `isPublicUrl` SSRF guard.
 *   - Carries `mood`, `note`, `tags` (as key strings), and the
 *     original `moodLoggedAt` in the body's `time` field so MoodLog's
 *     upsert dedup key `(userId, date, createdAt)` stays consistent
 *     across both directions.
 *   - Tags the inbound entries with `source: "HEALTHLOG"` on the
 *     MoodLog side so the next pull cycle's `syncMoodLogEntries` can
 *     filter them out (avoiding an echo-loop where the same row
 *     bounces back as a MOODLOG-tagged entry).
 *
 * Failure mode: this is a best-effort push, intentionally NOT awaited
 * by the create handler. Network errors, MoodLog being down, or
 * MoodLog rejecting the payload all emit a wide-event warning but
 * never bubble back to the user's create request. The next entry the
 * user logs retries the push; if MoodLog has been down for hours, the
 * user can hit "Force sync" in settings to backfill (TBD — for v1.5).
 */
export interface MoodEntryForPush {
  /** YYYY-MM-DD, anchored to the user's display timezone. */
  date: string;
  /** ISO timestamp — `moodLoggedAt` from the HealthLog row. */
  moodLoggedAt: Date;
  mood: string;
  note: string | null;
  /** JSON-encoded string or null — pull side normalises to key array. */
  tags: string | null;
  /** v1.4.50 — only `MANUAL` / `WEB` / `TELEGRAM` / `iOS` push to MoodLog. */
  source: string;
}

export async function pushMoodEntriesToMoodLog(
  userId: string,
  entries: ReadonlyArray<MoodEntryForPush>,
): Promise<{ pushed: number; skipped: number; status: "ok" | "skipped" | "failed" }> {
  // Entries originating in MoodLog mustn't loop back. The pull side
  // also filters incoming `HEALTHLOG`-tagged rows; this is the
  // outbound mirror of that gate.
  const candidates = entries.filter((e) => e.source !== "MOODLOG");
  if (candidates.length === 0) {
    return { pushed: 0, skipped: entries.length, status: "skipped" };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      moodLogUrlEncrypted: true,
      moodLogApiKeyEncrypted: true,
      moodLogEnabled: true,
    },
  });

  if (
    !user?.moodLogEnabled ||
    !user.moodLogUrlEncrypted ||
    !user.moodLogApiKeyEncrypted
  ) {
    return {
      pushed: 0,
      skipped: candidates.length,
      status: "skipped",
    };
  }

  const baseUrl = decrypt(user.moodLogUrlEncrypted);
  const apiKey = decrypt(user.moodLogApiKeyEncrypted);

  if (!isPublicUrl(baseUrl)) {
    // Same SSRF guard pull side uses — a stored row pointing at an
    // internal target must never receive the user's apiKey.
    getEvent()?.addWarning(
      `moodlog push refused for ${userId}: stored URL points at non-public host`,
    );
    return { pushed: 0, skipped: candidates.length, status: "failed" };
  }

  const url = new URL("/api/integrations/health-log/mood", baseUrl);

  const body = {
    entries: candidates.map((e) => ({
      date: e.date,
      time: e.moodLoggedAt.toISOString(),
      mood: e.mood,
      note: e.note,
      tags: parseTagKeys(e.tags),
      source: "HEALTHLOG" as const,
    })),
  };

  const start = performance.now();
  let response: Response;
  try {
    // requirePublicHost adds the DNS-rebinding pin to the input-time
    // isPublicUrl guard (issue #217). The reverse-sync path attaches a
    // user-supplied bearer; a rebinding flip would leak it on the
    // connect call to the swapped private address.
    response = await safeFetch(
      url.toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      { timeoutMs: 10_000, requirePublicHost: true },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addExternalCall({
      service: "moodlog",
      method: "pushMoodEntriesToMoodLog",
      duration_ms: Math.round(performance.now() - start),
    });
    getEvent()?.addWarning(
      `moodlog push failed for ${userId} (fetch): ${message}`,
    );
    return { pushed: 0, skipped: candidates.length, status: "failed" };
  }

  getEvent()?.addExternalCall({
    service: "moodlog",
    method: "pushMoodEntriesToMoodLog",
    duration_ms: Math.round(performance.now() - start),
    status: response.status,
  });

  // 3xx — manual redirect mode surfaces them. Match the pull-side
  // behaviour: a redirect from a public host that ended up pointing
  // at an RFC1918 target would otherwise leak the apiKey.
  if (response.status >= 300 && response.status < 400) {
    getEvent()?.addWarning(
      `moodlog push refused redirect for ${userId}: HTTP ${response.status}`,
    );
    return { pushed: 0, skipped: candidates.length, status: "failed" };
  }

  if (!response.ok) {
    getEvent()?.addWarning(
      `moodlog push HTTP ${response.status} for ${userId}`,
    );
    return { pushed: 0, skipped: candidates.length, status: "failed" };
  }

  // Surface MoodLog's per-entry receipt counts so the dashboard
  // admin diagnostic + Wide Event timeline can attribute partial
  // failures correctly (e.g. an unknown tag key dropped on the
  // MoodLog side reports `failed > 0` while imported/updated > 0).
  type PushResult = {
    imported?: number;
    updated?: number;
    failed?: number;
  };
  let result: PushResult | null = null;
  try {
    result = (await response.json()) as PushResult;
  } catch {
    // MoodLog should always return JSON; tolerate the parse failure
    // so a stale upstream doesn't undo the successful HTTP write.
  }

  const imported = result?.imported ?? 0;
  const updated = result?.updated ?? 0;
  const failed = result?.failed ?? 0;
  return {
    pushed: imported + updated,
    skipped: entries.length - candidates.length + failed,
    status: "ok",
  };
}

/**
 * Parse the JSON-encoded `tags` column into an array of key strings.
 * Returns an empty array on null / parse failure so the push body
 * always carries a well-formed `tags: string[]` (or omitted entirely).
 */
function parseTagKeys(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const keys = parsed
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .slice(0, 50);
    return keys.length > 0 ? keys : undefined;
  } catch {
    return undefined;
  }
}
