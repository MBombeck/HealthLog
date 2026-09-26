"use client";

/**
 * v1.18.1 — the "new episode" capture sheet. A calm, minimal form: a
 * label, the broad condition type, the lifecycle, an onset date, and an
 * optional encrypted note. Retrospective-only — no prediction UI, no
 * diagnosis prompt. Neutral palette throughout.
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
import { useTranslations } from "@/lib/i18n/context";
import {
  BodySiteFields,
  type BodySiteSideValue,
} from "@/components/body-sites/body-site-fields";

import {
  useCreateEpisode,
  useIllnessEpisodes,
  useUpdateEpisode,
} from "./use-illness";
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

  const [label, setLabel] = useState("");
  const [type, setType] = useState<IllnessType>("INFECTION");
  const [lifecycle, setLifecycle] = useState<IllnessLifecycle>("ACUTE");
  const [onset, setOnset] = useState(today);
  // Resolved/end date — "" means the episode is still ongoing (open-ended).
  // Backdating both onset and this end date lets a whole past episode be
  // recorded after the fact.
  const [resolved, setResolved] = useState("");
  const [parentId, setParentId] = useState<string>(NONE);
  const [note, setNote] = useState("");
  // v1.39.2 — where on the body. Offered on every type: an injury or a joint
  // condition is the usual case, but nothing about a type rules a site out.
  const [bodySite, setBodySite] = useState("");
  const [laterality, setLaterality] = useState<BodySiteSideValue>(null);

  // Reset / hydrate the form each time the sheet opens — adjusted during
  // render keyed on the open transition (React's recommended alternative to a
  // setState-in-effect).
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setLabel(editEpisode?.label ?? "");
    setType(editEpisode?.type ?? "INFECTION");
    setLifecycle(editEpisode?.lifecycle ?? "ACUTE");
    setOnset(editEpisode ? editEpisode.onsetAt.slice(0, 10) : today);
    setResolved(
      editEpisode?.resolvedAt ? editEpisode.resolvedAt.slice(0, 10) : "",
    );
    setParentId(editEpisode?.parentConditionId ?? NONE);
    setNote(editEpisode?.note ?? "");
    setBodySite(editEpisode?.bodySite ?? "");
    setLaterality(editEpisode?.laterality ?? null);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const showParent = PARENTABLE.includes(lifecycle);

  // The end date can never precede the start; the field is min-bounded to the
  // onset, and this guard belts-and-braces the same invariant the server holds.
  const endBeforeStart = resolved !== "" && resolved < onset;

  async function handleSave() {
    if (label.trim() === "" || endBeforeStart) return;
    const onsetAt = new Date(`${onset}T12:00:00`).toISOString();
    // "" ⇒ ongoing (null clears any stored end). Anchor to local noon so the
    // UTC instant lands on the intended calendar day regardless of offset.
    const resolvedAt =
      resolved === "" ? null : new Date(`${resolved}T12:00:00`).toISOString();
    const parentConditionId = showParent && parentId !== NONE ? parentId : null;
    try {
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
    } catch {
      // Keep the sheet open; the error strip reports it.
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t("illness.edit.title") : t("illness.new.title")}
      description={
        isEdit ? t("illness.edit.description") : t("illness.new.description")
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={pending || label.trim() === "" || endBeforeStart}
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
          <Label>{t("illness.new.type")}</Label>
          <Select value={type} onValueChange={(v) => setType(v as IllnessType)}>
            <SelectTrigger>
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
          <Label>{t("illness.new.lifecycle")}</Label>
          <Select
            value={lifecycle}
            onValueChange={(v) => setLifecycle(v as IllnessLifecycle)}
          >
            <SelectTrigger>
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
            <Label>{t("illness.new.parent")}</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger>
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
            max={today}
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
              min={onset}
              max={today}
              onChange={setResolved}
              className="max-w-44"
            />
            {resolved !== "" ? (
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
