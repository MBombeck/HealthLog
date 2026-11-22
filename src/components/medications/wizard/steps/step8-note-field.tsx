"use client";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "@/lib/i18n/context";
import { MEDICATION_NOTE_MAX_CHARS } from "@/lib/medications/note-limits";

import type { StepProps } from "./step1-name";
import { Step8LeafletField } from "./step8-leaflet-field";

/**
 * #1371 — the medication's own note, for directions such as "30 to 60
 * minutes before food". Shown on the medication and when a dose is logged.
 * Optional; clearing it on an edit removes the stored note.
 */
export function Step8NoteField({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  return (
    <div className="space-y-1.5" data-slot="wizard-note">
      <Label htmlFor="wizard-note" className="text-sm font-medium">
        {t("medications.note.label")}
      </Label>
      <Textarea
        id="wizard-note"
        value={payload.note}
        onChange={(e) => applyPartial({ note: e.target.value })}
        placeholder={t("medications.note.placeholder")}
        maxLength={MEDICATION_NOTE_MAX_CHARS}
        rows={2}
        aria-describedby="wizard-note-helper"
        data-slot="wizard-note-input"
      />
      <p id="wizard-note-helper" className="text-muted-foreground text-xs">
        {t("medications.note.helper")}
      </p>
    </div>
  );
}

/** The last step's free-standing fields: the note and the leaflet link. */
export function Step8ExtrasFields(props: StepProps) {
  return (
    <>
      <Step8NoteField {...props} />
      <Step8LeafletField {...props} />
    </>
  );
}
