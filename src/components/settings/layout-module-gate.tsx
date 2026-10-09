"use client";

import * as React from "react";
import Link from "next/link";

import { ModuleDisabledNotice } from "@/components/layout/module-disabled-notice";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import type { ModuleKey } from "@/lib/modules/registry";

/**
 * Client gate for a Layout subpage (`/settings/layout/<module>`).
 *
 * The subpage is a real URL a person can land on (a bookmark, the hub's own
 * link, a link somebody sent) with its module switched off. It answers in
 * place with the module notice, like every module page (`ModulePageGate`),
 * rather than bouncing to the hub, which dropped the reader somewhere else
 * without saying why. The notice names the reason from `moduleAccess` and
 * offers Settings, Modules only when the record's own switch is off.
 *
 * Fails OPEN and is hydration-stable: `useMounted()` is `false` during SSR
 * and the first client paint, so the first render always shows the section
 * (matching the server HTML); the module check applies once, after
 * hydration, as an ordinary client update.
 *
 * Groups the surface map gives no owner (dashboard / insights / vorsorge)
 * pass `moduleKey={undefined}` and always render.
 */
export function LayoutModuleGate({
  moduleKey,
  children,
}: {
  moduleKey?: ModuleKey;
  children: React.ReactNode;
}) {
  const hydrated = useMounted();
  const { user } = useAuth();
  const { t } = useTranslations();

  const disabled =
    hydrated && moduleKey !== undefined && user?.modules?.[moduleKey] === false;

  if (!disabled || moduleKey === undefined) return <>{children}</>;
  return (
    <ModuleDisabledNotice
      moduleKey={moduleKey}
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
