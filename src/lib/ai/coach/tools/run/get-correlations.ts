import { resolveLocaleForUser } from "@/lib/i18n/user-locale";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { getCorrelationsArgsSchema } from "../definitions";
import { readCoachCorrelations } from "../correlations-read";
import { badArgs } from "./shared";
import type { CoachToolResult } from "./types";

export async function getCorrelations(
  userId: string,
  rawArgs: unknown,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getCorrelationsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_correlations", parsed.error);
  // Reads the deterministic FDR discovery + coincident-deviation flag; returns
  // a clean `{ present: false }` when too little paired data exists.
  //
  // No availability probe here, and no window either: a discovered pattern is
  // not a slice of one table — it needs two channels paired over overlapping
  // days, and the reader already reports WHY nothing survived (its own reason
  // code). "No pattern survived the correction" is an honest absence of a
  // finding, not an absence of data, and nothing older would change it.
  // The reader's language, from their stored preference — the executor is
  // reached from the chat loop and from MCP, neither of which carries a request
  // of its own. The notes below are finished sentences; some MCP clients show
  // them to the person verbatim rather than letting the model re-word them.
  const locale = await resolveLocaleForUser(userId);
  // The scan reads 180 days, or the lookback limit when that is shorter.
  const result = await readCoachCorrelations(userId, locale, { reach });
  if (!result.present) {
    return { present: false, reason: result.reason ?? "no_pattern" };
  }
  return {
    present: true,
    data: {
      ...(result.drivers ? { drivers: result.drivers } : {}),
      ...(result.coincident ? { coincident: result.coincident } : {}),
      pairsTested: result.pairsTested,
      windowDays: result.windowDays,
    },
  };
}
