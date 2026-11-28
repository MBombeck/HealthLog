"use client";

import { useId, useState } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import {
  PageCustomizeGroup,
  PageCustomizeSheet,
  type PageCustomizeLevel,
} from "@/components/ui/page-customize";
import { RowValue } from "@/components/ui/row-value";
import { SwitchRow } from "@/components/ui/switch-row";
import {
  ActivityGoalsForm,
  countActivityGoals,
} from "@/components/activity/activity-goals-form";
import { availableMeasures } from "@/components/activity/activity-calendar-card";
import { useActivityCalendar } from "@/hooks/use-activity-calendar";
import {
  holdsOwnerRights,
  useRecordCapabilities,
} from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";
import { MEASUREMENT_SOURCE_LIST_LABEL_KEYS } from "@/lib/i18n/source-labels";
import { translateOrNull } from "@/lib/i18n/translate-code";
import type { ModuleSummaryMeasure } from "@/lib/settings/module-list-layout";

type Level = "measure" | "goals" | null;

/**
 * "Seite anpassen" for the workouts page. Anzeige: the calendar on or off
 * and what it shows. Erfassung: the activity goals. Daten: where the
 * workouts come from, import and export.
 */
export function WorkoutsCustomizeSheet({
  open,
  onOpenChange,
  summary,
  onSummaryChange,
  measure,
  onMeasureChange,
  sources,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: boolean;
  onSummaryChange: (summary: boolean) => void;
  measure: ModuleSummaryMeasure;
  onMeasureChange: (measure: ModuleSummaryMeasure) => void;
  /** Source codes of the workouts, most frequent first (server-resolved). */
  sources: readonly string[];
}) {
  const { t } = useTranslations();
  const capabilities = useRecordCapabilities();
  const owner = holdsOwnerRights(capabilities);
  // The same cell the page's calendar reads: no second request.
  const calendar = useActivityCalendar("month", null, { enabled: open });
  const data = calendar.data;
  const measures = availableMeasures(data);
  const shownMeasure = measures.includes(measure) ? measure : measures[0];
  const [level, setLevel] = useState<Level>(null);
  const goalsFormId = useId();

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setLevel(null);
  };

  const sourceNames = sources.map((code) => {
    const key =
      MEASUREMENT_SOURCE_LIST_LABEL_KEYS[
        code as keyof typeof MEASUREMENT_SOURCE_LIST_LABEL_KEYS
      ];
    return (key ? translateOrNull(t, key) : null) ?? code;
  });
  const goalsSet = data ? countActivityGoals(data.goals) : 0;

  let levelView: PageCustomizeLevel | null = null;
  if (level === "measure") {
    levelView = {
      title: t("insights.workouts.customize.calendarShows"),
      body: (
        <ListGroup data-slot="workouts-customize-measures">
          {measures.map((m) => (
            <ListItem
              key={m}
              data-slot={`workouts-customize-measure-${m}`}
              title={t(`activityCalendar.metric.${m}`)}
              onSelect={() => {
                onMeasureChange(m);
                setLevel(null);
              }}
              aria-current={m === shownMeasure ? "true" : undefined}
              trailing={
                <span className="flex size-8 items-center justify-center">
                  {m === shownMeasure ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : null}
                </span>
              }
            />
          ))}
        </ListGroup>
      ),
    };
  } else if (level === "goals" && data) {
    levelView = {
      title: t("pageCustomize.goals"),
      body: (
        <ActivityGoalsForm
          formId={goalsFormId}
          goals={data.goals}
          progress={data.goalProgress}
          onSaved={() => setLevel(null)}
        />
      ),
      footer: (
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => setLevel(null)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={goalsFormId}
            data-slot="activity-goals-save"
          >
            {t("common.save")}
          </Button>
        </>
      ),
    };
  }

  return (
    <PageCustomizeSheet
      open={open}
      onOpenChange={close}
      level={levelView}
      onBack={() => setLevel(null)}
    >
      <PageCustomizeGroup group="display">
        <li data-slot="list-item">
          <SwitchRow
            data-slot="workouts-customize-calendar"
            className="min-h-14 px-4 py-2"
            label={t("insights.workouts.customize.calendar")}
            checked={summary}
            onCheckedChange={onSummaryChange}
          />
        </li>
        {summary && shownMeasure && measures.length > 1 ? (
          <ListItem
            data-slot="workouts-customize-measure"
            title={t("insights.workouts.customize.calendarShows")}
            onSelect={() => setLevel("measure")}
            trailing={
              <RowValue chevron>
                {t(`activityCalendar.metric.${shownMeasure}`)}
              </RowValue>
            }
          />
        ) : null}
      </PageCustomizeGroup>
      {owner && data ? (
        <PageCustomizeGroup group="capture">
          <ListItem
            data-slot="activity-calendar-set-goals"
            title={t("pageCustomize.goals")}
            onSelect={() => setLevel("goals")}
            trailing={
              <RowValue chevron>
                {goalsSet > 0
                  ? t("pageCustomize.goalsSet", { count: goalsSet })
                  : null}
              </RowValue>
            }
          />
        </PageCustomizeGroup>
      ) : null}
      <PageCustomizeGroup group="data">
        <ListItem
          data-slot="workouts-customize-sources"
          title={t("pageCustomize.sources")}
          href="/settings/sources"
          trailing={
            <RowValue chevron title={sourceNames.join(", ")}>
              {sourceNames.join(", ")}
            </RowValue>
          }
        />
        {owner ? (
          <ListItem
            data-slot="workouts-customize-import"
            title={t("pageCustomize.import")}
            href="/settings/export"
            trailing={<RowValue chevron />}
          />
        ) : null}
        <ListItem
          data-slot="workouts-customize-export"
          title={t("pageCustomize.export")}
          href="/settings/export"
          trailing={<RowValue chevron />}
        />
      </PageCustomizeGroup>
    </PageCustomizeSheet>
  );
}
