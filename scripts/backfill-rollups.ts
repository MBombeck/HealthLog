/**
 * v1.5.0 — one-shot backfill for `measurement_rollups`.
 *
 * Walks every user and folds their measurement history into the
 * persistent rollup table across all four granularities (DAY, WEEK,
 * MONTH, YEAR). Bounded — one user at a time, no parallel users — so
 * the script never crowds the Prisma pool. Idempotent — re-running it
 * upserts the same rows.
 *
 * Usage
 * -----
 *   pnpm tsx scripts/backfill-rollups.ts
 *   pnpm tsx scripts/backfill-rollups.ts --user <userId>
 *
 * The `--user` flag targets a single user; without it the script
 * iterates every account in the database.
 */
import { prisma } from "@/lib/db";
import {
  ALL_GRANULARITIES,
  recomputeUserRollups,
} from "@/lib/rollups/measurement-rollups";

interface CliOptions {
  userId: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { userId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user" && argv[i + 1]) {
      opts.userId = argv[i + 1];
      i += 1;
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const where = opts.userId ? { id: opts.userId } : {};

  const users = await prisma.user.findMany({
    where,
    select: { id: true, username: true },
    orderBy: { createdAt: "asc" },
  });

  if (users.length === 0) {
    console.log(
      opts.userId
        ? `No user matched id=${opts.userId}`
        : "No users in database — nothing to backfill",
    );
    return;
  }

  console.log(
    `[backfill-rollups] Folding ${users.length} user(s) across ` +
      `${ALL_GRANULARITIES.join(", ")} granularities`,
  );

  let totalRowsUpserted = 0;
  const totalStarted = Date.now();
  for (const [index, user] of users.entries()) {
    const userStarted = Date.now();
    try {
      const { rowsUpserted, durationMs } = await recomputeUserRollups(
        user.id,
        {
          granularities: ALL_GRANULARITIES,
        },
      );
      totalRowsUpserted += rowsUpserted;
      console.log(
        `[${index + 1}/${users.length}] user=${user.username} ` +
          `(${user.id}) rows=${rowsUpserted} duration=${durationMs}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[${index + 1}/${users.length}] user=${user.username} ` +
          `(${user.id}) FAILED after ${Date.now() - userStarted}ms: ${message}`,
      );
    }
  }

  console.log(
    `[backfill-rollups] DONE — ${totalRowsUpserted} rows upserted in ` +
      `${Date.now() - totalStarted}ms across ${users.length} user(s)`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-rollups] fatal error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
