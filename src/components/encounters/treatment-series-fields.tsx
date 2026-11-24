"use client";

/**
 * The treatment-series form's fields. The condition picker follows the
 * illness module, like the visit form's link pickers: off, it is not there.
 */
import { Stethoscope } from "lucide-react";

import { DateField } from "@/components/ui/date-field";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  EntityLinkPicker,
  serverPagingFrom,
} from "@/components/links/entity-link-picker";
import {
  pickerPivot,
  useLinkPickerPages,
} from "@/components/links/use-link-picker-pages";
import { useAuth } from "@/hooks/use-auth";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { IllnessEpisodeDTO } from "@/lib/illness/dto";
import { queryKeys } from "@/lib/query-keys";

import { ENCOUNTER_KINDS, encounterKindText } from "./encounter-labels";
import { fetchEpisodePage } from "./encounter-link-pickers";
import { PractitionerCombobox } from "./practitioner-combobox";
import type { TreatmentSeriesDraft } from "./treatment-series-draft";

export function TreatmentSeriesFields({
  draft,
  patch,
  enabled,
}: {
  draft: TreatmentSeriesDraft;
  patch: (part: Partial<TreatmentSeriesDraft>) => void;
  /** False while the sheet is closed, so the picker does not read. */
  enabled: boolean;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const { user } = useAuth();
  const illnessOn = user?.modules?.illness === true;
  const episodes = useLinkPickerPages<IllnessEpisodeDTO>({
    enabled: enabled && illnessOn,
    pivot: pickerPivot(draft.startsOn || null),
    queryKey: queryKeys.illnessEpisodesPicker,
    fetchPage: fetchEpisodePage,
  });

  return (
    <div className="space-y-4" data-slot="treatment-series-form">
      <FieldGroup
        htmlFor="series-title"
        label={t("treatmentSeries.form.title")}
      >
        <Input
          id="series-title"
          value={draft.title}
          maxLength={200}
          placeholder={t("treatmentSeries.form.titlePlaceholder")}
          onChange={(event) => patch({ title: event.target.value })}
          data-testid="series-title"
        />
      </FieldGroup>

      <div className="grid grid-cols-2 gap-3">
        <FieldGroup
          htmlFor="series-planned"
          label={t("treatmentSeries.form.plannedSessions")}
        >
          <Input
            id="series-planned"
            inputMode="numeric"
            value={draft.plannedSessions}
            onChange={(event) =>
              patch({ plannedSessions: event.target.value.replace(/\D/g, "") })
            }
            data-testid="series-planned"
          />
        </FieldGroup>
        <FieldGroup htmlFor="series-kind" label={t("encounters.form.kind")}>
          <NativeSelect
            id="series-kind"
            value={draft.kind}
            onChange={(event) => patch({ kind: event.target.value })}
          >
            {ENCOUNTER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {encounterKindText(t, kind)}
              </option>
            ))}
          </NativeSelect>
        </FieldGroup>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FieldGroup
          htmlFor="series-starts-on"
          label={t("treatmentSeries.form.startsOn")}
        >
          <DateField
            id="series-starts-on"
            value={draft.startsOn}
            onChange={(value) => patch({ startsOn: value })}
            required
            data-testid="series-starts-on"
          />
        </FieldGroup>
        <FieldGroup
          htmlFor="series-valid-until"
          label={t("treatmentSeries.form.validUntil")}
        >
          <DateField
            id="series-valid-until"
            value={draft.validUntil}
            min={draft.startsOn || undefined}
            onChange={(value) => patch({ validUntil: value })}
            data-testid="series-valid-until"
          />
        </FieldGroup>
      </div>

      <FieldGroup
        htmlFor="series-prescriber"
        label={t("treatmentSeries.prescriber")}
      >
        <PractitionerCombobox
          value={draft.prescriber?.id ?? null}
          selected={draft.prescriber}
          onChange={(next) => patch({ prescriber: next })}
          label={t("treatmentSeries.prescriber")}
          slot="series-prescriber-trigger"
        />
      </FieldGroup>
      <FieldGroup
        htmlFor="series-performer"
        label={t("treatmentSeries.performer")}
      >
        <PractitionerCombobox
          value={draft.performer?.id ?? null}
          selected={draft.performer}
          onChange={(next) => patch({ performer: next })}
          label={t("treatmentSeries.performer")}
          slot="series-performer-trigger"
        />
      </FieldGroup>

      {illnessOn ? (
        <EntityLinkPicker
          icon={Stethoscope}
          title={t("treatmentSeries.condition")}
          slot="series-condition"
          pending={episodes.pending}
          error={episodes.error}
          errorLabel={t("links.picker.loadError")}
          onRetry={episodes.retry}
          selected={draft.episodeId ? [draft.episodeId] : []}
          // One condition per series: the last pick replaces the first.
          onChange={(ids) => {
            const added = ids.find((id) => id !== draft.episodeId);
            const id =
              added ??
              (draft.episodeId && ids.includes(draft.episodeId)
                ? draft.episodeId
                : null);
            const picked = episodes.items.find((e) => e.id === id);
            patch({
              episodeId: id,
              conditionLabel:
                picked?.label ?? (id ? draft.conditionLabel : null),
            });
          }}
          options={episodes.items.map((episode) => ({
            id: episode.id,
            label: episode.label,
            dateLabel: episode.onsetAt ? format.date(episode.onsetAt) : null,
          }))}
          server={serverPagingFrom(episodes)}
          knownOptions={
            draft.episodeId && draft.conditionLabel
              ? [
                  {
                    id: draft.episodeId,
                    label: draft.conditionLabel,
                    dateLabel: null,
                  },
                ]
              : []
          }
          searchPlaceholder={t("links.picker.searchPlaceholder")}
          emptyLabel={t("encounters.form.linkNothingToOffer")}
        />
      ) : null}

      <FieldGroup htmlFor="series-note" label={t("treatmentSeries.form.note")}>
        <Textarea
          id="series-note"
          rows={2}
          value={draft.note}
          onChange={(event) => patch({ note: event.target.value })}
        />
      </FieldGroup>
    </div>
  );
}
