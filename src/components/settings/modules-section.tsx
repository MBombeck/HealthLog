"use client";

/**
 * `<ModulesSection>` — Settings → Module ("Was du trackst") hub. v1.18.0.
 *
 * The one place a user decides which secondary domains HealthLog surfaces.
 * Each toggleable module (mood, sleep, glucose, workouts, recovery, labs,
 * achievements, coach, insights, doctor report, cycle) gets a row with an
 * icon, label, one-line description, and a live `<Switch>`. For most modules
 * the switch PATCHes `/api/auth/me/modules` (a DISABLED allowlist; the
 * endpoint refuses core keys). The two delegated modules drive their
 * canonical column instead — coach → `PATCH /api/auth/me/disable-coach`
 * (`User.disableCoach`, inverted), cycle → `PATCH /api/auth/me/cycle-prefs`
 * (`cycleTrackingEnabled`) — so there is exactly one source of truth, and
 * keep a small "manage" deep-link to the fuller settings surface beside the
 * switch. Every path then invalidates `authMe()` (delegated cycle also evicts
 * its own reads) so the nav, Insights pills, and dashboard tiles re-gate live
 * off `useAuth().user.modules`.
 *
 * Operator precedence stays honest: a module the operator turned off
 * server-wide (the module-availability blob, or for the coach row the
 * operator's Coach switch as the `coach` capability reports it) renders a disabled switch + a
 * "disabled server-wide" hint — a per-user toggle could not re-enable it.
 *
 * The three CORE domains (weight, blood pressure, pulse) render as a
 * separate read-only "always on" group — locked switches with a short note —
 * so the always-on measurement engine reads as deliberately fixed, never
 * disableable. Palette stays neutral throughout; this is a calm
 * configuration surface, not an alarm panel. (v1.18.1 D3 — medications
 * graduated to the toggleable group above.)
 *
 * State source is `useAuth().user.modules` (the resolved `/auth/me` map).
 * A module is enabled unless its key is explicitly `false` — default-on.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Activity,
  Award,
  Blocks,
  Brain,
  CalendarHeart,
  Droplet,
  CloudSun,
  Dumbbell,
  FileScan,
  FileText,
  History,
  MessageCircleHeart,
  Leaf,
  Moon,
  Plug,
  Pill,
  Smile,
  Sparkles,
  Syringe,
  TestTube,
  Thermometer,
  type LucideIcon,
} from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ModuleToggleRow } from "@/components/settings/module-toggle-row";
import { TimelineReadinessSheet } from "@/components/timeline/readiness-sheet.lazy";
import { useAuth } from "@/hooks/use-auth";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { useTranslations } from "@/lib/i18n/context";
import { apiPatch } from "@/lib/api/api-fetch";
import {
  readUpdatedAtToken,
  withBaseToken,
  isConflict,
} from "@/lib/api/optimistic-token";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import {
  MODULE_REGISTRY,
  isCodeDisabledModule,
  moduleDelegatesTo,
  type ModuleKey,
} from "@/lib/modules/registry";

/** Shape of the `/api/auth/me/modules` PATCH response (resolved map + token). */
type ModulesPatchResult = {
  modules: Partial<Record<ModuleKey, boolean>>;
  updatedAt?: string;
};

/** Neutral Lucide glyph per toggleable module. */
const MODULE_ICONS: Record<ModuleKey, LucideIcon> = {
  cycle: CalendarHeart,
  mood: Smile,
  sleep: Moon,
  glucose: Droplet,
  workouts: Dumbbell,
  recovery: Activity,
  labs: TestTube,
  illness: Thermometer,
  achievements: Award,
  coach: MessageCircleHeart,
  insights: Sparkles,
  // v1.18.1 (D3) — medications graduated from CORE to a toggleable module.
  medications: Pill,
  doctorReport: FileText,
  // v1.25.0 — the environmental-context module (opt-in weather/daylight feed).
  environment: CloudSun,
  // v1.22.0 — the remote MCP endpoint (opt-in connectivity module).
  mcp: Plug,
  // v1.25.0 (W-DOCS-IN) — inbound clinical documents (opt-in).
  inboundDocuments: FileScan,
  // v1.25.0 — opt-in mental-health screeners (PHQ-9 / GAD-7).
  mentalHealth: Brain,
  // v1.28 — opt-in micronutrient-intake sync (Apple Health day totals).
  nutrients: Leaf,
  // v1.38.0 — the immunization log.
  vaccinations: Syringe,
  // v1.42 — the life timeline (opt-in).
  timeline: History,
};

export function ModulesSection() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const coach = useAiCapability("coach");
  const queryClient = useQueryClient();
  // v1.42 (#613) — switching the timeline on opens its readiness inventory:
  // an honest look at what it can already show, with one link per gap,
  // before the person goes there. It blocks nothing.
  const [readinessOpen, setReadinessOpen] = useState(false);

  const modules = user?.modules ?? {};
  const moduleAvailability = user?.moduleAvailability ?? {};

  const toggle = useMutation({
    // Factory-routed; the in-repo eslint rule forbids a bare literal here.
    mutationKey: queryKeys.modulesPrefs(),
    mutationFn: async (vars: { key: ModuleKey; enabled: boolean }) => {
      // The delegated modules keep a single source of truth: their switch
      // drives the canonical column, not the `modulePreferencesJson`
      // allowlist (the gate ignores the blob for these two keys). Reuse the
      // existing per-column endpoints rather than inventing a new one.
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
      // Re-gate every surface that reads the module map off /auth/me: nav,
      // Insights pills, dashboard tiles, quick-add, search. The two delegated
      // keys also feed dedicated settings surfaces, so evict their reads too
      // (mirrors the canonical Coach / cycle cards' own invalidation).
      // The module map is also an input of the AI capability answer.
      void invalidateKeys(queryClient, aiInputDependentKeys);
      if (moduleDelegatesTo(vars.key) === "cycle") {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.cyclePrefs(),
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.cycle() });
      }
      toast.success(t("settings.sections.modules.saved"));
      if (vars.key === "timeline" && vars.enabled) setReadinessOpen(true);
    },
    onError: (err) => {
      // v1.32.22 (R5b) — instant-write disposition: a 409 means the module map
      // advanced since this switch was based (another tab / the iOS client
      // wrote in between). Drop the now-stale seeded token and refetch /auth/me
      // so the switch snaps back to server truth, then nudge — nothing was
      // clobbered. A retry re-seeds a fresh token from its own response.
      if (isConflict(err)) {
        queryClient.removeQueries({ queryKey: queryKeys.modulesPrefs() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
        toast.message(t("common.conflictReloaded"));
        return;
      }
      toast.error(t("settings.sections.modules.error"));
    },
  });

  // v1.18.6 (W9) — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` (the former muted-`<p>` intro folded into the
  // frame's standard subtitle). The "Module immer aktiv" core-domains card
  // was removed: a domain that can't be turned off doesn't need to be listed.
  return (
    <SettingsCard>
      {/* The "what this section does" hint rides the header's standard
          description slot; the body follows on the card's gap-based
          header→content rhythm instead of the former mb-2/mb-3 one-offs. */}
      <SettingsCardHeader
        icon={Blocks}
        title={t("settings.sections.modules.toggleable.title")}
        description={t("settings.sections.modules.toggleable.description")}
      />
      <div className="divide-border divide-y">
        {(Object.keys(MODULE_REGISTRY) as ModuleKey[])
          // Modules switched off in code (pending a rebuild) carry no live
          // toggle — drop the row entirely so a user can't turn one on.
          .filter((key) => !isCodeDisabledModule(key))
          .map((key) => {
            const def = MODULE_REGISTRY[key];
            const delegate = moduleDelegatesTo(key);

            // Enabled-state per key. Delegated modules read their canonical
            // per-user state, NOT the `modulePreferencesJson` allowlist the
            // gate ignores for them: coach ← `!disableCoach`, cycle ← the
            // resolved `cycleTrackingEnabled`. Every other module is
            // default-on unless explicitly `false`.
            let enabled: boolean;
            if (delegate === "coach") {
              enabled = !(user?.disableCoach ?? false);
            } else if (delegate === "cycle") {
              enabled = user?.cycleTrackingEnabled ?? false;
            } else {
              enabled = modules[key] !== false;
            }

            // Operator precedence. A per-user toggle can never re-enable a
            // module the operator turned off server-wide, so the switch goes
            // disabled + hint. For coach the operator layer is the
            // operator's Coach switch, read from the resolved `coach`
            // capability (`operator_disabled`, master applied); for cycle
            // and the owned modules it is the module-availability blob.
            const operatorAvailable =
              delegate === "coach"
                ? coach.reason !== "operator_disabled"
                : moduleAvailability[key] !== false;
            const disabledReason = operatorAvailable
              ? undefined
              : t("settings.sections.modules.operatorDisabled");

            // Delegated modules carry more than on/off at their canonical
            // surface (Coach cadence/memory; cycle goal/predictions/lengths),
            // so keep a small deep-link to it beside the live switch.
            const manageLink =
              delegate !== undefined && def.managedAt
                ? {
                    href: def.managedAt.href,
                    label: t("settings.sections.modules.manageIn", {
                      section: t(def.managedAt.labelKey),
                    }),
                  }
                : undefined;

            return (
              <ModuleToggleRow
                key={key}
                moduleKey={key}
                icon={MODULE_ICONS[key]}
                label={t(def.labelKey)}
                description={t(def.descriptionKey)}
                enabled={enabled}
                pending={toggle.isPending}
                manageLink={manageLink}
                disabledReason={disabledReason}
                onToggle={(next) => toggle.mutate({ key, enabled: next })}
              />
            );
          })}
      </div>
      <TimelineReadinessSheet
        open={readinessOpen}
        onOpenChange={setReadinessOpen}
      />
    </SettingsCard>
  );
}
