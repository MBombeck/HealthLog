"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useAuth } from "@/hooks/use-auth";
import { useModuleToggle } from "@/hooks/use-module-toggle";
import { MODULE_REGISTRY, type ModuleKey } from "@/lib/modules/registry";
import type { ModuleAccessState } from "@/lib/sharing/module-disclosure";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The page a person reached for a module that is not there, saying which of
 * the three reasons it is.
 *
 * Modelled on `shared-record-unavailable.tsx`, which solves the same problem
 * one layer over. The difference this file exists for is that "module off"
 * has never been one situation: the record has it switched off, the grant this
 * session is inside does not cover it, or the operator switched it off for the
 * whole instance. The boolean map collapses all three into `false`, so an
 * empty state built on it either says nothing or says something that may be
 * untrue — telling a delegate to go and turn on a switch that is not theirs,
 * or telling an account holder to turn on a module the operator removed.
 *
 * `moduleAccess` carries the reason, so this says it, in the title alone. The
 * one action, "Turn on", is offered ONLY for the record's own switch and
 * flips it in place: nobody else's state is fixable from here, and an
 * affordance that cannot work is worse than none. Every module page, the
 * Insights sub-pages and the layout pages answer with this one form: a title
 * and that button, never the title, a sentence saying it again and a link to
 * Settings.
 *
 * Paint, not enforcement. Every route behind a module refuses on its own
 * through the server gate; deleting this file would restore a wall of 403s,
 * not open a door.
 */
const NOTICE_TITLE: Record<Exclude<ModuleAccessState, "enabled">, string> = {
  disabled: "moduleOff.disabled.title",
  not_granted: "moduleOff.notGranted.title",
  unavailable: "moduleOff.unavailable.title",
};

export interface ModuleDisabledNoticeProps {
  moduleKey: ModuleKey;
  icon?: ReactNode;
}

export function ModuleDisabledNotice({
  moduleKey,
  icon,
}: ModuleDisabledNoticeProps) {
  const { t } = useTranslations();
  const { user } = useAuth();

  // Fall back to the boolean rather than to a guess: a server image that
  // predates the field publishes no reason, and "the record has it off" is the
  // only one of the three that is true for every account on such a server.
  const state: Exclude<ModuleAccessState, "enabled"> =
    user?.moduleAccess?.[moduleKey] &&
    user.moduleAccess[moduleKey] !== "enabled"
      ? (user.moduleAccess[moduleKey] as Exclude<ModuleAccessState, "enabled">)
      : "disabled";

  const moduleName = t(MODULE_REGISTRY[moduleKey].labelKey);

  return (
    <div
      data-slot="module-disabled-notice"
      data-module={moduleKey}
      data-module-access={state}
    >
      <EmptyState
        icon={icon}
        title={t(NOTICE_TITLE[state], { module: moduleName })}
        action={
          state === "disabled" ? (
            <TurnOnButton moduleKey={moduleKey} />
          ) : undefined
        }
      />
    </div>
  );
}

/** Switches the record's own module back on, where the person is. */
function TurnOnButton({ moduleKey }: { moduleKey: ModuleKey }) {
  const { t } = useTranslations();
  const toggle = useModuleToggle();
  return (
    <Button
      size="sm"
      data-slot="module-off-turn-on"
      disabled={toggle.isPending}
      onClick={() => toggle.mutate({ key: moduleKey, enabled: true })}
    >
      {t("moduleOff.turnOn")}
    </Button>
  );
}
