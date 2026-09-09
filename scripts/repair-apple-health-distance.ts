/**
 * scripts/repair-apple-health-distance.ts — operator repair for walking
 * distances the `export.zip` import stored 1000x too small (issue #944).
 *
 * THE DEFECT (fixed in code from this release): the `<Record>` mapping read
 * the value but never the record's own `unit` attribute, so a walking-distance
 * record Apple writes in the account's display unit (`km` on a metric archive,
 * `mi` on an imperial one) was folded into the day's total as if the number
 * were already metres. Ten years of history read as a couple of metres a day.
 *
 * WHICH ROWS: only the ones carrying the stamp the archive importer writes —
 * `WALKING_RUNNING_DISTANCE` + `APPLE_HEALTH` + provenance
 * `EXPORT_XML_SOURCE_MAX` + a `stats:HKQuantityTypeIdentifierDistanceWalking-
 * Running:<day>` externalId. Never a guess from "the value looks small". Rows
 * a native iOS sync has since overwritten carry `HEALTHKIT_STATISTICS` and are
 * correct; rows whose provenance cannot prove an archive origin are left alone.
 *
 * If the account still has its `export.zip`, RE-IMPORTING it on the fixed build
 * is the authoritative repair — the fold UPSERTs the same `stats:` rows with
 * the right numbers. This script is for the accounts that no longer have it.
 *
 * SAFETY:
 *   - Dry-run by DEFAULT: lists the candidate rows per account and exits.
 *   - `--apply` writes, one transaction per account, and records an audit row
 *     in that same transaction. An account carrying that row is skipped, so a
 *     second run finds nothing.
 *   - A row whose repaired value would leave the plausibility range refuses
 *     the WHOLE account: one such row is evidence the rows are not the 1000x
 *     class (an account re-imported on the fixed build looks exactly like
 *     this), and its rest days would otherwise be multiplied again.
 *   - `--unit=mi` for an imperial archive (default `km`). The stored row keeps
 *     no record of the archive's unit — that is the defect — so the operator
 *     names it; a mismatched unit is why the flag exists rather than a guess.
 *
 * RUN (never `pnpm tsx` — the standalone image strips tsx):
 *   pnpm dlx tsx scripts/repair-apple-health-distance.ts                # dry run
 *   pnpm dlx tsx scripts/repair-apple-health-distance.ts --apply
 *   pnpm dlx tsx scripts/repair-apple-health-distance.ts --unit=mi --apply
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import {
  applyAppleHealthDistanceRepair,
  parseArchiveUnit,
  planAppleHealthDistanceRepair,
  repairFactorFor,
} from "@/lib/measurements/repair-apple-health-distance";

function readArchiveUnit(): "km" | "mi" {
  const flag = process.argv.find((arg) => arg.startsWith("--unit="));
  if (!flag) return "km";
  const parsed = parseArchiveUnit(flag.slice("--unit=".length));
  if (!parsed) {
    throw new Error(`Unsupported --unit value: ${flag}. Use km or mi.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const archiveUnit = readArchiveUnit();
  const factor = repairFactorFor(archiveUnit);

  const plans = await planAppleHealthDistanceRepair(prisma, { archiveUnit });
  if (plans.length === 0) {
    console.log(
      "No export-imported walking-distance rows found — nothing to repair.",
    );
    return;
  }

  console.log(
    `Archive unit ${archiveUnit} (x${factor} to metres). ` +
      `${plans.length} account(s) carry export-imported walking distances.\n`,
  );

  let totalRepairable = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let refused = 0;

  for (const plan of plans) {
    if (plan.alreadyRepairedAt) {
      console.log(
        `  • ${plan.userId}: already repaired on ` +
          `${plan.alreadyRepairedAt.toISOString()} — ${plan.candidateCount} row(s) left alone.`,
      );
      continue;
    }

    totalRepairable += plan.repairable.length;
    const first = plan.repairable[0];
    const last = plan.repairable[plan.repairable.length - 1];
    console.log(
      `  • ${plan.userId}: ${plan.repairable.length} row(s)` +
        (first && last
          ? ` from ${first.measuredAt.toISOString().slice(0, 10)} to ` +
            `${last.measuredAt.toISOString().slice(0, 10)}`
          : "") +
        (plan.outOfRange.length > 0
          ? `, ${plan.outOfRange.length} out of plausible range (skipped)`
          : ""),
    );
    if (first) {
      console.log(
        `      e.g. ${first.id}: ${first.value} m -> ${first.value * factor} m`,
      );
    }
    for (const row of plan.outOfRange) {
      console.log(
        `      ! ${row.id} (${row.measuredAt.toISOString().slice(0, 10)}): ` +
          `${row.value} m x ${factor} leaves the plausible range`,
      );
    }
    if (plan.outOfRange.length > 0) {
      console.log(
        "      ! this account will be REFUSED — see the reason under --apply",
      );
    }

    if (!apply) continue;
    const outcome = await applyAppleHealthDistanceRepair(prisma, plan, {
      archiveUnit,
    });
    totalUpdated += outcome.updated;
    totalSkipped += outcome.skipped;
    if (outcome.refusedReason) {
      refused += 1;
      console.log(`      ✗ refused: ${outcome.refusedReason}`);
      continue;
    }
    console.log(
      `      ✓ repaired ${outcome.updated} row(s), skipped ${outcome.skipped}`,
    );
  }

  console.log(
    apply
      ? `\nDone. ${totalUpdated} row(s) repaired, ${totalSkipped} skipped, ` +
          `${refused} account(s) refused.`
      : `\nDry run: ${totalRepairable} row(s) would be repaired. ` +
          "Read the worked examples above and decide before re-running with " +
          "--apply.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
