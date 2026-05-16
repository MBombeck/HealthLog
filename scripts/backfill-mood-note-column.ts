#!/usr/bin/env tsx
/**
 * scripts/backfill-mood-note-column.ts
 *
 * One-shot backfill that lifts existing `tags: ["note:<text>"]`
 * entries out of `mood_entries.tags` into the new `mood_entries.note`
 * column. Operator runs this once after the v1.4.30 schema migration
 * applies.
 *
 * Strategy:
 *   1. SELECT every MoodEntry whose `tags` JSON contains an entry
 *      that begins with `note:`.
 *   2. Decode the JSON array, pull the first `note:<text>` entry as
 *      the new note value, drop the entry from the array.
 *   3. UPDATE the row in a transaction: `note = <decoded text>`,
 *      `tags = <slimmed JSON or null if empty>`.
 *
 * Idempotent — a row whose `tags` no longer carries any `note:`
 * entries is left alone. Re-running on a clean dataset is a no-op.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-mood-note-column.ts             # dry-run
 *   pnpm tsx scripts/backfill-mood-note-column.ts --confirm   # commit
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import { extractNoteAndSlimTags } from "@/lib/mood/note-backfill";

interface ParsedArgs {
  confirm: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { confirm: false };
  for (const arg of argv) {
    if (arg === "--confirm") out.confirm = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: pnpm tsx scripts/backfill-mood-note-column.ts [--confirm]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

interface RowSnapshot {
  id: string;
  tags: string | null;
  note: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !args.confirm;

  if (dryRun) {
    console.log("[backfill-note] DRY RUN — no rows will be written. Pass --confirm to commit.");
  } else {
    console.log("[backfill-note] COMMIT MODE — updating rows in place.");
  }

  // Naive scan: filter in-memory rather than via JSON predicates so
  // the query stays portable across Postgres minor versions. The
  // mood_entries table is small (per-user lifetime budget).
  const candidates: RowSnapshot[] = await prisma.moodEntry.findMany({
    where: {
      tags: { not: null },
      note: null,
    },
    select: { id: true, tags: true, note: true },
  });

  console.log(`[backfill-note] scanned ${candidates.length} candidate rows`);

  let updated = 0;
  for (const row of candidates) {
    if (!row.tags) continue;
    const { note, newTags } = extractNoteAndSlimTags(row.tags);
    if (note === null) continue;

    updated += 1;
    if (!dryRun) {
      await prisma.moodEntry.update({
        where: { id: row.id },
        data: { note, tags: newTags },
      });
    }
  }

  console.log(`[backfill-note] ${updated} row${updated === 1 ? "" : "s"} ${dryRun ? "would be" : "were"} updated`);
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[backfill-note] failed:", err);
  process.exit(1);
});
