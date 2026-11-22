"use client";

/**
 * The checkups list in Settings, in two parts since v1.44:
 *
 * `VorsorgeSettings` — Settings > Arrangement > Checkups: the card-vs-list
 * view and the manual order, persisted per account through
 * `useModuleListPrefs("vorsorge")`.
 *
 * `VorsorgeReminderSwitchesCard` — the per-reminder on/off switches, under
 * Settings > Notifications with the other reminders, persisted through the
 * reminder PATCH route.
 */
import { ArrowUpDown, LayoutGrid, ListChecks } from "lucide-react";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";

import { Card, CardContent } from "@/components/ui/card";
import { SwitchRow } from "@/components/ui/switch-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ModuleViewToggle } from "@/components/module-list/module-view-toggle";
import {
  ModuleOrderEditor,
  type ReorderItem,
} from "@/components/module-list/module-order-editor";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";
import {
  useMeasurementReminders,
  useMeasurementReminderMutations,
  type MeasurementReminder,
} from "@/hooks/use-measurement-reminders";
import { translateOrNull } from "@/lib/i18n/translate-code";
import { EmptyState } from "@/components/ui/empty-state";
import { showErrorToast } from "@/lib/errors/error-toast";

function resolveLabel(
  reminder: MeasurementReminder,
  t: (key: string) => string,
): string {
  if (reminder.origin === "COACH") {
    return translateOrNull(t, reminder.label) ?? reminder.label;
  }
  return reminder.label;
}

export function VorsorgeSettings() {
  const { t } = useTranslations();
  const { data: reminders, isLoading } = useMeasurementReminders(true);
  const { prefs, setView, setOrder } = useModuleListPrefs("vorsorge");

  const ordered = applyOrder(reminders ?? [], prefs.order, (r) => r.id);
  const reorderItems: ReorderItem[] = ordered.map((r) => ({
    id: r.id,
    name: resolveLabel(r, t),
    secondary: r.measurementType
      ? t(`measurementReminders.types.${r.measurementType}`)
      : t("measurementReminders.selfPlanned"),
  }));

  // v1.18.10 — the Vorsorge settings groups adopt the shared
  // `SettingsCard` + `SettingsCardHeader` contract (rounded-xl bordered
  // surface, neutral muted icon, `text-lg` title, short muted description)
  // so this surface reads like every other Settings section instead of bare
  // `<section>` blocks with `text-sm` headings.
  return (
    <div className="space-y-6">
      {/* v1.25.3 — `id="vorsorge-view"` + `scroll-mt-28` so the Appearance hub
          deep-link (`/settings/vorsorge#vorsorge-view`) lands on this card
          below the sticky page header, mirroring the labs/illness anchors. */}
      <SettingsCard id="vorsorge-view" className="scroll-mt-28">
        <SettingsCardHeader
          icon={LayoutGrid}
          title={t("moduleList.viewHeading")}
          description={t("moduleList.viewDescription")}
          status={<ModuleViewToggle view={prefs.view} onChange={setView} />}
        />
      </SettingsCard>

      <SettingsCard>
        <SettingsCardHeader
          icon={ArrowUpDown}
          title={t("moduleList.reorder.heading")}
          description={t("moduleList.reorder.description")}
        />
        <div>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <ModuleOrderEditor items={reorderItems} onChange={setOrder} />
          )}
        </div>
      </SettingsCard>
    </div>
  );
}

/**
 * The on/off switch of each preventive-care reminder. A reminder, so since
 * v1.44 it lives with the other reminders under Settings > Notifications
 * (`#vorsorge-reminders`, the wrapper there); the checkups page links
 * there.
 */
export function VorsorgeReminderSwitchesCard() {
  const { t } = useTranslations();
  const { data: reminders, isLoading } = useMeasurementReminders(true);
  const { update } = useMeasurementReminderMutations();
  const { prefs } = useModuleListPrefs("vorsorge");
  const ordered = applyOrder(reminders ?? [], prefs.order, (r) => r.id);

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={ListChecks}
        title={t("notifications.checkupReminders.title")}
        description={t("notifications.checkupReminders.description")}
      />
      <div>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (reminders?.length ?? 0) === 0 ? (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("measurementReminders.manage.empty")}
          />
        ) : (
          <Card>
            <CardContent className="divide-border divide-y p-0">
              {ordered.map((reminder) => (
                <SwitchRow
                  key={reminder.id}
                  className="px-4 py-3"
                  label={resolveLabel(reminder, t)}
                  checked={reminder.enabled}
                  onCheckedChange={(next) =>
                    update.mutate(
                      { id: reminder.id, body: { enabled: next } },
                      {
                        onSuccess: () =>
                          toastWrittenOutcome("success", t("settings.saved")),
                        onError: (failure) =>
                          showErrorToast(t("settings.savingError"), {
                            cause: failure,
                          }),
                      },
                    )
                  }
                  disabled={update.isPending}
                />
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </SettingsCard>
  );
}
