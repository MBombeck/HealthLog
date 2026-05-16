/**
 * v1.4.30 — pure helper for the `MoodEntry.note` backfill (R-E H-5).
 *
 * Pulls the first `note:<text>` entry out of a JSON-encoded tags array
 * and returns the cleaned tags JSON alongside the extracted note. Used
 * by `scripts/backfill-mood-note-column.ts` (CLI) — kept in `src/lib/`
 * so unit tests can exercise the bucketing without booting `dotenv`
 * + the Prisma client.
 */
export function extractNoteAndSlimTags(tagsJson: string): {
  note: string | null;
  newTags: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tagsJson);
  } catch {
    return { note: null, newTags: tagsJson };
  }
  if (!Array.isArray(parsed)) {
    return { note: null, newTags: tagsJson };
  }
  let extracted: string | null = null;
  const remaining: string[] = [];
  for (const tag of parsed) {
    if (typeof tag !== "string") {
      remaining.push(String(tag));
      continue;
    }
    if (extracted === null && tag.startsWith("note:")) {
      extracted = tag.slice("note:".length);
    } else {
      remaining.push(tag);
    }
  }
  return {
    note: extracted,
    newTags: remaining.length > 0 ? JSON.stringify(remaining) : null,
  };
}
