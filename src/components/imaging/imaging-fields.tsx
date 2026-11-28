"use client";

/**
 * The exam's fields in its sheet (#1672): type, day, body part, side, clinic,
 * requesting doctor and conclusion. A controlled draft; the sheet owns it.
 */
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "@/lib/i18n/context";
import {
  IMAGING_MODALITIES,
  IMAGING_SIDES,
  IMAGING_TEXT_MAX,
  type ImagingModality,
  type ImagingSide,
} from "@/lib/imaging/shared";

/** Select sentinel for "not sided". */
export const SIDE_NONE = "NONE";

export interface ImagingDraft {
  modality: ImagingModality | "";
  day: string;
  side: ImagingSide | typeof SIDE_NONE;
  bodyPart: string;
  facility: string;
  requestingDoctor: string;
  conclusion: string;
  documentIds: string[];
}

export function ImagingFields({
  draft,
  set,
  today,
}: {
  draft: ImagingDraft;
  set: <K extends keyof ImagingDraft>(key: K, value: ImagingDraft[K]) => void;
  /** The record's today, the date field's upper bound. */
  today: string;
}) {
  const { t } = useTranslations();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="imaging-modality">{t("imaging.form.modality")}</Label>
        <Select
          value={draft.modality}
          onValueChange={(value) => set("modality", value as ImagingModality)}
        >
          <SelectTrigger
            id="imaging-modality"
            className="w-full"
            data-slot="imaging-modality"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {IMAGING_MODALITIES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`imaging.modality.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="imaging-day">{t("imaging.form.date")}</Label>
        <DateField
          id="imaging-day"
          value={draft.day}
          max={today}
          onChange={(value) => set("day", value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="imaging-body-part">{t("imaging.form.bodyPart")}</Label>
        <Input
          id="imaging-body-part"
          value={draft.bodyPart}
          maxLength={IMAGING_TEXT_MAX.bodyPart}
          onChange={(e) => set("bodyPart", e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="imaging-side">{t("imaging.form.side")}</Label>
        <Select
          value={draft.side}
          onValueChange={(value) => set("side", value as ImagingDraft["side"])}
        >
          <SelectTrigger id="imaging-side" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SIDE_NONE}>
              {t("imaging.form.sideNone")}
            </SelectItem>
            {IMAGING_SIDES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`imaging.side.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="imaging-facility">{t("imaging.form.facility")}</Label>
        <Input
          id="imaging-facility"
          value={draft.facility}
          maxLength={IMAGING_TEXT_MAX.facility}
          onChange={(e) => set("facility", e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="imaging-doctor">
          {t("imaging.form.requestingDoctor")}
        </Label>
        <Input
          id="imaging-doctor"
          value={draft.requestingDoctor}
          maxLength={IMAGING_TEXT_MAX.requestingDoctor}
          onChange={(e) => set("requestingDoctor", e.target.value)}
        />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="imaging-conclusion">
          {t("imaging.form.conclusion")}
        </Label>
        <Textarea
          id="imaging-conclusion"
          value={draft.conclusion}
          maxLength={IMAGING_TEXT_MAX.conclusion}
          rows={3}
          onChange={(e) => set("conclusion", e.target.value)}
        />
      </div>
    </div>
  );
}
