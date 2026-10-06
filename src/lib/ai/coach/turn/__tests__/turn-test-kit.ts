/**
 * Stubs the turn pipeline's unit tests share: a ledger that books nothing,
 * the context fields the budget estimate reads, and the v1.41 fields of a
 * model outcome.
 */
import { vi } from "vitest";

import { createActivityRecorder } from "@/lib/ai/coach/activity/recorder";

/** A turn ledger that books nothing and records its calls. */
export function stubLedger() {
  return {
    reservation: { reserved: 0, owner: "user" as const, dateKey: "2026-10-06" },
    reserveRound: vi.fn(async () => true),
    settleRound: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

/** The context fields the first-round estimate reads. */
export const STUB_PROMPT_CONTEXT = {
  systemPrompt: "",
  turnContext: { transcript: "" },
} as const;

/** The v1.41 fields of a successful model outcome, all empty. */
export function modelExtras() {
  return {
    activity: createActivityRecorder({
      emit: () => {},
      screen: { locale: "en", figures: () => [] },
    }),
    toolClarification: null,
    declinedClarifications: [],
    memoryNote: null,
    planProposal: null,
    interimSent: false,
  };
}
