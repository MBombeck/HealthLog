"use client";

import { useId } from "react";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import type { DashboardLayout } from "@/lib/dashboard-layout";
import { useTranslations } from "@/lib/i18n/context";

import { HERO_ITEM_LABEL_KEYS } from "./layout-model";
import type { DashboardLayoutDraft } from "./use-dashboard-layout-draft";

/**
 * The top card's settings: whether it shows, what leads it (the health score
 * or the reminders rail), and which highlights may appear in it.
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
  const heroContentSelectId = useId();
  const todayCardSwitchId = useId();
  const { saveMutation, setTodayCardVisible, setHeroContent, toggleHeroItem } =
    draft;
  return (
    <fieldset
      aria-describedby={`${heroDescriptionId} ${heroNotificationNoteId}`}
      data-slot="hero-content-settings"
      className="border-border bg-background/30 space-y-3 rounded-lg border px-3 py-3"
    >
      <legend className="text-foreground text-sm font-medium">
        {t("dashboard.heroItemsTitle")}
      </legend>
      <p id={heroDescriptionId} className="text-muted-foreground text-xs">
        {t("dashboard.heroItemsDescription")}
      </p>
      {/* The top card itself can be switched off. Shown is the
          default; the choices below shape the card while it is shown. */}
      <div className="flex min-h-11 items-center justify-between gap-3">
        <Label htmlFor={todayCardSwitchId} className="text-sm font-medium">
          {t("dashboard.todayCardVisible")}
        </Label>
        <Switch
          id={todayCardSwitchId}
          checked={layout.todayCardVisible !== false}
          onCheckedChange={setTodayCardVisible}
          disabled={saveMutation.isPending}
          data-slot="today-card-switch"
        />
      </div>
      {/* Hero primary content — a single labelled select beside the
          highlight toggles. "score" keeps the health-score read;
          "reminders" promotes the highlight rail into the hero slot. */}
      <div className="space-y-1.5">
        <Label htmlFor={heroContentSelectId} className="text-sm font-medium">
          {t("dashboard.heroContentTitle")}
        </Label>
        <NativeSelect
          id={heroContentSelectId}
          value={layout.hero ?? "score"}
          onChange={(event) => setHeroContent(event.target.value)}
          disabled={saveMutation.isPending}
          data-slot="hero-content-select"
          className="sm:max-w-xs"
        >
          <option value="score">{t("dashboard.heroContentScore")}</option>
          <option value="reminders">
            {t("dashboard.heroContentReminders")}
          </option>
        </NativeSelect>
      </div>
      <div className="divide-border divide-y">
        {PRIORITY_ITEM_KINDS.map((kind) => {
          const inputId = `hero-item-${kind}`;
          const checked = (
            layout.enabledHeroItemKinds ?? PRIORITY_ITEM_KINDS
          ).includes(kind);
          return (
            <div
              key={kind}
              className="flex min-h-11 items-center justify-between gap-3 py-2"
            >
              <Label htmlFor={inputId} className="text-sm font-medium">
                {t(HERO_ITEM_LABEL_KEYS[kind])}
              </Label>
              <Switch
                id={inputId}
                checked={checked}
                onCheckedChange={(value) => toggleHeroItem(kind, value)}
                disabled={saveMutation.isPending}
                aria-label={t(HERO_ITEM_LABEL_KEYS[kind])}
                data-slot="hero-item-switch"
                data-kind={kind}
              />
            </div>
          );
        })}
      </div>
      <p id={heroNotificationNoteId} className="text-foreground text-sm">
        {t("dashboard.heroItemsNotificationNote")}
      </p>
    </fieldset>
  );
}
