"use client";

import type { ReactNode } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { useAuth } from "@/hooks/use-auth";
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
 * `moduleAccess` carries the reason, so this says it. The action is offered
 * ONLY for the record's own switch: nobody else's state is fixable from here,
 * and an affordance that cannot work is worse than none.
 *
 * Paint, not enforcement. Every route behind a module refuses on its own
 * through the server gate; deleting this file would restore a wall of 403s,
 * not open a door.
 */
const NOTICE_COPY: Record<
  Exclude<ModuleAccessState, "enabled">,
  { title: string; description: string }
> = {
  disabled: {
    title: "moduleOff.disabled.title",
    description: "moduleOff.disabled.description",
  },
  not_granted: {
    title: "moduleOff.notGranted.title",
    description: "moduleOff.notGranted.description",
  },
  unavailable: {
    title: "moduleOff.unavailable.title",
    description: "moduleOff.unavailable.description",
  },
};

export interface ModuleDisabledNoticeProps {
  moduleKey: ModuleKey;
  icon?: ReactNode;
  /**
   * Rendered only when the record's own switch is what is off. A delegate
   * outside the grant and an instance-wide switch both have nothing here the
   * reader can act on.
   */
  action?: ReactNode;
}

export function ModuleDisabledNotice({
  moduleKey,
  icon,
  action,
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

  const copy = NOTICE_COPY[state];
  const moduleName = t(MODULE_REGISTRY[moduleKey].labelKey);

  return (
    <div data-slot="module-disabled-notice" data-module-access={state}>
      <EmptyState
        icon={icon}
        title={t(copy.title, { module: moduleName })}
        description={t(copy.description, { module: moduleName })}
        ctaSize="lg"
        action={state === "disabled" ? action : undefined}
      />
    </div>
  );
}
