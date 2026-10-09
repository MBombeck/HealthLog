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
import { Blocks } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { MODULE_ICONS } from "@/components/settings/module-icons";
import { ModuleToggleRow } from "@/components/settings/module-toggle-row";
import { TimelineReadinessSheet } from "@/components/timeline/readiness-sheet.lazy";
import { useAuth } from "@/hooks/use-auth";
import { useAiCapability } from "@/hooks/use-ai-capability";
import {
  useModuleEnabledState,
  useModuleToggle,
} from "@/hooks/use-module-toggle";
import { useTranslations } from "@/lib/i18n/context";
import {
  MODULE_REGISTRY,
  isCodeDisabledModule,
  moduleDelegatesTo,
  type ModuleKey,
} from "@/lib/modules/registry";

export function ModulesSection() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const coach = useAiCapability("coach");
  // v1.42 (#613) — switching the timeline on opens its readiness inventory:
  // an honest look at what it can already show, with one link per gap,
  // before the person goes there. It blocks nothing.
  const [readinessOpen, setReadinessOpen] = useState(false);

  const moduleAvailability = user?.moduleAvailability ?? {};

  const toggle = useModuleToggle({
    onToggled: (vars) => {
      if (vars.key === "timeline" && vars.enabled) setReadinessOpen(true);
    },
  });
  const isEnabled = useModuleEnabledState();

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

            // Enabled-state per key: delegated modules read their canonical
            // per-user state (see `useModuleEnabledState`).
            const enabled = isEnabled(key);

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
