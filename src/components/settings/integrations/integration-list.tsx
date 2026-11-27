"use client";

/**
 * The rows of Settings → Integrations: one card for the data sources, one for
 * the delivery channels, and in each only what is set up. A row is the whole
 * button: icon, name, one meta line (when it last worked, or why not), the
 * status chip and a chevron. Tapping opens the integration's sheet.
 *
 * The status word and the reason come from the server as they are; the row
 * only chooses which of the two meta lines to show: when it last worked for an
 * active row, the reason for any other.
 */
import { ChevronRight, type LucideIcon } from "lucide-react";

import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { StatusChip } from "@/components/ui/status-chip";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { IntegrationOverviewItem } from "@/lib/integrations/overview";

import { formatHealthInstant } from "./integration-health-copy";
import {
  INTEGRATION_ICON,
  INTEGRATION_NAME_KEY,
  INTEGRATION_REASON_KEY,
} from "./integration-registry";

/** The one meta line of a set-up row. */
export function useRowMeta(): (item: IntegrationOverviewItem) => string {
  const { t } = useTranslations();
  const fmt = useFormatters();
  return (item) => {
    if (item.status !== "active" && item.reason) {
      return t(INTEGRATION_REASON_KEY[item.reason]);
    }
    if (item.lastAt) {
      return t("settings.integrationList.lastAt", {
        when: formatHealthInstant(item.lastAt, t, fmt),
      });
    }
    return item.reason
      ? t(INTEGRATION_REASON_KEY[item.reason])
      : t("settings.integrationList.never");
  };
}

export function IntegrationListCard({
  icon,
  title,
  anchor,
  items,
  onOpen,
  empty,
}: {
  icon: LucideIcon;
  title: string;
  anchor: string;
  items: IntegrationOverviewItem[];
  onOpen: (item: IntegrationOverviewItem) => void;
  /** Shown when nothing in this group is set up. */
  empty: React.ReactNode;
}) {
  return (
    <SettingsCard
      flush
      id={anchor}
      className="scroll-mt-28"
      data-slot="integration-list"
      data-group={anchor}
    >
      <div className="px-4 py-4 md:px-6">
        <SettingsCardHeader icon={icon} title={title} />
      </div>
      {items.length === 0 ? (
        <div className="border-t px-4 py-4 md:px-6">{empty}</div>
      ) : (
        <ul className="border-t">
          {items.map((item) => (
            <li key={item.key} className="border-b last:border-b-0">
              <IntegrationRow item={item} onOpen={() => onOpen(item)} />
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

function IntegrationRow({
  item,
  onOpen,
}: {
  item: IntegrationOverviewItem;
  onOpen: () => void;
}) {
  const { t } = useTranslations();
  const meta = useRowMeta();
  const Icon = INTEGRATION_ICON[item.key];
  return (
    <button
      type="button"
      onClick={onOpen}
      data-slot="integration-row"
      data-integration={item.key}
      data-status={item.status ?? "none"}
      data-testid={`integration-row-${item.key}`}
      className="hover:bg-muted/40 focus-visible:ring-ring/50 flex min-h-16 w-full items-center gap-3 px-4 py-2.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset md:px-6"
    >
      <Icon
        className="text-muted-foreground size-5 shrink-0"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {t(INTEGRATION_NAME_KEY[item.key])}
        </span>
        <span className="text-muted-foreground block truncate text-sm">
          {meta(item)}
        </span>
      </span>
      {item.status ? <StatusChip tone={item.status} /> : null}
      <ChevronRight
        className="text-muted-foreground size-4 shrink-0"
        aria-hidden="true"
      />
    </button>
  );
}
