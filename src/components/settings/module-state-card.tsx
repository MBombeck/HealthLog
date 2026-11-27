"use client";

/**
 * A module's on/off state, shown where the module is configured, with a link
 * to the one switch in Settings > Modules.
 *
 * The Coach and the MCP connector each had a second switch on their own page
 * beside the one in Modules: two controls for one state, and a person who
 * flipped one never knew the other existed. The switch stays in Modules (the
 * row carries `id="module-<key>"`); the module's page says what the state is
 * and where to change it.
 */

import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { useTranslations } from "@/lib/i18n/context";
import type { ModuleKey } from "@/lib/modules/registry";

export function ModuleStateCard({
  moduleKey,
  enabled,
  icon,
  title,
  description,
  anchor,
  slot,
  children,
}: {
  moduleKey: ModuleKey;
  enabled: boolean;
  icon: LucideIcon;
  title: string;
  /** Only for a module whose state is a caution (data leaves the server). */
  description?: string;
  anchor: string;
  slot: string;
  /** Body copy between the header and the link, e.g. what "off" keeps. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <SettingsCard data-slot={slot} data-enabled={enabled ? "true" : "false"}>
      <SettingsCardHeader
        anchor={anchor}
        icon={icon}
        title={title}
        description={description}
        status={<StatusChip tone={enabled ? "active" : "off"} />}
      />
      {children}
      <SettingsCardActions>
        <Button asChild variant="outline" size="sm">
          <Link href={`/settings/modules#module-${moduleKey}`}>
            {t("settings.moduleState.change")}
            <ChevronRight className="size-4" aria-hidden="true" />
          </Link>
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
