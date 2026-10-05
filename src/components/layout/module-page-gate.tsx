"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { ModuleDisabledNotice } from "@/components/layout/module-disabled-notice";
import {
  isNavDestinationActive,
  NAV_DESTINATIONS,
  navDestinationModule,
} from "@/components/layout/nav-model";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import type { ModuleKey } from "@/lib/modules/registry";
import { surfaceModule } from "@/lib/modules/surface";

const INSIGHTS_PREFIX = "/insights/";

/**
 * Pages that hold the person's own stored records under a module's nav entry.
 * They stay reachable with the module off and turn read-only on their own, so
 * a record can always be read and erased; the gate does not replace them.
 */
const STORED_RECORD_PAGES: ReadonlyArray<string> = [
  "/coach/plans",
  "/coach/conversations",
];

function isStoredRecordPage(pathname: string): boolean {
  return STORED_RECORD_PAGES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * The module that owns the page at `pathname`, from the one surface map.
 *
 * An Insights sub-page answers by its slug (`insights-page:<slug>`), so
 * `/insights/mood` and `/insights/workouts/<id>` follow their own module while
 * `/insights` itself follows none. Every other page answers through the nav
 * destination it sits under (`nav:<href>`), most specific first. A stored-record
 * page (`/coach/plans`, `/coach/conversations`) follows none either.
 */
export function moduleOwningPath(pathname: string): ModuleKey | undefined {
  if (isStoredRecordPage(pathname)) return undefined;
  if (pathname.startsWith(INSIGHTS_PREFIX)) {
    const slug = pathname.slice(INSIGHTS_PREFIX.length).split("/")[0];
    const owner = surfaceModule(`insights-page:${slug}`);
    if (owner !== undefined) return owner;
  }
  const destination = NAV_DESTINATIONS.find((d) =>
    isNavDestinationActive(d.href, pathname),
  );
  return destination ? navDestinationModule(destination) : undefined;
}

/**
 * The module that owns `pathname` when it is switched off, otherwise
 * undefined. The shell reads it too: a switched-off page renders the
 * notice in the ordinary padded frame.
 */
export function switchedOffModule(
  pathname: string,
  modules: Partial<Record<ModuleKey, boolean>> | null | undefined,
): ModuleKey | undefined {
  const moduleKey = moduleOwningPath(pathname);
  return moduleKey !== undefined && modules?.[moduleKey] === false
    ? moduleKey
    : undefined;
}

/**
 * A page of a module that is switched off answers with an inline notice that
 * names the reason, in one place for every module page: top-level pages
 * (`/mood`, `/labs` …) and Insights sub-pages (`/insights/mood`,
 * `/insights/sleep`, `/insights/medications` …) alike.
 *
 * A person who reaches such a page anyway (a bookmark, a link in a report,
 * the tour) gets the notice rather than a redirect, which would drop where
 * they were, and rather than the page's own error rows, which would say
 * "could not be loaded" about a module that is not there. The notice reads
 * the reason from `moduleAccess` and offers Settings only when the record's
 * own switch is what is off.
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

  const moduleKey = switchedOffModule(pathname, user?.modules);
  if (moduleKey === undefined) return <>{children}</>;

  const destination = NAV_DESTINATIONS.find((d) =>
    isNavDestinationActive(d.href, pathname),
  );
  const Icon = destination?.icon;
  return (
    <ModuleDisabledNotice
      moduleKey={moduleKey}
      icon={Icon ? <Icon className="size-6" /> : undefined}
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
