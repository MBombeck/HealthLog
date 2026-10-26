/**
 * Cycle-tracking feature gate.
 *
 * Two gates collapse into one resolved boolean (ios-contract §1):
 *   (a) the per-user `CycleProfile.cycleTrackingEnabled` toggle, and
 *   (b) a gender-derived default when that toggle is NULL.
 *
 * `isCycleEnabled` (`./enabled.ts`) is the per-user (LAYER 2) source of truth. The server
 * gender enum ships UPPERCASE (`"MALE" | "FEMALE" | null`); the gate keys
 * on `"FEMALE"`. A NULL toggle derives `gender === "FEMALE"`; an explicit
 * `true`/`false` overrides the derivation (so a non-FEMALE account can
 * opt in and a FEMALE account can opt out).
 *
 * `isCycleEnabled` is the USER layer only and stays pure: the
 * module foundation's `resolveModuleEnabled` AND-s it with the operator
 * server-wide kill-switch (LAYER 1). Every SERVER-SIDE consumer that wants
 * the fully-resolved decision (routes, the cycle-reminder cron, the coach
 * cycle block, the import accumulator) must go through
 * `isCycleAvailableForUser` / `requireCycleEnabled`, which delegate to
 * `isModuleEnabled(userId, "cycle")` so an operator-off instance suppresses
 * the whole vertical automatically. Clients read `user.modules.cycle`
 * (already AND-ed) rather than the operator-unaware `cycleTrackingEnabled`.
 *
 * NOTE: the gender enum normalisation (adding `OTHER` / lowercasing) is a
 * separate, iOS-blocked decision (migration 0131, reserved). Until that
 * lands, `OTHER` / non-binary accounts gate purely on the explicit
 * `cycleTrackingEnabled = true` opt-in via the Settings toggle.
 */
import { apiError } from "@/lib/api-response";
import { getOrCreateCycleProfile } from "@/lib/cycle/profile";
import { isModuleEnabled } from "@/lib/modules/gate";
import type { CycleProfile } from "@/generated/prisma/client";

/** Wire `errorCode` the iOS retry classifier branches on. */
export const CYCLE_DISABLED_ERROR_CODE = "cycle.disabled";

/**
 * Fully-resolved cycle availability for an account: the per-user toggle
 * (`isCycleEnabled`) AND-ed with the operator server-wide kill-switch
 * (`AppSettings.moduleAvailabilityJson.cycle`). This delegates to the
 * module foundation's `isModuleEnabled(userId, "cycle")`, which routes the
 * `cycle` ModuleKey back through `isCycleEnabled` for the user layer — so
 * there is exactly one source of truth and no duplicated operator logic.
 *
 * Every SERVER-SIDE cycle consumer (the cron, the coach cycle block, the
 * import accumulator) should call this rather than the operator-unaware
 * `isCycleEnabled`, so an operator-disabled instance suppresses the whole
 * vertical automatically.
 */
export function isCycleAvailableForUser(userId: string): Promise<boolean> {
  return isModuleEnabled(userId, "cycle");
}

/**
 * Route-guard outcome: either the resolved profile (enabled) or a ready
 * 403 envelope (disabled) to return verbatim.
 */
export type CycleGateResult =
  | { enabled: true; profile: CycleProfile }
  | { enabled: false; response: Response };

/**
 * Enforce the gate for a `/api/cycle/*` route. Lazily upserts the
 * `CycleProfile` (so the toggle row exists), resolves the FULLY two-layer
 * decision — the per-user toggle (`isCycleEnabled`) AND the operator
 * server-wide kill-switch — and returns a 403 `cycle.disabled` envelope
 * when the account may not write/read cycle data, even with a valid Bearer
 * token. The `gender` argument stays in the signature for call-site
 * symmetry; the resolved decision reads gender through the module gate.
 */
export async function requireCycleEnabled(
  userId: string,
  _gender: string | null | undefined,
): Promise<CycleGateResult> {
  const [profile, available] = await Promise.all([
    getOrCreateCycleProfile(userId),
    isCycleAvailableForUser(userId),
  ]);
  if (!available) {
    return {
      enabled: false,
      response: apiError("Cycle tracking is not enabled", 403, {
        errorCode: CYCLE_DISABLED_ERROR_CODE,
      }),
    };
  }
  return { enabled: true, profile };
}
