/**
 * The open dose of a medication card (`complianceDisplay.currentDose`),
 * resolved by `dose-state/resolve.ts`. Split out of `display.ts`.
 */
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import {
  legacyDoseStatus,
  resolveDoseState,
  resolveLedgerSlot,
  type DoseState,
} from "@/lib/medications/dose-state/resolve";
import {
  defaultDoseBand,
  type DoseStatus,
  type DoseCadenceFamily,
} from "./dose-status";

/**
 * The open dose, resolved by `dose-state/resolve.ts`. `status` is the wire
 * value clients read before the resolver (`legacyDoseStatus`); `state` and
 * the instants are the resolved dose: from the ledger's band when the dose
 * is already minted (due or past), else from the default windows.
 */
export interface CurrentDose {
  status: DoseStatus;
  targetAt: Date | null;
  state: DoseState | null;
  dueAt: Date | null;
  overdueSince: Date | null;
  missedAfter: Date | null;
  lateTakeCounts: boolean;
}

export function currentDoseOf(
  nextDueAt: Date | null,
  now: Date,
  cadence: DoseCadenceFamily,
  ledgerRows?: DoseHistoryRow[],
): CurrentDose {
  if (!nextDueAt) {
    return {
      status: "upcoming",
      targetAt: null,
      state: null,
      dueAt: null,
      overdueSince: null,
      missedAfter: null,
      lateTakeCounts: false,
    };
  }
  const ledgerSlot = ledgerRows?.find(
    (row) => row.kind === "slot" && row.at.getTime() === nextDueAt.getTime(),
  );
  const resolved =
    (ledgerSlot && resolveLedgerSlot(ledgerSlot, now)) ??
    resolveDoseState(defaultDoseBand(nextDueAt, cadence), null, now);
  return {
    status: legacyDoseStatus(resolved.state),
    targetAt: nextDueAt,
    state: resolved.state,
    dueAt: resolved.dueAt,
    overdueSince: resolved.overdueSince,
    missedAfter: resolved.missedAfter,
    lateTakeCounts: resolved.lateTakeCounts,
  };
}
