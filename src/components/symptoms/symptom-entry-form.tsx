"use client";

/**
 * Log one occurrence of a symptom the person defined (v1.40): which one, how
 * strong (0-10, the scale the pain score uses), when, an optional note, and,
 * only while an illness episode is open, which episode it happened during.
 *
 * Built like the measurement and mood quick-entry forms it sits beside: the
 * `FieldGroup` rhythm, `SliderField` for the bounded scale, `DateTimeField`
 * prefilled with now, the note with its counter, inline field errors, and the
 * kebab + Cancel + Save action row portalled into the sheet's footer slot so
 * it stays above the phone keyboard.
 */
import { localDateTimeValue } from "@/components/day/prefill";
import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, MoreHorizontal, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DateTimeField } from "@/components/ui/date-time-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SliderField } from "@/components/ui/slider";
import {
  useActiveRecordName,
  useRecordCapabilities,
} from "@/hooks/use-record-capabilities";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import {
  SYMPTOM_INTENSITY_MAX,
  SYMPTOM_INTENSITY_MIN,
} from "@/lib/symptoms/shared";
import { cn } from "@/lib/utils";
import { useIllnessEpisodes } from "@/components/illness/use-illness";

import { AddSymptomChip } from "./add-symptom-chip";
import { SymptomIcon } from "./symptom-icons";
import { useLogSymptomEvent, useSymptomDefinitions } from "./use-symptoms";

const NOTE_MAX_LENGTH = 500;
const NO_EPISODE = "none";

function nowLocalValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

interface SymptomEntryFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  /** The sheet's footer slot; the action row portals into it. */
  footerSlot?: HTMLElement | null;
  /**
   * v1.42 — a calendar day (`YYYY-MM-DD`) to start the date on, when the
   * form is opened from that day. Defaults to now.
   */
  defaultDate?: string;
}

export function SymptomEntryForm({
  onSuccess,
  onCancel,
  footerSlot,
  defaultDate,
}: SymptomEntryFormProps) {
  const { t } = useTranslations();
  const recordName = useActiveRecordName();
  const { canManageDomain } = useRecordCapabilities();
  const canDefine = canManageDomain("illness");
  const definitions = useSymptomDefinitions(false);
  const episodes = useIllnessEpisodes(false);
  const log = useLogSymptomEvent();

  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [intensity, setIntensity] = useState<number | null>(null);
  const [occurredAt, setOccurredAt] = useState(() =>
    localDateTimeValue(defaultDate),
  );
  const [note, setNote] = useState("");
  const [episodeId, setEpisodeId] = useState<string>(NO_EPISODE);
  const [symptomError, setSymptomError] = useState<string | null>(null);
  const [intensityError, setIntensityError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formId = useId();
  const errorId = useId();

  const list = definitions.data?.definitions ?? [];
  const limit = definitions.data?.limit ?? 0;
  const atLimit = limit > 0 && list.length >= limit;
  // Only an open episode can take a new occurrence; the server refuses the
  // rest, so the selector never offers them.
  const openEpisodes = (episodes.data ?? []).filter(
    (episode) => episode.resolvedAt === null,
  );

  function resetForm() {
    setDefinitionId(null);
    setIntensity(null);
    setOccurredAt(localDateTimeValue(defaultDate));
    setNote("");
    setEpisodeId(NO_EPISODE);
    setSymptomError(null);
    setIntensityError(null);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const missingSymptom = definitionId === null;
    const missingIntensity = intensity === null;
    setSymptomError(
      missingSymptom ? t("symptoms.entry.symptomRequired") : null,
    );
    setIntensityError(
      missingIntensity ? t("symptoms.entry.intensityRequired") : null,
    );
    if (missingSymptom || missingIntensity) return;

    try {
      await log.mutateAsync({
        definitionId,
        intensity,
        occurredAt: new Date(occurredAt).toISOString(),
        note: note.trim() ? note.trim() : undefined,
        episodeId: episodeId === NO_EPISODE ? undefined : episodeId,
      });
      toast.success(
        t("common.saved"),
        recordName
          ? {
              description: t("recordSharing.toast.savedTo", {
                name: recordName,
              }),
            }
          : undefined,
      );
      resetForm();
      onSuccess?.();
    } catch (err) {
      setError(localizedApiError(err, t, "symptoms.saveError"));
    }
  }

  const footerNode = (
    <div className="flex w-full items-center justify-between gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11"
            disabled={log.isPending}
            aria-label={t("common.moreOptions")}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={resetForm}>
            <RotateCcw className="mr-2 size-4" />
            {t("symptoms.entry.reset")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex items-center gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={log.isPending}
          >
            {t("common.cancel")}
          </Button>
        )}
        <Button type="submit" form={formId} disabled={log.isPending}>
          {log.isPending ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Plus className="size-4" />
          )}
          {t("common.save")}
        </Button>
      </div>
    </div>
  );

  const symptomGroupId = `${formId}-symptom`;
  const low = t("symptoms.entry.anchorLow");
  const high = t("symptoms.entry.anchorHigh");

  return (
    <form
      id={formId}
      onSubmit={handleSubmit}
      className="space-y-4"
      data-testid="symptom-entry-form"
    >
      <div className="space-y-2">
        <Label id={symptomGroupId}>{t("symptoms.entry.symptom")}</Label>
        {definitions.isError ? (
          // A failed read is not an empty list: the empty hint would invite
          // the person to define a symptom they may already have.
          <QueryErrorRow
            message={t("symptoms.section.loadError")}
            onRetry={() => void definitions.refetch()}
          />
        ) : (
          <>
            <div
              role="radiogroup"
              aria-labelledby={symptomGroupId}
              aria-describedby={
                symptomError ? `${symptomGroupId}-error` : undefined
              }
              className="flex flex-wrap gap-2"
            >
              {list.map((definition) => {
                const selected = definitionId === definition.id;
                return (
                  <button
                    key={definition.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid="symptom-chip"
                    onClick={() => {
                      setDefinitionId(selected ? null : definition.id);
                      setSymptomError(null);
                    }}
                    className={cn(
                      "focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-8",
                      selected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-foreground hover:bg-accent",
                    )}
                  >
                    <SymptomIcon name={definition.icon} className="size-4" />
                    {definition.label ?? t("symptoms.unreadableLabel")}
                  </button>
                );
              })}
              {canDefine && !atLimit ? (
                <AddSymptomChip
                  onCreated={(id) => {
                    setDefinitionId(id);
                    setSymptomError(null);
                  }}
                />
              ) : null}
            </div>
            {list.length === 0 && !definitions.isLoading ? (
              <p className="text-muted-foreground text-xs">
                {canDefine
                  ? t("symptoms.entry.emptyHint")
                  : t("symptoms.entry.emptyHintNoManage")}
              </p>
            ) : atLimit && canDefine ? (
              <p className="text-muted-foreground text-xs">
                {t("symptoms.entry.limitHint", { limit })}
              </p>
            ) : null}
          </>
        )}
        {symptomError ? (
          <p
            id={`${symptomGroupId}-error`}
            role="alert"
            className="text-destructive text-sm"
          >
            {symptomError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <SliderField
          label={t("symptoms.entry.intensity")}
          value={intensity}
          onValueChange={(next) => {
            setIntensity(next);
            setIntensityError(null);
          }}
          min={SYMPTOM_INTENSITY_MIN}
          max={SYMPTOM_INTENSITY_MAX}
          step={1}
          lowAnchor={low}
          highAnchor={high}
          emptyLabel={t("symptoms.entry.intensityUnset")}
          valueText={
            intensity === null
              ? undefined
              : t("symptoms.entry.intensityValueText", {
                  value: intensity,
                  max: SYMPTOM_INTENSITY_MAX,
                  low,
                  high,
                })
          }
        />
        {intensityError ? (
          <p role="alert" className="text-destructive text-sm">
            {intensityError}
          </p>
        ) : null}
      </div>

      <FieldGroup
        htmlFor={`${formId}-occurred-at`}
        label={t("symptoms.entry.when")}
        hint={t("measurements.timestampBackdateHint")}
      >
        <DateTimeField
          id={`${formId}-occurred-at`}
          value={occurredAt}
          onChange={setOccurredAt}
          max={nowLocalValue()}
          required
          aria-required="true"
        />
      </FieldGroup>

      {openEpisodes.length > 0 ? (
        <FieldGroup
          htmlFor={`${formId}-episode`}
          label={
            <>
              {t("symptoms.entry.during")}{" "}
              <span className="text-muted-foreground font-normal">
                ({t("common.optional")})
              </span>
            </>
          }
        >
          <Select value={episodeId} onValueChange={setEpisodeId}>
            <SelectTrigger id={`${formId}-episode`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_EPISODE}>
                {t("symptoms.entry.duringNone")}
              </SelectItem>
              {openEpisodes.map((episode) => (
                <SelectItem key={episode.id} value={episode.id}>
                  {episode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldGroup>
      ) : null}

      <FieldGroup
        htmlFor={`${formId}-note`}
        label={
          <>
            {t("symptoms.entry.note")}{" "}
            <span className="text-muted-foreground font-normal">
              ({t("common.optional")})
            </span>
          </>
        }
        labelAccessory={
          <span className="text-muted-foreground text-xs">
            {note.length}/{NOTE_MAX_LENGTH}
          </span>
        }
      >
        <Input
          id={`${formId}-note`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("symptoms.entry.notePlaceholder")}
          maxLength={NOTE_MAX_LENGTH}
          enterKeyHint="done"
          autoCapitalize="sentences"
        />
      </FieldGroup>

      {error && (
        <div
          id={errorId}
          role="alert"
          aria-live="assertive"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {error}
        </div>
      )}

      {footerSlot ? createPortal(footerNode, footerSlot) : footerNode}
    </form>
  );
}
