"use client";

/**
 * The two edit sheets of the symptoms section (v1.40): one occurrence (how
 * strong, when, the note) and one symptom (its name and icon). Same
 * `ResponsiveSheet` + `FieldGroup` + `SliderField` vocabulary as the entry
 * form, with Cancel + Save in the sheet footer like the illness day sheet.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DateTimeField } from "@/components/ui/date-time-field";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SliderField } from "@/components/ui/slider";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import {
  SYMPTOM_INTENSITY_MAX,
  SYMPTOM_INTENSITY_MIN,
  type SymptomDefinitionDTO,
  type SymptomEventDTO,
} from "@/lib/symptoms/shared";

import { SymptomIconPicker } from "./symptom-icon-picker";
import {
  useUpdateSymptomDefinition,
  useUpdateSymptomEvent,
} from "./use-symptoms";

/** An instant as the `DateTimeField` value: local wall time, minute grain. */
function toLocalValue(iso: string): string {
  const at = new Date(iso);
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function nowLocalValue(): string {
  return toLocalValue(new Date().toISOString());
}

export function EditSymptomEventSheet({
  event,
  label,
  onClose,
}: {
  event: SymptomEventDTO;
  label: string;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const update = useUpdateSymptomEvent();
  const [intensity, setIntensity] = useState<number>(event.intensity);
  const [occurredAt, setOccurredAt] = useState(toLocalValue(event.occurredAt));
  const [note, setNote] = useState(event.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const low = t("symptoms.entry.anchorLow");
  const high = t("symptoms.entry.anchorHigh");

  async function handleSave() {
    setError(null);
    try {
      await update.mutateAsync({
        id: event.id,
        input: {
          intensity,
          occurredAt: new Date(occurredAt).toISOString(),
          note: note.trim() ? note.trim() : null,
        },
      });
      onClose();
    } catch (err) {
      setError(localizedApiError(err, t, "symptoms.saveError"));
    }
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("symptoms.section.editEventTitle", { symptom: label })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={update.isPending}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <SliderField
          label={t("symptoms.entry.intensity")}
          value={intensity}
          onValueChange={setIntensity}
          min={SYMPTOM_INTENSITY_MIN}
          max={SYMPTOM_INTENSITY_MAX}
          step={1}
          lowAnchor={low}
          highAnchor={high}
          emptyLabel={t("symptoms.entry.intensityUnset")}
          valueText={t("symptoms.entry.intensityValueText", {
            value: intensity,
            max: SYMPTOM_INTENSITY_MAX,
            low,
            high,
          })}
        />
        <FieldGroup
          htmlFor="symptom-event-occurred-at"
          label={t("symptoms.entry.when")}
        >
          <DateTimeField
            id="symptom-event-occurred-at"
            value={occurredAt}
            onChange={setOccurredAt}
            max={nowLocalValue()}
            required
          />
        </FieldGroup>
        <FieldGroup
          htmlFor="symptom-event-note"
          label={
            <>
              {t("symptoms.entry.note")}
              <span className="text-muted-foreground ml-1 font-normal">
                ({t("common.optional")})
              </span>
            </>
          }
        >
          <Input
            id="symptom-event-note"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            autoCapitalize="sentences"
          />
        </FieldGroup>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}

export function EditSymptomDefinitionSheet({
  definition,
  onClose,
}: {
  definition: SymptomDefinitionDTO;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const update = useUpdateSymptomDefinition();
  const [label, setLabel] = useState(definition.label ?? "");
  const [icon, setIcon] = useState<string>(definition.icon ?? "Tag");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    const trimmed = label.trim();
    if (!trimmed) {
      setLabelError(t("symptoms.nameRequired"));
      return;
    }
    try {
      await update.mutateAsync({
        id: definition.id,
        input: { label: trimmed, icon },
      });
      onClose();
    } catch (err) {
      setError(localizedApiError(err, t, "symptoms.saveError"));
    }
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("symptoms.section.editSymptomTitle")}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={update.isPending}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FieldGroup
          htmlFor="symptom-definition-label"
          label={t("symptoms.nameLabel")}
          error={labelError}
        >
          <Input
            id="symptom-definition-label"
            value={label}
            maxLength={40}
            aria-invalid={labelError ? true : undefined}
            aria-describedby={
              labelError ? "symptom-definition-label-error" : undefined
            }
            onChange={(e) => {
              setLabel(e.target.value);
              setLabelError(null);
            }}
          />
        </FieldGroup>
        <div className="space-y-2">
          <Label>{t("symptoms.iconLabel")}</Label>
          <SymptomIconPicker
            value={icon}
            onChange={setIcon}
            label={t("symptoms.iconLabel")}
          />
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}
