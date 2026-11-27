"use client";

/**
 * "Add": everything this server offers that is not set up yet, as two groups
 * of rows, one line each. What the operator has not configured (Telegram off,
 * no mail transport, no document-source origins, the environment module off)
 * is not listed at all. A source that first needs the person's own app
 * credentials stays listed, because entering those credentials is the setup;
 * its sheet says so.
 */
import { ChevronRight } from "lucide-react";

import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { useTranslations } from "@/lib/i18n/context";
import type { IntegrationOverviewItem } from "@/lib/integrations/overview";

import {
  INTEGRATION_BRINGS_KEY,
  INTEGRATION_ICON,
  INTEGRATION_NAME_KEY,
} from "./integration-registry";

export function addableItems(
  items: readonly IntegrationOverviewItem[],
): IntegrationOverviewItem[] {
  return items.filter((item) => !item.setUp && item.offered);
}

export function IntegrationAddSheet({
  items,
  open,
  onOpenChange,
  onPick,
}: {
  items: readonly IntegrationOverviewItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (item: IntegrationOverviewItem) => void;
}) {
  const { t } = useTranslations();
  const addable = addableItems(items);
  const groups = [
    {
      id: "source",
      label: t("settings.integrationList.sources"),
      items: addable.filter((item) => item.group === "source"),
    },
    {
      id: "channel",
      label: t("settings.integrationList.channels"),
      items: addable.filter((item) => item.group === "channel"),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings.integrationList.addTitle")}
      contentWidth="lg"
    >
      <div className="-mx-4 flex flex-col" data-slot="integration-add-sheet">
        {groups.length === 0 ? (
          <div className="px-4">
            <EmptyState
              variant="plain"
              size="compact"
              title={t("settings.integrationList.allAdded")}
            />
          </div>
        ) : (
          groups.map((group) => (
            <section
              key={group.id}
              aria-labelledby={`integration-add-${group.id}`}
            >
              <h3
                id={`integration-add-${group.id}`}
                className="text-muted-foreground px-4 pt-2 pb-2 text-xs font-medium"
              >
                {group.label}
              </h3>
              <ul className="border-t">
                {group.items.map((item) => {
                  const Icon = INTEGRATION_ICON[item.key];
                  return (
                    <li key={item.key} className="border-b">
                      <button
                        type="button"
                        onClick={() => onPick(item)}
                        data-testid={`integration-add-${item.key}`}
                        className="hover:bg-muted/40 focus-visible:ring-ring/50 flex min-h-16 w-full items-center gap-3 px-4 py-2.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
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
                            {t(INTEGRATION_BRINGS_KEY[item.key])}
                          </span>
                        </span>
                        <ChevronRight
                          className="text-muted-foreground size-4 shrink-0"
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </ResponsiveSheet>
  );
}
