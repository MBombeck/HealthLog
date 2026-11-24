"use client";

/**
 * Set up or edit one of the person's seizure types (#1368), ideally together
 * with the care team: the family's own name for it, the ILAE classification
 * in two steps (onset class, then type, with "not sure" at the second step
 * recording the class itself, as the 2025 paper advises), how long it usually
 * lasts, and the rescue plan.
 *
 * The classification is chosen by the person or the clinician; the app never
 * suggests one.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Textarea } from "@/components/ui/textarea";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import {
  ILAE_TYPE_INFO,
  SEIZURE_ILAE_CLASSES,
  ilaeClassOf,
  ilaeLabelKey,
  ilaeTypesOfClass,
  type SeizureIlaeClass,
  type SeizureIlaeType,
} from "@/lib/seizures/ilae";
import {
  SEIZURE_RESCUE_ROUTES,
  type SeizureTypeDTO,
} from "@/lib/seizures/shared";

import { ilaeLine } from "./seizure-format";
import {
  useRescueMedications,
  useSeizureTypeMutations,
  type RescueMedicationOption,
  type SeizureTypeBody,
} from "./use-seizures";

export function SeizureTypeSheet({
  open,
  onClose,
  type,
}: {
  open: boolean;
  onClose: () => void;
  type: SeizureTypeDTO | null;
}) {
  const { t } = useTranslations();
  const { create, update } = useSeizureTypeMutations();
  const meds = useRescueMedications(open);
  const [label, setLabel] = useState(type?.label ?? "");
  const [ilaeClass, setIlaeClass] = useState<SeizureIlaeClass>(
    type ? ilaeClassOf(type.ilaeType) : "FOCAL",
  );
  const [ilaeType, setIlaeType] = useState<SeizureIlaeType>(
    type?.ilaeType ?? ilaeTypesOfClass("FOCAL").at(-1)!,
  );
  const usual = type?.usualDurationSec ?? null;
  const [usualMin, setUsualMin] = useState(
    usual === null ? "" : String(Math.floor(usual / 60)),
  );
  const [usualSec, setUsualSec] = useState(
    usual === null ? "" : String(usual % 60),
  );
  const [plan, setPlan] = useState(type?.rescuePlan ?? "");
  const [medicationId, setMedicationId] = useState(
    type?.rescueMedicationId ?? "",
  );
  const [doseAmount, setDoseAmount] = useState(
    type?.rescueDoseAmount == null ? "" : String(type.rescueDoseAmount),
  );
  const [doseUnit, setDoseUnit] = useState(type?.rescueDoseUnit ?? "");
  const [route, setRoute] = useState<string>(type?.rescueRoute ?? "");
  const [error, setError] = useState<string | null>(null);
  const editing = type !== null;

  function pickClass(next: SeizureIlaeClass) {
    setIlaeClass(next);
    // "Not sure" is the class's own entry; it is the safe landing.
    setIlaeType(ilaeTypesOfClass(next).at(-1)!);
  }

  async function save() {
    setError(null);
    const min = usualMin.trim() === "" ? null : Number(usualMin);
    const sec = usualSec.trim() === "" ? null : Number(usualSec);
    const usualDurationSec =
      min === null && sec === null ? null : (min ?? 0) * 60 + (sec ?? 0);
    const amount =
      doseAmount.trim() === "" ? null : Number(doseAmount.replace(",", "."));
    const body: SeizureTypeBody = {
      label: label.trim(),
      ilaeType,
      usualDurationSec:
        usualDurationSec && usualDurationSec > 0 ? usualDurationSec : null,
      rescuePlan: plan.trim() ? plan.trim() : null,
      rescueMedicationId: medicationId || null,
      rescueDoseAmount: amount !== null && amount > 0 ? amount : null,
      rescueDoseUnit: doseUnit.trim() ? doseUnit.trim() : null,
      rescueRoute: route || null,
    };
    try {
      if (editing) {
        await update.mutateAsync({ id: type.id, body });
      } else {
        await create.mutateAsync(body);
      }
      toastWrittenOutcome("success", t("seizures.types.saved"));
      onClose();
    } catch (err) {
      setError(localizedApiError(err, t, "seizures.saveError"));
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t(
        editing ? "seizures.types.editTitle" : "seizures.types.newTitle",
      )}
      description={t("seizures.types.description")}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={save}
            disabled={!label.trim() || create.isPending || update.isPending}
            data-slot="seizure-type-save"
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FieldGroup
          htmlFor="seizure-type-label"
          label={t("seizures.types.label")}
          hint={t("seizures.types.labelHint")}
        >
          <Input
            id="seizure-type-label"
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
            autoCapitalize="sentences"
          />
        </FieldGroup>
        <ClassificationFields
          ilaeClass={ilaeClass}
          ilaeType={ilaeType}
          onClass={pickClass}
          onType={setIlaeType}
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            {t("seizures.types.usualDuration")}
          </legend>
          <div className="grid grid-cols-2 gap-4">
            <FieldGroup
              htmlFor="seizure-type-usual-min"
              label={t("seizures.sheet.minutes")}
            >
              <Input
                id="seizure-type-usual-min"
                inputMode="numeric"
                value={usualMin}
                onChange={(e) => setUsualMin(e.target.value.replace(/\D/g, ""))}
              />
            </FieldGroup>
            <FieldGroup
              htmlFor="seizure-type-usual-sec"
              label={t("seizures.sheet.seconds")}
            >
              <Input
                id="seizure-type-usual-sec"
                inputMode="numeric"
                value={usualSec}
                onChange={(e) => setUsualSec(e.target.value.replace(/\D/g, ""))}
              />
            </FieldGroup>
          </div>
          <p className="text-muted-foreground text-xs">
            {t("seizures.types.usualHint")}
          </p>
        </fieldset>
        <FieldGroup
          htmlFor="seizure-type-plan"
          label={t("seizures.types.plan")}
          hint={t("seizures.types.planHint")}
        >
          <Textarea
            id="seizure-type-plan"
            value={plan}
            maxLength={2000}
            rows={4}
            onChange={(e) => setPlan(e.target.value)}
          />
        </FieldGroup>
        <RescuePlanFields
          type={type}
          options={meds.options}
          loading={meds.isLoading}
          value={{ medicationId, doseAmount, doseUnit, route }}
          onChange={{ setMedicationId, setDoseAmount, setDoseUnit, setRoute }}
        />
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {editing ? (
          <TypeActions type={type} onClose={onClose} onError={setError} />
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}

interface RescuePlanValue {
  medicationId: string;
  doseAmount: string;
  doseUnit: string;
  route: string;
}

/** The rescue part of a type's plan: the as-needed medication and its dose. */
function RescuePlanFields({
  type,
  options,
  loading,
  value: { medicationId, doseAmount, doseUnit, route },
  onChange: { setMedicationId, setDoseAmount, setDoseUnit, setRoute },
}: {
  type: SeizureTypeDTO | null;
  options: RescueMedicationOption[];
  loading: boolean;
  value: RescuePlanValue;
  onChange: {
    setMedicationId: (v: string) => void;
    setDoseAmount: (v: string) => void;
    setDoseUnit: (v: string) => void;
    setRoute: (v: string) => void;
  };
}) {
  const { t } = useTranslations();
  const meds = { options, isLoading: loading };
  return (
    <>
      <FieldGroup
        htmlFor="seizure-type-medication"
        label={t("seizures.types.rescueMedication")}
        hint={
          meds.options.length === 0 && !meds.isLoading
            ? t("seizures.types.noAsNeeded")
            : undefined
        }
      >
        <NativeSelect
          id="seizure-type-medication"
          value={medicationId}
          onChange={(e) => setMedicationId(e.target.value)}
          className="w-full"
        >
          <option value="">{t("seizures.types.noMedication")}</option>
          {meds.options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.dose ? ` (${m.dose})` : ""}
            </option>
          ))}
          {type?.rescueMedicationId &&
          !meds.options.some((m) => m.id === type.rescueMedicationId) ? (
            <option value={type.rescueMedicationId}>
              {type.rescueMedicationName ?? type.rescueMedicationId}
            </option>
          ) : null}
        </NativeSelect>
      </FieldGroup>
      {medicationId ? (
        <div className="grid grid-cols-2 gap-4">
          <FieldGroup
            htmlFor="seizure-type-dose"
            label={t("seizures.types.dose")}
          >
            <Input
              id="seizure-type-dose"
              inputMode="decimal"
              value={doseAmount}
              onChange={(e) => setDoseAmount(e.target.value)}
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="seizure-type-unit"
            label={t("seizures.types.unit")}
          >
            <Input
              id="seizure-type-unit"
              value={doseUnit}
              maxLength={20}
              placeholder="mg"
              onChange={(e) => setDoseUnit(e.target.value)}
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="seizure-type-route"
            label={t("seizures.rescue.route")}
            className="col-span-2"
          >
            <NativeSelect
              id="seizure-type-route"
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
        </div>
      ) : null}
    </>
  );
}

/** Archive or delete a type. A type seizures name can only be archived. */
function TypeActions({
  type,
  onClose,
  onError,
}: {
  type: SeizureTypeDTO;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslations();
  const { update, remove } = useSeizureTypeMutations();
  const setError = onError;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        className="min-h-11 sm:min-h-9"
        disabled={update.isPending}
        onClick={async () => {
          try {
            await update.mutateAsync({
              id: type.id,
              body: { archived: !type.archived },
            });
            onClose();
          } catch (err) {
            setError(localizedApiError(err, t, "seizures.saveError"));
          }
        }}
      >
        {t(
          type.archived ? "seizures.types.unarchive" : "seizures.types.archive",
        )}
      </Button>
      <ConfirmButton
        label={t("seizures.types.delete")}
        title={t("seizures.types.deleteTitle")}
        body={t("seizures.types.deleteBody")}
        confirmLabel={t("seizures.types.delete")}
        destructive
        slot="seizure-type-delete"
        pending={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(type.id);
            onClose();
          } catch (err) {
            setError(localizedApiError(err, t, "seizures.saveError"));
          }
        }}
      />
    </div>
  );
}

/** The two-step ILAE pick: onset class, then type ("not sure" = the class). */
function ClassificationFields({
  ilaeClass,
  ilaeType,
  onClass,
  onType,
}: {
  ilaeClass: SeizureIlaeClass;
  ilaeType: SeizureIlaeType;
  onClass: (c: SeizureIlaeClass) => void;
  onType: (t: SeizureIlaeType) => void;
}) {
  const { t } = useTranslations();
  const pickClass = onClass;
  const setIlaeType = onType;
  return (
    <>
      <FieldGroup
        htmlFor="seizure-type-class"
        label={t("seizures.types.class")}
      >
        <NativeSelect
          id="seizure-type-class"
          value={ilaeClass}
          onChange={(e) => pickClass(e.target.value as SeizureIlaeClass)}
          className="w-full"
        >
          {SEIZURE_ILAE_CLASSES.map((c) => (
            <option key={c} value={c}>
              {t(`seizures.ilaeClass.${c}`)}
            </option>
          ))}
        </NativeSelect>
      </FieldGroup>
      {ilaeClass !== "UNCLASSIFIED" ? (
        <FieldGroup
          htmlFor="seizure-type-ilae"
          label={t("seizures.types.ilaeType")}
          hint={ilaeLine(ilaeType, t)}
        >
          <NativeSelect
            id="seizure-type-ilae"
            value={ilaeType}
            onChange={(e) => setIlaeType(e.target.value as SeizureIlaeType)}
            className="w-full"
          >
            {ilaeTypesOfClass(ilaeClass).map((v) => (
              <option key={v} value={v}>
                {ILAE_TYPE_INFO[v].isParent
                  ? t("seizures.types.notSure", {
                      name: t(ilaeLabelKey(v)),
                    })
                  : t(ilaeLabelKey(v))}
              </option>
            ))}
          </NativeSelect>
        </FieldGroup>
      ) : null}
    </>
  );
}
