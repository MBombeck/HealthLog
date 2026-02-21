import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

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

  // 2. Determine date range
  const now = new Date();
  const to = now.toISOString().slice(0, 10); // YYYY-MM-DD

  let from: string;
  if (opts?.fullSync || !user.moodLogLastSyncedAt) {
    // Full sync: 90 days back
    const d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    from = d.toISOString().slice(0, 10);
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
  const timeout = setTimeout(() => controller.abort(), 15000);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    console.error(
      `[moodlog] Sync failed for user ${userId}: HTTP ${response.status}`,
    );
    return 0;
  }

  const data = await response.json();

  // Validate response has entries array
  if (!data?.entries || !Array.isArray(data.entries)) {
    console.error(`[moodlog] Invalid response format for user ${userId}`);
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
          source: entry.loggedVia ?? "MOODLOG",
        },
        create: {
          userId,
          date,
          mood: entry.mood,
          score: entry.score,
          tags: entry.tags ? JSON.stringify(entry.tags) : null,
          source: entry.loggedVia ?? "MOODLOG",
          moodLoggedAt,
        },
      });
      imported++;
    } catch (err) {
      console.error(`[moodlog] Failed to upsert entry:`, err);
    }
  }

  // 5. Update lastSyncedAt
  await prisma.user.update({
    where: { id: userId },
    data: { moodLogLastSyncedAt: now },
  });

  return imported;
}
