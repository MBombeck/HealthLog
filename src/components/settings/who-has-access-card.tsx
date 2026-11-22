"use client";

/**
 * Settings > Data & privacy: every way into the record, in one list.
 *
 * Each door is managed where it lives (other accounts under Shared access,
 * clinician links and the care calendar under Health record, the QR link on
 * the emergency card, tokens and the connector under Connections, signed-in
 * devices under Security). Somebody asking "who can open my record right now"
 * should not have to know eight pages, so this card names each door and links
 * to the place that shows and revokes it. It writes nothing and reads nothing:
 * the counts and states stay on the pages that own them.
 */
import Link from "next/link";
import { ChevronRight, DoorOpen } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { InlineAction } from "@/components/ui/inline-action";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import type { ModuleKey } from "@/lib/modules/registry";

/** The doors, in the order a person thinks of them: people, links, machines. */
export const ACCESS_DOORS: ReadonlyArray<{
  id: string;
  href: string;
  /** Shown only while this module is on. */
  module?: ModuleKey;
}> = [
  { id: "accounts", href: "/settings/access#shared-by-you" },
  { id: "shareLinks", href: "/settings/health-record#sharing" },
  { id: "emergencyCard", href: "/emergency-card" },
  { id: "careCalendar", href: "/settings/health-record#calendar" },
  { id: "cycleCalendar", href: "/cycle?tab=settings", module: "cycle" },
  { id: "apiTokens", href: "/settings/api#api-tokens" },
  { id: "mcp", href: "/settings/mcp#mcp-connections" },
  { id: "sessions", href: "/settings/security#sessions" },
];

export function WhoHasAccessCard() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const k = "settings.privacy.whoHasAccess";
  const doors = ACCESS_DOORS.filter(
    (door) => !door.module || user?.modules?.[door.module] !== false,
  );
  return (
    <SettingsCard data-slot="who-has-access">
      <SettingsCardHeader
        anchor="who-has-access"
        icon={DoorOpen}
        title={t(`${k}.title`)}
        description={t(`${k}.description`)}
      />
      <ul className="divide-border divide-y">
        {doors.map((door) => (
          <li
            key={door.id}
            className="space-y-1 py-3 first:pt-0 last:pb-0"
            data-slot={`who-has-access-${door.id}`}
          >
            <p className="text-sm font-medium">
              {t(`${k}.doors.${door.id}.title`)}
            </p>
            <p className="text-muted-foreground text-xs">
              {t(`${k}.doors.${door.id}.description`)}
            </p>
            <InlineAction asChild tone="muted">
              <Link href={door.href}>
                {t(`${k}.doors.${door.id}.link`)}
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </Link>
            </InlineAction>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}
