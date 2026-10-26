/**
 * What every Coach tool executor shares: the snapshot it slices its block
 * out of, the window under the lookback limit, and the two grounded misses
 * (bad arguments, an empty window read).
 */
import type { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import { DEFAULT_WINDOW } from "@/lib/ai/coach/snapshot-cache";
import {
  clampWindow,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import {
  resolveEmptyRead,
  type CoachAvailabilitySubject,
} from "../availability";
import type { CoachToolResult } from "./types";

export function pickSection(
  sections: Record<string, unknown>,
  key: string,
): unknown | undefined {
  const value = sections[key];
  if (value === undefined || value === null) return undefined;
  return value;
}

/**
 * A tool's window under the lookback limit: whatever the call asks for, it
 * reads no further back than the limit. `undefined` stays undefined (the
 * builder default, 30 days, is inside every limit but the 7-day one, and the
 * builder clamps that itself).
 */
export function limitWindow(
  window: CoachScopeWindow | undefined,
  reach: CoachHistoryReach,
): CoachScopeWindow | undefined {
  return window === undefined ? undefined : clampWindow(window, reach);
}

/**
 * Resolve the scope a tool reads its snapshot under.
 *
 * When the route handed us a `sharedScope` (the full-source
 * inventory build for this turn) AND the tool's effective window matches the
 * shared window, read under the SHARED scope key so the per-tool read lands the
 * 60s LRU hit the inventory already primed (the section it needs is present in
 * the full-source build). Otherwise — no shared scope, or a window override —
 * fall back to the tight per-source scope (a correct, distinct build).
 *
 * The window default chain is unchanged: `args.window` wins, else the
 * conversation's `fallbackWindow`, else the builder default.
 */
export function scopeFor(
  sources: CoachScope["sources"],
  window: CoachScopeWindow | undefined,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): CoachScope {
  const effectiveWindow = limitWindow(window ?? fallbackWindow, reach);
  if (sharedScope && sharedScope.window === effectiveWindow) {
    // Same window as the inventory's full-source build → reuse its cache entry.
    return sharedScope;
  }
  return {
    sources,
    window: effectiveWindow,
  };
}

/**
 * The snapshot a tool slices its block(s) out of.
 *
 * Reads under `scopeFor` first, which lands on the turn's shared full-source
 * build when the windows match. That build is cut to the prompt budget for a
 * prompt this read never sends: on an account with many synced series the
 * budget pass collapses whole blocks to an `{ omitted }` marker, and slicing
 * the marker out answered `present: true` with no figure in it. So when a
 * block this read needs was cut there, it is read again from its own sources
 * at the same window, where it is the block that was asked for.
 */
export async function readToolSnapshot(
  userId: string,
  sources: CoachScope["sources"],
  sectionKeys: ReadonlyArray<string>,
  window: CoachScopeWindow | undefined,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
) {
  const scope = scopeFor(sources, window, fallbackWindow, sharedScope, reach);
  if (scope !== sharedScope) {
    return buildCoachSnapshot(userId, scope, {
      reach,
      condenseRequested: true,
    });
  }
  const snapshot = await buildCoachSnapshot(userId, scope, { reach });
  const cut = sectionKeys.filter((key) =>
    snapshot.degradedBlocks?.includes(key),
  );
  if (cut.length === 0) return snapshot;
  annotate({
    action: { name: "coach.tool.shared_block_cut" },
    meta: { blocks: cut, window: scope.window ?? DEFAULT_WINDOW },
  });
  return buildCoachSnapshot(
    userId,
    { sources, window: scope.window },
    { reach, condenseRequested: true },
  );
}

export function badArgs(name: string, error: z.ZodError): CoachToolResult {
  annotate({
    action: { name: "coach.tool.bad_arguments" },
    meta: { tool: name, reason: "schema", issues: error.issues.length },
  });
  return { present: false, reason: "invalid_arguments" };
}

/**
 * The one exit for "the window read produced no section". Never returns a bare
 * `no_data` without the probe having confirmed the record is empty — see
 * `availability.ts` for the four states it can resolve to.
 */
export function emptyRead(
  userId: string,
  domain: string,
  subject: CoachAvailabilitySubject | null,
  searchedWindow: CoachScopeWindow | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  return resolveEmptyRead({ userId, domain, subject, searchedWindow, reach });
}
