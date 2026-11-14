"use client";

/**
 * v1.18.1 — the "new episode" capture sheet. A calm, minimal form: a
 * label, the broad condition type, the lifecycle, an onset date, and an
 * optional encrypted note. Retrospective-only — no prediction UI, no
 * diagnosis prompt. Neutral palette throughout.
 *
 * The form fields live in `use-episode-form` and the save lifecycle in
 * `use-episode-save`; this file keeps the layout.
 */
import { useState } from "react";

import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDisplayTimezone, useTranslations } from "@/lib/i18n/context";
import {
  BodySiteFields,
  type BodySiteSideValue,
} from "@/components/body-sites/body-site-fields";

import { useIllnessEpisodes } from "./use-illness";
import { useEpisodeForm } from "./use-episode-form";
import { useEpisodeSave } from "./use-episode-save";
import { toLocalDateKey } from "./dates";
import type { IllnessEpisodeDTO, IllnessLifecycle, IllnessType } from "./types";

const TYPES: IllnessType[] = [
  "INFECTION",
  "ALLERGY",
  "INJURY",
  "MENTAL_HEALTH",
  "AUTOIMMUNE",
  "CHRONIC",
  "OTHER",
];

const LIFECYCLES: IllnessLifecycle[] = [
  "ACUTE",
  "CHRONIC_ONGOING",
  "RECURRING",
  "FLARE",
];

const NONE = "__none__";

/** What the form opens with: the edited episode, or a new one from today. */
function episodeForm(
  episode: IllnessEpisodeDTO | undefined,
  today: string,
  timeZone: string,
) {
  return {
    label: episode?.label ?? "",
    type: episode?.type ?? ("INFECTION" as IllnessType),
    lifecycle: episode?.lifecycle ?? ("ACUTE" as IllnessLifecycle),
    onset: episode ? toLocalDateKey(episode.onsetAt, timeZone) : today,
    resolved: episode?.resolvedAt
      ? toLocalDateKey(episode.resolvedAt, timeZone)
      : "",
    parentId: episode?.parentConditionId ?? null,
    note: episode?.note ?? "",
    bodySite: episode?.bodySite ?? "",
    laterality: (episode?.laterality ?? null) as BodySiteSideValue,
  };
}

interface NewEpisodeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  today: string;
  /** When set, the sheet edits this episode instead of creating a new one. */
  editEpisode?: IllnessEpisodeDTO;
}

export function NewEpisodeSheet({
  open,
  onOpenChange,
  today,
  editEpisode,
}: NewEpisodeSheetProps) {
  const { t } = useTranslations();
  const timeZone = useDisplayTimezone();
  const isEdit = editEpisode !== undefined;
  const form = useEpisodeForm({ open, editEpisode, timeZone, today });
  const {
    pending,
    saveError,
    todayInSession,
    showParent,
    trimmedOnset,
    trimmedResolved,
    endBeforeStart,
    handleSave,
    handleOpenChange,
    clearSaveError,
  } = useEpisodeSave({
    open,
    onOpenChange,
    editEpisode,
    timeZone,
    values: form,
  });

  // Candidate parents: live episodes other than the one being edited.
  const { data: allEpisodes } = useIllnessEpisodes(true);
  const parentCandidates = (allEpisodes ?? []).filter(
    (e) => e.id !== editEpisode?.id,
  );

  const [wasOpen, setWasOpen] = useState(open);
  const [seed, setSeed] = useState(() =>
    episodeForm(editEpisode, today, timeZone),
  );
  if (open && !wasOpen) {
    setWasOpen(true);
    setSeed(episodeForm(editEpisode, today, timeZone));
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }
  const dirty =
    JSON.stringify({
      label: form.label,
      type: form.type,
      lifecycle: form.lifecycle,
      onset: form.onset,
      resolved: form.resolved,
      parentId: form.parentId,
      note: form.note,
      bodySite: form.bodySite,
      laterality: form.laterality,
    }) !== JSON.stringify(seed);

  function handleOnsetChange(value: string) {
    form.setOnset(value);
    clearSaveError();
  }

  function handleResolvedChange(value: string) {
    form.setResolved(value);
    clearSaveError();
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={handleOpenChange}
      dirty={dirty}
      title={isEdit ? t("illness.edit.title") : t("illness.new.title")}
      description={
        isEdit ? t("illness.edit.description") : t("illness.new.description")
      }
      footer={
        <>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              pending ||
              form.label.trim() === "" ||
              trimmedOnset === "" ||
              endBeforeStart
            }
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="illness-label">{t("illness.new.label")}</Label>
          <Input
            id="illness-label"
            value={form.label}
            maxLength={120}
            onChange={(e) => {
              form.setLabel(e.target.value);
              clearSaveError();
            }}
            placeholder={t("illness.new.labelPlaceholder")}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="illness-type">{t("illness.new.type")}</Label>
          <Select
            value={form.type}
            onValueChange={(v) => {
              form.setType(v as IllnessType);
              clearSaveError();
            }}
          >
            <SelectTrigger id="illness-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`illness.type.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <BodySiteFields
          idPrefix="illness"
          bodySite={form.bodySite}
          laterality={form.laterality}
          onBodySiteChange={(v) => {
            form.setBodySite(v);
            clearSaveError();
          }}
          onLateralityChange={(v) => {
            form.setLaterality(v);
            clearSaveError();
          }}
          hint={t("illness.new.bodySiteHint")}
        />

        <div className="space-y-1.5">
          <Label htmlFor="illness-lifecycle">
            {t("illness.new.lifecycle")}
          </Label>
          <Select
            value={form.lifecycle}
            onValueChange={(v) => {
              form.setLifecycle(v as IllnessLifecycle);
              clearSaveError();
            }}
          >
            <SelectTrigger id="illness-lifecycle" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIFECYCLES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`illness.lifecycle.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {showParent ? (
          <div className="space-y-1.5">
            <Label htmlFor="illness-parent">{t("illness.new.parent")}</Label>
            <Select
              value={form.parentId ?? NONE}
              onValueChange={(v) => {
                form.setParentId(v === NONE ? null : v);
                clearSaveError();
              }}
            >
              <SelectTrigger id="illness-parent" className="w-full">
                <SelectValue placeholder={t("illness.new.parentNone")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  {t("illness.new.parentNone")}
                </SelectItem>
                {parentCandidates.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="illness-onset">{t("illness.new.onset")}</Label>
          <DateField
            id="illness-onset"
            value={form.onset}
            max={todayInSession}
            onChange={handleOnsetChange}
            className="max-w-44"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="illness-resolved">{t("illness.new.resolved")}</Label>
          <div className="flex items-center gap-2">
            <DateField
              id="illness-resolved"
              value={form.resolved}
              min={trimmedOnset}
              max={todayInSession}
              onChange={handleResolvedChange}
              className="max-w-44"
            />
            {trimmedResolved !== "" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleResolvedChange("")}
              >
                {t("illness.new.markOngoing")}
              </Button>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            {t("illness.new.resolvedHelp")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="illness-note">{t("illness.new.note")}</Label>
          <Textarea
            id="illness-note"
            value={form.note}
            maxLength={2000}
            onChange={(e) => {
              form.setNote(e.target.value);
              clearSaveError();
            }}
            placeholder={t("illness.new.notePlaceholder")}
            rows={3}
          />
        </div>

        {saveError ? (
          <p className="text-destructive text-sm" role="alert">
            {t("illness.new.saveError")}
          </p>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}
