#!/usr/bin/env tsx
/**
 * scripts/drain-per-sample-cumulative.ts
 *
 * One-shot maintenance tool that collapses pre-Option-A per-sample
 * APPLE_HEALTH cumulative rows into one row per day per cumulative
 * type. See R-A §6 / v1.4.30 §"Cutover sequence".
 *
 * Scope per `CUMULATIVE_HK_TYPES`:
 *   ACTIVITY_STEPS, ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED,
 *   WALKING_RUNNING_DISTANCE, TIME_IN_DAYLIGHT.
 *
 * Idempotent — re-running after a successful drain is a no-op.
 *
 * Usage:
 *   # Dry-run for one user (default; no DB writes):
 *   pnpm tsx scripts/drain-per-sample-cumulative.ts --user clx123
 *
 *   # Commit the drain for one user:
 *   pnpm tsx scripts/drain-per-sample-cumulative.ts --user clx123 --confirm
 *
 *   # Dry-run for every user:
 *   pnpm tsx scripts/drain-per-sample-cumulative.ts --all
 *
 *   # Commit the drain for every user (requires --confirm):
 *   pnpm tsx scripts/drain-per-sample-cumulative.ts --all --confirm
 *
 * Operator runs this once after the iOS TestFlight build adopts
 * `HealthKitStatisticsService.swift`. The drain runs idempotently; a
 * re-run reports zero buckets collapsed.
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import { drainPerSampleCumulative } from "@/lib/measurements/drain-per-sample-cumulative";

interface ParsedArgs {
  userId?: string;
  all: boolean;
  confirm: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { all: false, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user") {
      out.userId = argv[++i];
    } else if (arg === "--all") {
      out.all = true;
    } else if (arg === "--confirm") {
      out.confirm = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: pnpm tsx scripts/drain-per-sample-cumulative.ts [--user <id> | --all] [--confirm]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.userId && !args.all) {
    console.error(
      "Pick a scope: --user <id> (single user) or --all (every user). Default mode is dry-run; pass --confirm to commit.",
    );
    process.exit(2);
  }
  if (args.userId && args.all) {
    console.error("--user and --all are mutually exclusive.");
    process.exit(2);
  }

  const dryRun = !args.confirm;
  if (dryRun) {
    console.log(
      "[drain] DRY RUN — no rows will be written. Pass --confirm to commit.",
    );
  } else {
    console.log("[drain] COMMIT MODE — collapsing rows in place.");
  }

  try {
    const summary = await drainPerSampleCumulative(prisma, {
      userId: args.userId,
      dryRun,
    });

    console.log("[drain] summary:");
    console.log(JSON.stringify(summary.totals, null, 2));
    if (summary.buckets.length > 0) {
      console.log(
        `[drain] first ${Math.min(5, summary.buckets.length)} buckets (of ${summary.buckets.length}):`,
      );
      for (const b of summary.buckets.slice(0, 5)) {
        console.log(
          `  - user=${b.userId} type=${b.type} day=${b.dateKey} samples=${b.perSampleCount} sum=${b.sumValue} extId=${b.externalId}`,
        );
      }
    } else {
      console.log("[drain] no buckets needed collapsing — already at parity.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error("[drain] failed:", err);
  process.exit(1);
});
