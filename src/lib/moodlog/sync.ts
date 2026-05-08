import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";
import { isPublicUrl } from "@/lib/validations/notifications";

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

  const controller = new AbortController();
  const timeoutMs = opts?.fullSync ? 60000 : 15000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  const fetchStart = performance.now();
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      // SSRF defence-in-depth: do NOT follow redirects. A public
      // host that 302s to an RFC1918 target would otherwise leak
      // the apiKey to the internal hop.
      redirect: "manual",
    });
  } finally {
    clearTimeout(timeout);
    getEvent()?.addExternalCall({
      service: "moodlog",
      method: "syncMoodLogEntries",
      duration_ms: Math.round(performance.now() - fetchStart),
    });
  }

  // Treat any 3xx as failure (manual redirect mode surfaces them).
  if (response.status >= 300 && response.status < 400) {
    getEvent()?.addWarning(
      `moodLog sync refused redirect for user ${userId}: HTTP ${response.status}`,
    );
    return 0;
  }

  if (!response.ok) {
    getEvent()?.addWarning(
      `Sync failed for user ${userId}: HTTP ${response.status}`,
    );
    return 0;
  }

  const data = await response.json();

  // Validate response has entries array
  if (!data?.entries || !Array.isArray(data.entries)) {
    getEvent()?.addWarning(`Invalid response format for user ${userId}`);
    return 0;
  }

  // 4. Upsert entries (note field is intentionally NOT imported)
  let imported = 0;
  for (const entry of data.entries) {
    try {
      const moodLoggedAt = new Date(entry.time);
      const date = entry.date as string;

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

  // 5. Update lastSyncedAt
  await prisma.user.update({
    where: { id: userId },
    data: { moodLogLastSyncedAt: now },
  });

  return imported;
}
