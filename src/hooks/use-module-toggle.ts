"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { apiPatch } from "@/lib/api/api-fetch";
import {
  isConflict,
  readUpdatedAtToken,
  withBaseToken,
} from "@/lib/api/optimistic-token";
import { useTranslations } from "@/lib/i18n/context";
import { moduleDelegatesTo, type ModuleKey } from "@/lib/modules/registry";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";

/** Shape of the `/api/auth/me/modules` PATCH response (resolved map + token). */
type ModulesPatchResult = {
  modules: Partial<Record<ModuleKey, boolean>>;
  updatedAt?: string;
};

export interface ModuleToggleVars {
  key: ModuleKey;
  enabled: boolean;
}

/**
 * Switching a module on or off for one's own record: the one mutation the
 * Settings → Modules hub and the command palette share.
 *
 * Most modules PATCH `/api/auth/me/modules` (a DISABLED allowlist; the
 * endpoint refuses core keys). The two delegated modules drive their
 * canonical column instead — coach → `PATCH /api/auth/me/disable-coach`
 * (`User.disableCoach`, inverted), cycle → `PATCH /api/auth/me/cycle-prefs`
 * (`cycleTrackingEnabled`) — so there is exactly one source of truth. Every
 * path then invalidates what reads the module map, so the nav, Insights
 * pills and dashboard tiles re-gate live.
 */
export function useModuleToggle(options?: {
  onToggled?: (vars: ModuleToggleVars) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  return useMutation({
    // Factory-routed; the in-repo eslint rule forbids a bare literal here.
    mutationKey: queryKeys.modulesPrefs(),
    mutationFn: async (vars: ModuleToggleVars) => {
      const delegate = moduleDelegatesTo(vars.key);
      if (delegate === "coach") {
        // The stored column is `disableCoach` — the inverse of "on".
        return apiPatch("/api/auth/me/disable-coach", {
          disableCoach: !vars.enabled,
        });
      }
      if (delegate === "cycle") {
        // `enabled` maps straight onto `cycleTrackingEnabled`.
        return apiPatch("/api/auth/me/cycle-prefs", { enabled: vars.enabled });
      }
      // DISABLED allowlist: send only the single key the user flipped.
      //
      // v1.32.22 (R5b) — echo the optimistic-concurrency token so an
      // interleaved modules PATCH (another tab, the iOS client) 409s instead of
      // clobbering. The token rides on `User.updatedAt`; the module map itself
      // rides on `/auth/me`, and no dedicated GET populates the token, so it is
      // seeded from each write response below and read back here at mutate
      // time. The first write of a session is tokenless — the server's
      // backward-compatible unconditional arm.
      const result = await apiPatch<ModulesPatchResult>(
        "/api/auth/me/modules",
        withBaseToken(
          { [vars.key]: vars.enabled },
          readUpdatedAtToken(queryClient, queryKeys.modulesPrefs()),
        ),
      );
      queryClient.setQueryData<{ updatedAt?: string }>(
        queryKeys.modulesPrefs(),
        { updatedAt: result.updatedAt },
      );
      return result;
    },
    onSuccess: (_data, vars) => {
      // The module map is also an input of the AI capability answer.
      void invalidateKeys(queryClient, aiInputDependentKeys);
      if (moduleDelegatesTo(vars.key) === "cycle") {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.cyclePrefs(),
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.cycle() });
      }
      toast.success(t("settings.sections.modules.saved"));
      options?.onToggled?.(vars);
    },
    onError: (err) => {
      // v1.32.22 (R5b) — a 409 means the module map advanced since this
      // switch was based (another tab / the iOS client wrote in between).
      // Drop the now-stale seeded token and refetch /auth/me so the switch
      // snaps back to server truth, then nudge — nothing was clobbered.
      if (isConflict(err)) {
        queryClient.removeQueries({ queryKey: queryKeys.modulesPrefs() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
        toast.message(t("common.conflictReloaded"));
        return;
      }
      toast.error(t("settings.sections.modules.error"));
    },
  });
}

/**
 * Whether a module reads as on for this account, the way the Modules hub
 * shows it: coach from `!disableCoach`, cycle from `cycleTrackingEnabled`,
 * every other module default-on unless explicitly `false`.
 */
export function useModuleEnabledState(): (key: ModuleKey) => boolean {
  const { user } = useAuth();
  const modules = user?.modules ?? {};
  return (key) => {
    const delegate = moduleDelegatesTo(key);
    if (delegate === "coach") return !(user?.disableCoach ?? false);
    if (delegate === "cycle") return user?.cycleTrackingEnabled ?? false;
    return modules[key] !== false;
  };
}
