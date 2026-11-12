"use client";

/**
 * v1.18.1 — the "new episode" capture sheet. A calm, minimal form: a
 * label, the broad condition type, the lifecycle, an onset date, and an
 * optional encrypted note. Retrospective-only — no prediction UI, no
 * diagnosis prompt. Neutral palette throughout.
 */
import { useEffect, useState } from "react";

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
import { todayKeyInZone } from "@/components/day/day-url";
import { getUserTodayBounds } from "@/lib/tz/local-day";

import {
  useCreateEpisode,
  useIllnessEpisodes,
  useUpdateEpisode,
} from "./use-illness";
import { resolveEpisodeInstant, toLocalDateKey } from "./dates";
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

/** Lifecycles that may hang off a parent condition. */
const PARENTABLE: IllnessLifecycle[] = ["FLARE", "RECURRING"];

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
    parentId: episode?.parentConditionId ?? NONE,
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
  const create = useCreateEpisode();
  const update = useUpdateEpisode();
  const isEdit = editEpisode !== undefined;
  const pending = create.isPending || update.isPending;
  const isError = create.isError || update.isError;

  // Candidate parents: live episodes other than the one being edited.
  const { data: allEpisodes } = useIllnessEpisodes(true);
  const parentCandidates = (allEpisodes ?? []).filter(
    (e) => e.id !== editEpisode?.id,
  );

  const [label, setLabel] = useState(editEpisode?.label ?? "");
  const [type, setType] = useState<IllnessType>(
    editEpisode?.type ?? "INFECTION",
  );
  const [lifecycle, setLifecycle] = useState<IllnessLifecycle>(
    editEpisode?.lifecycle ?? "ACUTE",
  );
  const [sessionTimezone, setSessionTimezone] = useState(timeZone);
  const [todayInSession, setTodayInSession] = useState(() =>
    todayKeyInZone(timeZone),
  );
  const [onset, setOnset] = useState(
    editEpisode ? toLocalDateKey(editEpisode.onsetAt, timeZone) : today,
  );
  // Resolved/end date — "" means the episode is still ongoing (open-ended).
  // Backdating both onset and this end date lets a whole past episode be
  // recorded after the fact.
  const [resolved, setResolved] = useState(
    editEpisode?.resolvedAt
      ? toLocalDateKey(editEpisode.resolvedAt, timeZone)
      : "",
  );
  const [parentId, setParentId] = useState<string>(
    editEpisode?.parentConditionId ?? NONE,
  );
  const [note, setNote] = useState(editEpisode?.note ?? "");
  // v1.39.2 — where on the body. Offered on every type: an injury or a joint
  // condition is the usual case, but nothing about a type rules a site out.
  const [bodySite, setBodySite] = useState(editEpisode?.bodySite ?? "");
  const [laterality, setLaterality] = useState<BodySiteSideValue>(
    editEpisode?.laterality ?? null,
  );

  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function scheduleMidnight() {
      const now = new Date();
      const bounds = getUserTodayBounds(now, sessionTimezone);
      const delay = Math.max(0, bounds.end.getTime() + 1 - now.getTime());
      timer = setTimeout(() => {
        setTodayInSession(todayKeyInZone(sessionTimezone));
        scheduleMidnight();
      }, delay);
    }

    scheduleMidnight();
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [open, sessionTimezone]);

  // Reset / hydrate the form each time the sheet opens — adjusted during
  // render keyed on the open transition (React's recommended alternative to a
  // setState-in-effect).
  const [wasOpen, setWasOpen] = useState(false);
  const [seed, setSeed] = useState(() =>
    episodeForm(editEpisode, today, timeZone),
  );
  if (open && !wasOpen) {
    const next = episodeForm(editEpisode, today, timeZone);
    setWasOpen(true);
    setSeed(next);
    setSessionTimezone(timeZone);
    setTodayInSession(todayKeyInZone(timeZone));
    setLabel(next.label);
    setType(next.type);
    setLifecycle(next.lifecycle);
    setOnset(next.onset);
    setResolved(next.resolved);
    setParentId(next.parentId);
    setNote(next.note);
    setBodySite(next.bodySite);
    setLaterality(next.laterality);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }
  const form = {
    label,
    type,
    lifecycle,
    onset,
    resolved,
    parentId,
    note,
    bodySite,
    laterality,
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(seed);

  const showParent = PARENTABLE.includes(lifecycle);

  const trimmedOnset = onset.trim();
  const trimmedResolved = resolved.trim();

  // The end date can never precede the start; the field is min-bounded to the
  // onset, and this guard belts-and-braces the same invariant the server holds.
  const endBeforeStart =
    trimmedResolved !== "" &&
    trimmedOnset !== "" &&
    trimmedResolved < trimmedOnset;

  async function handleSave() {
    if (
      pending ||
      label.trim() === "" ||
      trimmedOnset === "" ||
      endBeforeStart
    ) {
      return;
    }
    const now = new Date();
    const today = todayKeyInZone(sessionTimezone, now);
    // When editing an existing episode, preserve its exact stored onset/resolved instants
    // when their selected calendar dates are unchanged in the active display timezone.
    const onsetAt = resolveEpisodeInstant({
      date: trimmedOnset,
      storedInstant: editEpisode?.onsetAt,
      today,
      now,
      timeZone: sessionTimezone,
    });
    const resolvedAt =
      trimmedResolved === ""
        ? null
        : resolveEpisodeInstant({
            date: trimmedResolved,
            storedInstant: editEpisode?.resolvedAt,
            today,
            now,
            timeZone: sessionTimezone,
          });
    const parentConditionId =
      showParent && parentId !== NONE ? parentId : null;

    if (isEdit && editEpisode) {
      await update.mutateAsync({
        id: editEpisode.id,
        input: {
          label: label.trim(),
          type,
          lifecycle,
          onsetAt,
          resolvedAt,
          parentConditionId,
          note: note.trim() === "" ? null : note,
          bodySite: bodySite.trim() || null,
          laterality,
        },
      });
    } else {
      await create.mutateAsync({
        label: label.trim(),
        type,
        lifecycle,
        onsetAt,
        resolvedAt,
        parentConditionId,
        note: note.trim() === "" ? null : note,
        bodySite: bodySite.trim() || null,
        laterality,
      });
    }
    onOpenChange(false);
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      dirty={dirty}
      title={isEdit ? t("illness.edit.title") : t("illness.new.title")}
      description={
        isEdit ? t("illness.edit.description") : t("illness.new.description")
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              pending ||
              label.trim() === "" ||
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
            value={label}
            maxLength={120}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("illness.new.labelPlaceholder")}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="illness-type">{t("illness.new.type")}</Label>
          <Select value={type} onValueChange={(v) => setType(v as IllnessType)}>
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
          bodySite={bodySite}
          laterality={laterality}
          onBodySiteChange={setBodySite}
          onLateralityChange={setLaterality}
          hint={t("illness.new.bodySiteHint")}
        />

        <div className="space-y-1.5">
          <Label htmlFor="illness-lifecycle">
            {t("illness.new.lifecycle")}
          </Label>
          <Select
            value={lifecycle}
            onValueChange={(v) => setLifecycle(v as IllnessLifecycle)}
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
            <Select value={parentId} onValueChange={setParentId}>
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
            value={onset}
            max={todayInSession}
            onChange={setOnset}
            className="max-w-44"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="illness-resolved">{t("illness.new.resolved")}</Label>
          <div className="flex items-center gap-2">
            <DateField
              id="illness-resolved"
              value={resolved}
              min={trimmedOnset}
              max={todayInSession}
              onChange={setResolved}
              className="max-w-44"
            />
            {trimmedResolved !== "" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setResolved("")}
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
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("illness.new.notePlaceholder")}
            rows={3}
          />
        </div>

        {isError ? (
          <p className="text-destructive text-sm" role="alert">
            {t("illness.new.saveError")}
          </p>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}
