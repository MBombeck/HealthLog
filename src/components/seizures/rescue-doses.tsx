"use client";

/**
 * The rescue doses of a recorded seizure (#1368): what was given, when and
 * how, and whether it worked, which is usually known only afterwards. Adding
 * one also records the dose on the as-needed medication; removing one takes
 * it off again.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateTimeField } from "@/components/ui/date-time-field";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldGroup } from "@/components/ui/field-group";
import { NativeSelect } from "@/components/ui/native-select";
import { localizedApiError } from "@/lib/api/localized-error";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  SEIZURE_RESCUE_EFFECTS,
  SEIZURE_RESCUE_ROUTES,
  type SeizureEventDTO,
} from "@/lib/seizures/shared";

import { nowLocalValue, toLocalValue } from "./seizure-format";
import { useRescueDoseMutations, useRescueMedications } from "./use-seizures";

/** The doses given for a recorded seizure, with their effect, editable. */
export function RescueDoses({
  event,
  canManage,
}: {
  event: SeizureEventDTO;
  canManage: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { create, update, remove } = useRescueDoseMutations();
  const meds = useRescueMedications();
  const [medicationId, setMedicationId] = useState("");
  const [givenAt, setGivenAt] = useState(() => toLocalValue(event.onsetAt));
  const [route, setRoute] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    try {
      await create.mutateAsync({
        eventId: event.id,
        body: {
          medicationId,
          givenAt: new Date(givenAt).toISOString(),
          route: route || null,
        },
      });
      setMedicationId("");
    } catch (err) {
      setError(localizedApiError(err, t, "seizures.saveError"));
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="seizure-rescue-heading">
      <h3 id="seizure-rescue-heading" className="text-sm font-medium">
        {t("seizures.rescue.title")}
      </h3>
      {event.rescueDoses.length === 0 ? (
        <EmptyState
          variant="plain"
          size="compact"
          title={t("seizures.rescue.none")}
        />
      ) : (
        <ul className="space-y-3">
          {event.rescueDoses.map((d) => (
            <li key={d.id} className="space-y-2 rounded-lg border p-3">
              <p className="text-foreground text-sm">
                {d.medicationName}
                {d.doseAmount !== null
                  ? `, ${d.doseAmount}${d.doseUnit ? ` ${d.doseUnit}` : ""}`
                  : ""}
                {d.route ? `, ${t(`seizures.route.${d.route}`)}` : ""}
              </p>
              <p className="text-muted-foreground text-xs">
                {fmt.dateTime(d.givenAt)}
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <FieldGroup
                  htmlFor={`rescue-effect-${d.id}`}
                  label={t("seizures.rescue.effect")}
                  className="min-w-40 flex-1"
                >
                  <NativeSelect
                    id={`rescue-effect-${d.id}`}
                    value={d.effect}
                    disabled={!canManage || update.isPending}
                    onChange={(e) =>
                      void update.mutateAsync({
                        eventId: event.id,
                        doseId: d.id,
                        body: { effect: e.target.value },
                      })
                    }
                    className="w-full"
                  >
                    {SEIZURE_RESCUE_EFFECTS.map((v) => (
                      <option key={v} value={v}>
                        {t(`seizures.effect.${v}`)}
                      </option>
                    ))}
                  </NativeSelect>
                </FieldGroup>
                {canManage ? (
                  <ConfirmButton
                    label={t("seizures.rescue.remove")}
                    title={t("seizures.rescue.removeTitle")}
                    body={t("seizures.rescue.removeBody")}
                    confirmLabel={t("seizures.rescue.remove")}
                    destructive
                    variant="ghost"
                    size="sm"
                    slot="seizure-rescue-remove"
                    onConfirm={() =>
                      void remove.mutateAsync({
                        eventId: event.id,
                        doseId: d.id,
                      })
                    }
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {meds.options.length > 0 ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <FieldGroup
            htmlFor="rescue-add-medication"
            label={t("seizures.rescue.medication")}
          >
            <NativeSelect
              id="rescue-add-medication"
              value={medicationId}
              onChange={(e) => setMedicationId(e.target.value)}
              className="w-full"
            >
              <option value="">{t("seizures.rescue.pick")}</option>
              {meds.options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.dose ? ` (${m.dose})` : ""}
                </option>
              ))}
            </NativeSelect>
          </FieldGroup>
          <FieldGroup
            htmlFor="rescue-add-given-at"
            label={t("seizures.rescue.givenAt")}
          >
            <DateTimeField
              id="rescue-add-given-at"
              value={givenAt}
              onChange={setGivenAt}
              max={nowLocalValue()}
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="rescue-add-route"
            label={t("seizures.rescue.route")}
          >
            <NativeSelect
              id="rescue-add-route"
              value={route}
              onChange={(e) => setRoute(e.target.value)}
              className="w-full"
            >
              <option value="">{t("seizures.notRecorded")}</option>
              {SEIZURE_RESCUE_ROUTES.map((v) => (
                <option key={v} value={v}>
                  {t(`seizures.route.${v}`)}
                </option>
              ))}
            </NativeSelect>
          </FieldGroup>
          <p className="text-muted-foreground text-xs">
            {t("seizures.rescue.intakeHint")}
          </p>
          <Button
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={!medicationId || create.isPending}
            onClick={add}
            data-slot="seizure-rescue-add"
          >
            {t("seizures.rescue.add")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}
