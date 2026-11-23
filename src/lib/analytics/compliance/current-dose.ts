/**
 * The open dose of a medication card (`complianceDisplay.currentDose`),
 * resolved by `dose-state/resolve.ts`. Split out of `display.ts`.
 */
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import {
  legacyDoseStatus,
  resolveDoseState,
  resolveLedgerSlot,
  wireDoseState,
  type ResolvedDose,
  type WireDoseState,
} from "@/lib/medications/dose-state/resolve";
import {
  defaultDoseBand,
  type DoseStatus,
  type DoseCadenceFamily,
} from "./dose-status";

/**
 * The open dose, resolved by `dose-state/resolve.ts`. `status` is the wire
 * value clients read before the resolver (`legacyDoseStatus`); `state` and
 * the instants are the resolved dose, always from the band the minter gives
 * the medication's slot (its stored window included): the trailing ledger's
 * when the dose is already minted, else the forward slot the caller mints.
 * The default band is the fallback only for a dose the minter has no slot
 * for (a rolling cadence's open occurrence).
 */
export interface CurrentDose {
  status: DoseStatus;
  targetAt: Date | null;
  state: WireDoseState | null;
  takenLate: boolean;
  dueAt: Date | null;
  overdueSince: Date | null;
  missedAfter: Date | null;
  lateTakeCounts: boolean;
}

/**
 * The earliest ledger slot still open now (`due` or `overdue`), or null.
 *
 * The cycle's `nextDueAt` walks occurrences from `now` forward, so once a
 * dose's clock time has passed it names the NEXT occurrence even while the
 * passed one is still due or overdue. The ledger holds every slot up to
 * `now` with its band, so the open one is read from there: the current dose
 * is the earliest open slot, before any pending one.
 */
function earliestOpenSlot(
  ledgerRows: DoseHistoryRow[] | undefined,
  now: Date,
): { at: Date; resolved: ResolvedDose } | null {
  let best: { at: Date; resolved: ResolvedDose } | null = null;
  for (const row of ledgerRows ?? []) {
    if (row.kind !== "slot") continue;
    if (best && row.at.getTime() >= best.at.getTime()) continue;
    const resolved = resolveLedgerSlot(row, now);
    if (resolved?.state === "due" || resolved?.state === "overdue") {
      best = { at: row.at, resolved };
    }
  }
  return best;
}

export function currentDoseOf(
  nextDueAt: Date | null,
  now: Date,
  cadence: DoseCadenceFamily,
  ledgerRows?: DoseHistoryRow[],
  /** Mints the slot at an instant the trailing ledger does not reach. */
  forwardSlot?: (at: Date) => DoseHistoryRow | undefined,
): CurrentDose {
  const open = earliestOpenSlot(ledgerRows, now);
  if (open) return fromResolved(open.at, open.resolved);
  if (!nextDueAt) {
    return {
      status: "upcoming",
      targetAt: null,
      state: null,
      takenLate: false,
      dueAt: null,
      overdueSince: null,
      missedAfter: null,
      lateTakeCounts: false,
    };
  }
  const ledgerSlot =
    ledgerRows?.find(
      (row) => row.kind === "slot" && row.at.getTime() === nextDueAt.getTime(),
    ) ?? forwardSlot?.(nextDueAt);
  const resolved =
    (ledgerSlot && resolveLedgerSlot(ledgerSlot, now)) ??
    resolveDoseState(defaultDoseBand(nextDueAt, cadence), null, now);
  return fromResolved(nextDueAt, resolved);
}

function fromResolved(targetAt: Date, resolved: ResolvedDose): CurrentDose {
  return {
    status: legacyDoseStatus(resolved.state),
    targetAt,
    ...wireDoseState(resolved.state),
    dueAt: resolved.dueAt,
    overdueSince: resolved.overdueSince,
    missedAfter: resolved.missedAfter,
    lateTakeCounts: resolved.lateTakeCounts,
  };
}
