"use client";

import { useId } from "react";

import { SwitchRow } from "@/components/ui/switch-row";
import { OPTIONAL_ASK_KINDS } from "@/lib/daily/ask-intents";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import type { DashboardLayout } from "@/lib/dashboard-layout";
import { useTranslations } from "@/lib/i18n/context";

import { HERO_ITEM_LABEL_KEYS } from "./layout-model";
import type { DashboardLayoutDraft } from "./use-dashboard-layout-draft";

/**
 * The top of the start page: whether the score row shows, and which
 * categories may ask in the ask card. One switch per optional category
 * (`OPTIONAL_ASK_KINDS`); a dose past its time and the admin's setup and
 * consent questions always ask, and the note under the switches says so.
 * Stored as the layout's `enabledHeroItemKinds`, which the server's ask
 * policy reads, so the app follows the same switches.
 */
export function HeroSettingsFieldset({
  layout,
  draft,
}: {
  layout: DashboardLayout;
  draft: DashboardLayoutDraft;
}) {
  const { t } = useTranslations();
  const heroDescriptionId = useId();
  const heroNotificationNoteId = useId();
  const todayCardSwitchId = useId();
  const { saveMutation, setTodayCardVisible, toggleHeroItem } = draft;
  return (
    <fieldset
      aria-describedby={`${heroDescriptionId} ${heroNotificationNoteId}`}
      data-slot="hero-content-settings"
      className="border-border bg-background/30 space-y-3 rounded-lg border px-3 py-3"
    >
      <legend className="text-foreground text-sm font-medium">
        {t("dashboard.morning.heroItemsTitle")}
      </legend>
      <p id={heroDescriptionId} className="text-muted-foreground text-xs">
        {t("dashboard.morning.heroItemsDescription")}
      </p>
      {/* The score row can be switched off; shown is the default. The ask
          card cannot: it shows only when something asks. */}
      <SwitchRow
        label={t("dashboard.scoreRowVisible")}
        id={todayCardSwitchId}
        checked={layout.todayCardVisible !== false}
        onCheckedChange={setTodayCardVisible}
        disabled={saveMutation.isPending}
        data-slot="today-card-switch"
      />
      <div className="divide-border divide-y">
        {OPTIONAL_ASK_KINDS.map((kind) => {
          const inputId = `hero-item-${kind}`;
          const checked = (
            layout.enabledHeroItemKinds ?? PRIORITY_ITEM_KINDS
          ).includes(kind);
          return (
            <SwitchRow
              key={kind}
              className="py-2"
              label={t(HERO_ITEM_LABEL_KEYS[kind])}
              id={inputId}
              checked={checked}
              onCheckedChange={(value) => toggleHeroItem(kind, value)}
              disabled={saveMutation.isPending}
              aria-label={t(HERO_ITEM_LABEL_KEYS[kind])}
              data-slot="hero-item-switch"
              data-kind={kind}
            />
          );
        })}
      </div>
      <p id={heroNotificationNoteId} className="text-foreground text-sm">
        {t("dashboard.asksAlwaysShown")}{" "}
        {t("dashboard.heroItemsNotificationNote")}
      </p>
    </fieldset>
  );
}
