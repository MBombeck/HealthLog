"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { ModuleDisabledNotice } from "@/components/layout/module-disabled-notice";
import {
  isNavDestinationActive,
  NAV_DESTINATIONS,
} from "@/components/layout/nav-model";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.39 (C2) — the page of a module that is switched off answers with an
 * empty state that names the switch (design spec §After the flow), in one
 * place for every module page.
 *
 * The setup flow switches modules OFF for a new record — an explicit `false`
 * for every module the answers did not name — and the navigation drops the
 * entry. A person who reaches the page anyway (a bookmark, a link in a
 * report, the tour) used to get the page's own empty state, which said
 * "nothing here yet" about a module that is not there at all. This maps the
 * route to the module through the navigation model's own gate, so a module
 * page and its nav entry can never disagree about which switch they follow,
 * and renders the shared notice with the one action that can help: the
 * Modules settings, offered only when the record's own switch is what is off.
 *
 * Paint, not enforcement: every route behind a module refuses on its own
 * through the server gate. Mounted inside the shell, which renders children
 * only after the account payload resolved, so the map is never read on a
 * hydration render.
 */
export function ModulePageGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const { t } = useTranslations();

  const destination = NAV_DESTINATIONS.find(
    (d) => d.requiresModule && isNavDestinationActive(d.href, pathname),
  );
  const moduleKey = destination?.requiresModule;
  const off = moduleKey !== undefined && user?.modules?.[moduleKey] === false;

  if (!off || !destination || !moduleKey) return <>{children}</>;

  const Icon = destination.icon;
  return (
    <ModuleDisabledNotice
      moduleKey={moduleKey}
      icon={<Icon className="size-6" />}
      action={
        <Button asChild size="sm">
          <Link href="/settings/modules" data-slot="module-off-open-settings">
            {t("moduleOff.openModules")}
          </Link>
        </Button>
      }
    />
  );
}
