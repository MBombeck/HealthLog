/**
 * The budget of a read that may take several model calls: the first one was
 * reserved when the read was admitted, every further one is reserved on its
 * own before it is sent, and the whole is settled against what the provider
 * reported it spent. Shared by every surface that reads a report in parts
 * (`runOcrReads`), so a long report cannot spend past the budget the route
 * checked once, whichever surface reads it.
 */
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  OPERATOR_COST_CAP,
  reserveBudget,
  USER_PLAN_CAP,
  type BudgetSurface,
} from "@/lib/ai/coach/budget";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import type { OcrMeter } from "@/lib/documents/ocr-read";

import { settleAiRunBudget } from "./store";
import type { AiRunBudget } from "./types";

export interface MeteredReadBudget {
  /** Where the reads count what they cost. */
  meter: OcrMeter;
  /** Reserve the next read; false when the day's budget refuses it. Absent without a reservation. */
  reserveRead: (() => Promise<boolean>) | undefined;
  /** Settle everything reserved against what was spent. */
  settle: (succeeded: boolean) => Promise<void>;
}

/**
 * The meter, the per-read reservation and the settlement for one read.
 *
 * The cap is the one the first read was judged against: by default the
 * owner's (`OPERATOR_COST_CAP` / `USER_PLAN_CAP`) on the interactive surface;
 * a background caller passes its own. A reservation that names no known owner
 * (the params are stored JSON) stops the read rather than taking the larger
 * cap.
 */
export function meteredReadBudget(
  userId: string,
  budget: AiRunBudget | undefined,
  servedBy: ProviderChainType,
  opts: { cap?: number; surface?: BudgetSurface } = {},
): MeteredReadBudget {
  const meter: OcrMeter = { spent: 0, cached: 0 };
  let reserved = budget?.reserved ?? 0;
  const reserveRead = budget
    ? async () => {
        const cap =
          opts.cap ??
          (budget.owner === "operator"
            ? OPERATOR_COST_CAP
            : budget.owner === "user"
              ? USER_PLAN_CAP
              : null);
        if (cap === null) return false;
        const book = (tokens: number) =>
          reserveBudget(
            userId,
            tokens,
            budget.dateKey,
            cap,
            budget.owner,
            opts.surface ?? "coach",
            undefined,
            { countMessage: false },
          );
        // What the reads so far cost beyond what was reserved for them (an
        // image's input, the prompt, a retry) is booked first, net of the
        // cached share as the settlement books it, so the day's counter the
        // next read is judged against never lags behind the spend.
        const behind = Math.max(0, meter.spent - meter.cached - reserved);
        if (behind > 0) {
          const caughtUp = await book(behind);
          if (!caughtUp.allowed) return false;
          reserved += caughtUp.reserved;
        }
        const next = await book(AI_BUDGETS.ocrExtract.maxTokens);
        if (next.allowed) reserved += next.reserved;
        return next.allowed;
      }
    : undefined;
  // Settled against everything reserved, with what the provider reported for
  // every call made, failed reads included: a read that fails after several
  // calls is charged for them, and only what was never spent goes back. A
  // successful read whose provider reported nothing is charged its
  // reservation.
  const settle = (succeeded: boolean) => {
    const spent =
      succeeded && meter.spent <= 0 ? reserved : Math.max(0, meter.spent);
    return settleAiRunBudget(
      userId,
      budget ? { ...budget, reserved } : undefined,
      spent,
      spent > 0 ? servedBy : null,
      spent > 0 ? meter.cached : 0,
    );
  };
  return { meter, reserveRead, settle };
}
