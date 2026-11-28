"use client";

/**
 * Log an occurrence of a symptom the person defined (v1.40): which one, how
 * strong (0-10, the scale the pain score uses), when, an optional note, and
 * which illness episode it belongs to, offered whenever one ran at that time
 * (`EpisodeLinkField`).
 *
 * Several symptoms that came together (a flare where headache, nausea and
 * dizziness arrive at once) are logged in one go: each chip toggles, every
 * picked symptom gets its own intensity slider, and the time, note and
 * episode are shared. Save writes one occurrence per symptom through the
 * ordinary create route, one after the other; a failure part way keeps only
 * the unsaved ones picked, so trying again never writes one twice.
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
import { Loader2, RotateCcw } from "lucide-react";

import { ActionMenu, ActionPair } from "@/components/ui/action-pair";
import { Button } from "@/components/ui/button";
import { DateTimeField } from "@/components/ui/date-time-field";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { SliderField } from "@/components/ui/slider";
import {
  useActiveRecordName,
  useRecordCapabilities,
} from "@/hooks/use-record-capabilities";
import { showEntrySavedToast } from "@/components/forms/entry-saved-toast";
import { removeSavedSymptomEvents } from "@/components/forms/entry-undo";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import {
  SYMPTOM_INTENSITY_MAX,
  SYMPTOM_INTENSITY_MIN,
} from "@/lib/symptoms/shared";
import { useIllnessEpisodes } from "@/components/illness/use-illness";

import {
  effectiveEpisodeId,
  EpisodeLinkField,
  linkableEpisodes,
} from "./episode-link-field";
import { SymptomPicker } from "./symptom-picker";
import {
  invalidateSymptomReads,
  SymptomSaveError,
  useLatestSymptomIntensities,
  useLogSymptomEvents,
  useSymptomDefinitions,
} from "./use-symptoms";
import { useQueryClient } from "@tanstack/react-query";

const NOTE_MAX_LENGTH = 500;

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
  // Resolved ones too: a backdated occurrence may belong to an illness that
  // has since ended, as long as it happened while that one ran.
  const episodes = useIllnessEpisodes(true);
  const log = useLogSymptomEvents();
  const queryClient = useQueryClient();
  // Each symptom's last intensity: a picked symptom's slider starts there.
  const latest = useLatestSymptomIntensities();

  const picks = useSymptomPicks();
  const { picked } = picks;
  const [occurredAt, setOccurredAt] = useState(() =>
    localDateTimeValue(defaultDate),
  );
  const [note, setNote] = useState("");
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [symptomError, setSymptomError] = useState<string | null>(null);
  // Bumped on reset, so the picker starts over with an empty filter.
  const [pickerKey, setPickerKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const formId = useId();
  const errorId = useId();

  const list = definitions.data?.definitions ?? [];
  const limit = definitions.data?.limit ?? 0;
  // Only symptoms the person named hold a slot, not Apple Health's built-ins.
  const atLimit =
    limit > 0 && list.filter((d) => d.code === null).length >= limit;
  const labelById = new Map(list.map((d) => [d.id, d.label]));
  const busy = log.isPending;
  // Exactly the episodes the server admits at the chosen time.
  const episodeOptions = linkableEpisodes(episodes.data ?? [], occurredAt);
  const linkedEpisodeId = effectiveEpisodeId(episodeId, episodeOptions);

  function togglePick(id: string) {
    setSymptomError(null);
    picks.toggle(id, latest.get(id));
  }

  function resetForm() {
    picks.reset();
    setPickerKey((k) => k + 1);
    setOccurredAt(localDateTimeValue(defaultDate));
    setNote("");
    setEpisodeId(null);
    setSymptomError(null);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (picked.length === 0) {
      setSymptomError(t("symptoms.entry.symptomRequired"));
    }
    if (!picks.validate()) return;

    const occurredAtIso = new Date(occurredAt).toISOString();
    let events: Array<{ id: string }>;
    try {
      events = await log.mutateAsync(
        picked.map((definitionId) => ({
          definitionId,
          intensity: picks.intensities[definitionId] ?? 0,
          occurredAt: occurredAtIso,
          note: note.trim() ? note.trim() : undefined,
          episodeId: linkedEpisodeId ?? undefined,
        })),
      );
    } catch (err) {
      const saved = err instanceof SymptomSaveError ? err.saved : [];
      // Keep only what did not land, so Save again writes the rest once.
      picks.keepOnly(picked.filter((id) => !saved.includes(id)));
      const reason = localizedApiError(
        err instanceof SymptomSaveError ? err.cause : err,
        t,
        "symptoms.saveError",
      );
      setError(
        saved.length > 0
          ? `${t("symptoms.entry.partlySaved", { saved: saved.length, total: picked.length })} ${reason}`
          : reason,
      );
      return;
    }
    const [only] = picked;
    showEntrySavedToast({
      t,
      label: picked
        .map((id) => labelById.get(id) ?? t("symptoms.unreadableLabel"))
        .join(", "),
      value:
        picked.length === 1 && only !== undefined
          ? t("symptoms.entry.intensityShort", {
              value: picks.intensities[only] ?? 0,
              max: SYMPTOM_INTENSITY_MAX,
            })
          : undefined,
      recordName,
      undo: canDefine
        ? async () => {
            await removeSavedSymptomEvents(events.map((e) => e.id));
            void invalidateSymptomReads(queryClient);
          }
        : undefined,
      edit: { kind: "symptom", ids: events.map((e) => e.id) },
    });
    resetForm();
    onSuccess?.();
  }

  const footerNode = (
    <SymptomEntryFooter
      busy={busy}
      formId={formId}
      onReset={resetForm}
      onCancel={onCancel}
    />
  );

  const symptomGroupId = `${formId}-symptom`;

  return (
    <form
      id={formId}
      onSubmit={handleSubmit}
      className="space-y-4"
      data-testid="symptom-entry-form"
    >
      <SymptomPicker
        key={pickerKey}
        groupId={symptomGroupId}
        definitions={definitions}
        picked={picked}
        onToggle={togglePick}
        canDefine={canDefine}
        atLimit={atLimit}
        limit={limit}
        error={symptomError}
        autoFocus
      />

      {(picked.length === 0 ? [DRAFT] : picked).map((id) => (
        <IntensitySlider
          key={id}
          testId={id === DRAFT ? undefined : "symptom-intensity"}
          label={
            picked.length > 1
              ? t("symptoms.entry.intensityFor", {
                  symptom: labelById.get(id) ?? t("symptoms.unreadableLabel"),
                })
              : t("symptoms.entry.intensity")
          }
          value={picks.intensities[id] ?? null}
          onChange={(next) => picks.setIntensity(id, next)}
          showError={picks.missing.has(id)}
          preset={picks.preset.has(id)}
        />
      ))}

      <FieldGroup
        htmlFor={`${formId}-occurred-at`}
        label={t("measurements.timestamp")}
        hint={t("symptoms.entry.whenHint")}
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

      <EpisodeLinkField
        id={`${formId}-episode`}
        value={linkedEpisodeId}
        onChange={setEpisodeId}
        options={episodeOptions}
      />

      <FieldGroup
        htmlFor={`${formId}-note`}
        label={
          <>
            {t("common.note")}
            <span className="text-muted-foreground ml-1 font-normal">
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

/** The slider shown before any symptom is picked; the first pick takes it. */
const DRAFT = "";

/**
 * The picked symptoms in the order they were picked, each one's intensity,
 * and which still lack one. The draft slider's value moves to the first pick.
 */
function useSymptomPicks() {
  const [picked, setPicked] = useState<string[]>([]);
  const [intensities, setIntensities] = useState<Record<string, number | null>>(
    {},
  );
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  // The picks whose intensity is still the preset from their last occurrence.
  const [preset, setPreset] = useState<Set<string>>(() => new Set());

  /** Toggles `id`; a new pick starts on `last`, its previous intensity. */
  function toggle(id: string, last?: number) {
    if (picked.includes(id)) {
      setPicked(picked.filter((p) => p !== id));
      return;
    }
    const draft = picked.length === 0 ? (intensities[DRAFT] ?? null) : null;
    if (draft !== null) {
      setIntensities((prev) => ({ ...prev, [id]: draft }));
      setMissing(new Set());
    } else if (last !== undefined && (intensities[id] ?? null) === null) {
      setIntensities((prev) => ({ ...prev, [id]: last }));
      setPreset((prev) => new Set(prev).add(id));
    }
    setPicked([...picked, id]);
  }

  function setIntensity(id: string, value: number | null) {
    setPreset((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setIntensities((prev) => ({ ...prev, [id]: value }));
    setMissing((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  /** Marks every row without an intensity; true when none is missing. */
  function validate(): boolean {
    const rows = picked.length === 0 ? [DRAFT] : picked;
    const unset = rows.filter((id) => (intensities[id] ?? null) === null);
    setMissing(new Set(unset));
    return picked.length > 0 && unset.length === 0;
  }

  function reset() {
    setPicked([]);
    setIntensities({});
    setMissing(new Set());
    setPreset(new Set());
  }

  return {
    picked,
    intensities,
    missing,
    preset,
    toggle,
    setIntensity,
    validate,
    reset,
    keepOnly: setPicked,
  };
}

/** One 0-10 intensity slider with its inline error. */
function IntensitySlider({
  label,
  value,
  onChange,
  showError,
  testId,
  preset,
}: {
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
  showError: boolean;
  testId?: string;
  /** The value is the symptom's last intensity, not one chosen today. */
  preset: boolean;
}) {
  const { t } = useTranslations();
  const low = t("symptoms.entry.anchorLow");
  const high = t("symptoms.entry.anchorHigh");
  return (
    <div className="space-y-2" data-testid={testId}>
      <SliderField
        label={label}
        value={value}
        onValueChange={onChange}
        min={SYMPTOM_INTENSITY_MIN}
        max={SYMPTOM_INTENSITY_MAX}
        step={1}
        lowAnchor={low}
        highAnchor={high}
        emptyLabel={t("symptoms.entry.intensityUnset")}
        valueText={
          value === null
            ? undefined
            : t("symptoms.entry.intensityValueText", {
                value,
                max: SYMPTOM_INTENSITY_MAX,
                low,
                high,
              })
        }
      />
      {preset ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid="symptom-intensity-preset"
        >
          {t("symptoms.entry.intensityPreset")}
        </p>
      ) : null}
      {showError ? (
        <p role="alert" className="text-destructive text-sm">
          {t("symptoms.entry.intensityRequired")}
        </p>
      ) : null}
    </div>
  );
}

/** The action row: the reset menu, Cancel and Save, portalled by the form. */
function SymptomEntryFooter({
  busy,
  formId,
  onReset,
  onCancel,
}: {
  busy: boolean;
  formId: string;
  onReset: () => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslations();
  return (
    <ActionPair>
      <ActionMenu disabled={busy}>
        <DropdownMenuItem onClick={onReset}>
          <RotateCcw className="mr-2 size-4" />
          {t("symptoms.entry.reset")}
        </DropdownMenuItem>
      </ActionMenu>
      {onCancel && (
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
        >
          {t("common.cancel")}
        </Button>
      )}
      <Button type="submit" form={formId} disabled={busy}>
        {busy ? (
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        ) : null}
        {t("common.save")}
      </Button>
    </ActionPair>
  );
}
