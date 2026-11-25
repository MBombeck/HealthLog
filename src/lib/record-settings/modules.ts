/**
 * v1.39 — the one write path for a record's module state.
 *
 * Two surfaces decide a record's modules and they must not disagree about how
 * the decision is stored. `PATCH /api/record-settings/modules` (v1.38.15) is a
 * guardian switching a managed record's modules by hand; the setup flow's
 * confirm screen derives a map from the answers. Both write the same two
 * places — the record's `modulePreferencesJson` blob and, for the delegated
 * cycle key, the record's own `CycleProfile` column — and both have to
 * invalidate the same cache, because a module toggle adds or removes a Health
 * Score pillar and the cached composite was computed from a composition that
 * no longer holds. That is what lives here, keyed on the RECORD, which is the
 * carrier issue #939 point 2 needs.
 *
 * What deliberately does NOT live here is who may call it. The two callers
 * authenticate differently and that is not an oversight: the record-settings
 * route is a guardian acting on a managed record (`requireGuardianAuth`), and
 * the setup routes are actor-only (`requireAuth()`, which refuses outright
 * under an acting-account switch) until a guardian's route into a managed
 * record's setup arrives with the rest of that record's configuration. A
 * delegable declaration is a reviewed entry in the sharing surface guard, not
 * something a shared write helper may hand out.
 *
 * `PATCH /api/auth/me/modules` is deliberately not routed through here: it is
 * the ACTOR's own record, and its write is guarded on an optimistic-concurrency
 * base token the two record-keyed callers do not carry. Folding it in would
 * mean either dropping that guard or making it a parameter nobody but one
 * caller sets.
 *
 * Nor does the merge: "what the answers imply" and "what a guardian just
 * ticked" are different questions with different rules about what may be
 * overwritten, so each caller computes its own complete map and this writes
 * it. A caller whose map depends on what is stored passes a function of the
 * stored blob instead; it runs under the record's row lock, so a write that
 * overlaps (the profile's own session, a second guardian) cannot be dropped.
 */
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { getOrCreateCycleProfile } from "@/lib/cycle/profile";
import { prisma, toJson } from "@/lib/db";
import { withUserRowLock } from "@/lib/user-row-lock";
import { recomputeSupplementsIfNutrientsTurnedOn } from "@/lib/medications/ingredients/recompute-job";

export interface RecordModuleWrite {
  /** The record whose modules these are — never the actor, under a switch. */
  recordId: string;
  /**
   * The complete map to persist, or a function from the stored blob to it,
   * or undefined to leave the blob alone.
   */
  modulePreferences?:
    Record<string, boolean> | ((stored: unknown) => Record<string, boolean>);
  /**
   * An explicit answer for the delegated cycle key, or undefined to leave the
   * column alone. The blob never owns this key; the profile column does.
   */
  cycleTrackingEnabled?: boolean;
}

/**
 * Persist a record's module state and invalidate what it invalidates.
 *
 * Returns the cycle profile's stored opt-in afterwards (null when the record
 * has no profile row), so a caller that publishes the resolved cycle state can
 * resolve it against the record's sex without a second read, and the module
 * map as written (undefined when the blob was left alone).
 */
export async function writeRecordModulePreferences(
  input: RecordModuleWrite,
): Promise<{
  cycleTrackingEnabled: boolean | null;
  modulePreferences?: Record<string, boolean>;
}> {
  let written: Record<string, boolean> | undefined;
  const next = input.modulePreferences;
  if (next !== undefined) {
    const { before, after } = await withUserRowLock(
      input.recordId,
      async (tx) => {
        const row = await tx.user.findUnique({
          where: { id: input.recordId },
          select: { modulePreferencesJson: true },
        });
        const before = row?.modulePreferencesJson;
        const after = typeof next === "function" ? next(before) : next;
        await tx.user.update({
          where: { id: input.recordId },
          data: { modulePreferencesJson: toJson(after) },
        });
        return { before, after };
      },
    );
    written = after;
    await recomputeSupplementsIfNutrientsTurnedOn(
      input.recordId,
      before,
      after,
    );
  }
  if (input.cycleTrackingEnabled !== undefined) {
    await getOrCreateCycleProfile(input.recordId);
    await prisma.cycleProfile.update({
      where: { userId: input.recordId },
      data: { cycleTrackingEnabled: input.cycleTrackingEnabled },
    });
  }

  const profile = await prisma.cycleProfile.findUnique({
    where: { userId: input.recordId },
    select: { cycleTrackingEnabled: true },
  });

  // A module toggle adds or removes a Health Score pillar, so the cached
  // composite was computed from a composition that no longer holds.
  invalidateUserHealthScore(input.recordId);

  return {
    cycleTrackingEnabled: profile?.cycleTrackingEnabled ?? null,
    ...(written !== undefined ? { modulePreferences: written } : {}),
  };
}
