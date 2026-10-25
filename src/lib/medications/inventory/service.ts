/**
 * v1.4.25 — inventory persistence helpers.
 *
 * Thin layer on top of Prisma that the route handlers compose. Keeps
 * the state-machine math (pure) separate from the I/O (here), so unit
 * tests on the math don't need a DB.
 *
 * v1.16.10 — the per-intake consumption hook moved to
 * `./consumption.ts` (multi-unit, FEFO, spillover, stamped on the
 * intake event); this module keeps the expire cron and the
 * create-input builder.
 */

import { prisma } from "@/lib/db";
import type { MedicationContainerType } from "@/generated/prisma/client";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { computeExpiresAt } from "./state-machine";
import {
  summariseSupply,
  type SupplyItemState,
  type SupplySummary,
} from "./summary";
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";

/**
 * Daily cron pass — flip any IN_USE row whose persisted `expiresAt` has
 * lapsed into EXPIRED. Returns the count of transitions for logging.
 *
 * `expiresAt` is written by `computeExpiresAt`, so the deadline is the
 * printed expiry, the post-opening window, or the earlier of the two —
 * and a container kind with no post-opening clock and no printed expiry
 * carries no `expiresAt` at all, which is exactly how it stays out of
 * this scan.
 *
 * Optionally scoped to a single user — useful for the per-user
 * trigger path. Cron with `userId: null` sweeps every user.
 */
export async function expireStaleInUseItems(input: {
  userId?: string;
  nowMs: number;
}): Promise<number> {
  const { userId, nowMs } = input;
  const now = new Date(nowMs);

  // Candidates: IN_USE rows whose `expiresAt` has lapsed. The
  // selector + state-machine semantics line up here — every row that
  // matches `state = IN_USE AND expiresAt < now` is also a row that
  // `computeInventoryState` would classify EXPIRED (clause 2 or 3),
  // because IN_USE implies `unitsRemaining > 0` (the consumption hook
  // flips an empty container to USED_UP) and the `expiresAt` filter
  // already proves the printed-expiry-or-window deadline has lapsed.
  // EXPIRED rows are already terminal; USED_UP rows are off-window by
  // definition. Use a single `updateMany` instead of one update per
  // row — the daily cron sweep ran N round-trips for nothing.
  const result = await prisma.medicationInventoryItem.updateMany({
    where: {
      state: "IN_USE",
      expiresAt: { lt: now },
      // The cron sweeps every account but one pending deletion, whose record
      // stays as it was; the per-user trigger names its account.
      ...(userId ? { userId } : OWNED_BY_ACTIVE_ACCOUNT),
    },
    data: { state: "EXPIRED" },
  });
  return result.count;
}

/**
 * v1.16.12 (#316) — Prisma serialises a Decimal column to a JSON STRING,
 * but the API contract (and the iOS client) read an inventory item's
 * `unitsTotal` / `unitsRemaining` as numbers. Convert at every response
 * boundary that returns an item, so a fractional remainder (29.5 after a
 * half-tablet dose) lands as a JSON number, never `"29.5"`.
 *
 * v1.18.3 (iOS#31) — serialise a genuinely-unknown unit count as `null`,
 * not `0`. A well-formed row always carries both Decimals, but a corrupt
 * or legacy row could hold null / NaN / Infinity; `Number(null) === 0`
 * (and `Number("x") === NaN`) would otherwise fabricate a misleading `0`
 * that the client decrements into negatives. `null` lets the client
 * render "unbekannt" instead. A real tracked `0` stays `0`.
 */
function toFiniteUnit(value: unknown): number | null {
  // `Number(null) === 0` and `Number("") === 0`, so reject the empty /
  // nullish cases up front — a genuinely-absent count must read as null,
  // not a fabricated 0. Anything else goes through the finiteness gate
  // (NaN / Infinity from a corrupt string also fall to null).
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function serializeInventoryItem<
  T extends { unitsTotal: unknown; unitsRemaining: unknown },
>(
  item: T,
): Omit<T, "unitsTotal" | "unitsRemaining"> & {
  unitsTotal: number | null;
  unitsRemaining: number | null;
} {
  return {
    ...item,
    unitsTotal: toFiniteUnit(item.unitsTotal),
    unitsRemaining: toFiniteUnit(item.unitsRemaining),
  };
}

/**
 * v1.19.0 (iOS#25) — server-authoritative supply summary for the
 * inventory list response. The detail page used to compute the Bestand
 * headline in the browser (calling `summariseSupply` client-side), which
 * both risked web ↔ iOS drift and dragged the shared math into the
 * client bundle. The SERVER now computes the canonical
 * {@link SupplySummary} via the one source of truth (`summariseSupply`)
 * and ships it in the DTO; the client renders the ready figures.
 *
 * The serialized items carry `unitsTotal` / `unitsRemaining` as
 * `number | null` (null = unknown count for a corrupt / legacy row).
 * A null contributes nothing to the available pool — coalesce to 0 for
 * the summary inputs only, exactly as the former client code did, so the
 * surfaced numbers stay identical to today's for healthy data while an
 * unknown-count row still cannot pad the headline.
 */
export function buildSupplySummary(
  items: ReadonlyArray<{
    state: SupplyItemState;
    unitsTotal: number | null;
    unitsRemaining: number | null;
  }>,
  unitsPerDose: number | null | undefined,
): SupplySummary {
  // v1.16.12 — guard at > 0, NOT ≥ 1: a fractional unitsPerDose (½ tablet
  // per dose) must stay fractional, else the dose-derived counts halve.
  const perDose = unitsPerDose && unitsPerDose > 0 ? unitsPerDose : 1;
  return summariseSupply(
    items.map((item) => ({
      state: item.state,
      unitsTotal: item.unitsTotal ?? 0,
      unitsRemaining: item.unitsRemaining ?? 0,
    })),
    perDose,
  );
}

/**
 * Helper for the POST /[medId]/inventory route. Composes the
 * Prisma-create with the computed `expiresAt` so the caller doesn't
 * have to re-derive it.
 */
export function buildCreateInventoryInput(input: {
  userId: string;
  medicationId: string;
  unitsTotal: number;
  containerType: MedicationContainerType;
  printedExpiry: Date | null;
  purchasedAt: Date | null;
  manufacturer: string | null;
  doseStrength: string | null;
  notes: string | null;
}) {
  return {
    userId: input.userId,
    medicationId: input.medicationId,
    state: "ACTIVE" as const,
    containerType: input.containerType,
    unitsTotal: input.unitsTotal,
    unitsRemaining: input.unitsTotal,
    firstUseAt: null,
    printedExpiry: input.printedExpiry,
    purchasedAt: input.purchasedAt,
    // A freshly registered container is unopened, so the only deadline
    // it can carry is the printed one — but pass the kind anyway so the
    // helper stays the single place that decides.
    expiresAt: computeExpiresAt(null, input.printedExpiry, input.containerType),
    manufacturer: input.manufacturer,
    doseStrength: input.doseStrength,
    // Encrypt the free-text note at rest; the plaintext column stays null.
    notesEncrypted: encryptNote(input.notes),
    notes: null,
  };
}
