/**
 * The day's token budget for one Coach turn, booked round by round.
 *
 * v1.41 — a turn reserves its first round and the room for its final answer
 * when it starts, then each further round right before that round runs, and
 * settles every round against what it really cost as soon as it returns.
 * A further round the day's ceiling refuses is not an error: the loop answers
 * from the reserve with what it has read (`budget`). What a turn reserved and
 * never used (the final reserve of a turn that answered on its own, a round
 * that failed) is given back when the turn ends.
 *
 * The atomic primitives are the ledger's own (`reserveBudget` /
 * `reconcileSpend` in `coach/budget.ts`); the loop sees only the two
 * callbacks of `RoundSpend`, so it stays free of the database.
 */
import { annotate } from "@/lib/logging/context";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  buildDateKey,
  reserveBudget,
  reconcileSpend,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import type { RoundSpend } from "@/lib/ai/coach/tools/loop";

import type { TurnChain } from "./chain";
import { streamProviderError } from "./sse";

export interface TurnReservation {
  /** Everything reserved at the turn's start: round one plus the final reserve. */
  reserved: number;
  owner: Awaited<ReturnType<typeof reserveBudget>>["owner"];
  dateKey: string;
}

/** The turn's ledger: the loop's two callbacks plus the close-out. */
export interface TurnLedger extends RoundSpend {
  readonly reservation: TurnReservation;
  /**
   * Give back everything still reserved and not settled. Called once the
   * turn is over, whatever way it ended; a second call does nothing.
   */
  close(): Promise<void>;
}

export async function reserveTurnBudget(args: {
  userId: string;
  chain: TurnChain;
  toolMode: boolean;
  /**
   * v1.41 — the first round, estimated from the prompt. Absent on the
   * no-tools path, which reserves one reply.
   */
  firstRound?: number;
  /** v1.41 — the room held back for the final answer (tool path). */
  finalReserve?: number;
}): Promise<
  { ok: true; ledger: TurnLedger } | { ok: false; response: Response }
> {
  const { userId, chain, toolMode } = args;
  // v1.18.7 — atomically RESERVE before the provider call: one upsert
  // increments the day's total and returns it, so concurrent requests cannot
  // all pass the cap. Over-cap → 429 refusal frame, reservation already
  // refunded.
  // v1.21.0 — the ceiling is the operator's cost cap only when the chain
  // egresses through the operator's own key or account; a chain on the
  // person's own plan or key gets the generous user-plan ceiling.
  const dailyCap = resolveDailyCap(chain);
  const reqDateKey = buildDateKey();
  const firstRound = toolMode
    ? Math.max(1, Math.floor(args.firstRound ?? AI_BUDGETS.coach.maxTokens))
    : AI_BUDGETS.coach.maxTokens;
  const finalReserve = toolMode
    ? Math.max(0, Math.floor(args.finalReserve ?? 0))
    : 0;
  const reservation = await reserveBudget(
    userId,
    firstRound + finalReserve,
    reqDateKey,
    dailyCap,
    resolveCostOwner(chain),
    "coach",
  );
  if (!reservation.allowed) {
    // v1.38.19 — say WHICH ceiling refused and WHOSE.
    annotate({
      action: { name: "coach.budget.exceeded" },
      meta: {
        owner: reservation.owner,
        surface: "coach",
        limit: reservation.limit,
        cap: dailyCap,
        totalAfter: reservation.totalAfter,
        operatorAfter: reservation.operatorAfter,
      },
    });
    return {
      ok: false,
      response: streamProviderError({ code: "coach.budget.exceeded" }),
    };
  }
  return {
    ok: true,
    ledger: createTurnLedger({
      userId,
      cap: dailyCap,
      reservation: {
        reserved: reservation.reserved,
        owner: reservation.owner,
        dateKey: reqDateKey,
      },
      firstRound: Math.min(firstRound, reservation.reserved),
      finalReserve: Math.max(0, reservation.reserved - firstRound),
    }),
  };
}

/**
 * The ledger of one turn over a reservation already made. Exported for the
 * tests; the pipeline gets it from `reserveTurnBudget`.
 */
export function createTurnLedger(args: {
  userId: string;
  cap: number;
  reservation: TurnReservation;
  firstRound: number;
  finalReserve: number;
}): TurnLedger {
  const { userId, reservation } = args;
  // Reservations not settled yet, oldest first; the final reserve apart.
  const open: number[] = [args.firstRound];
  let finalHeld = args.finalReserve;
  let closed = false;

  const settle = (
    reserved: number,
    actual: number,
    cached: number,
    servedBy: ProviderChainType | null,
  ) =>
    reconcileSpend(userId, reserved, actual, reservation.dateKey, cached, {
      servedBy,
      reservedOwner: reservation.owner,
    }).catch(() => {
      // Ledger reconcile is best-effort; a failure leaves the conservative
      // reservation in place (never an undercount) and never breaks the turn.
    });

  return {
    reservation,
    async reserveRound(estimate) {
      if (closed) return false;
      try {
        const next = await reserveBudget(
          userId,
          estimate,
          reservation.dateKey,
          args.cap,
          reservation.owner,
          "coach",
          undefined,
          { countMessage: false },
        );
        if (!next.allowed) {
          annotate({
            action: { name: "coach.budget.round_refused" },
            meta: {
              owner: next.owner,
              limit: next.limit,
              cap: args.cap,
              round: open.length + 1,
            },
          });
          return false;
        }
        open.push(next.reserved);
        return true;
      } catch {
        // An unreadable ledger answers from the reserve, never runs unbooked.
        return false;
      }
    },
    async settleRound({ tokens, cachedTokens, servedBy, final }) {
      if (closed) return;
      let portion: number;
      if (final) {
        portion = finalHeld;
        finalHeld = 0;
      } else {
        portion = open.shift() ?? 0;
      }
      await settle(portion, tokens, cachedTokens, servedBy);
    },
    async close() {
      if (closed) return;
      closed = true;
      const unused = open.reduce((sum, n) => sum + n, 0) + finalHeld;
      open.length = 0;
      finalHeld = 0;
      if (unused > 0) await settle(unused, 0, 0, null);
    },
  };
}
