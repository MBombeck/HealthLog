"use client";

import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { FieldGroup } from "@/components/ui/field-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HeightFieldControl } from "@/components/profile/height-field-control";
import { useTranslations } from "@/lib/i18n/context";
import type {
  HeightDraft,
  HeightUnitAdapter,
} from "@/lib/profile/height-unit-display";

/**
 * The four profile inputs of the onboarding baseline step.
 *
 * Split out of `baseline-form.tsx` so the markup can be rendered on its
 * own against a server answer. The step's whole defect lived between
 * the response and these inputs — the server named a field it refused
 * and nothing on screen changed — so the seam a test needs is exactly
 * here: field values in, markup out.
 */

export interface BaselineFieldValues {
  displayName: string;
  height: HeightDraft;
  dateOfBirth: string;
  gender: string;
}

const IDS = {
  displayName: "ob-baseline-display-name",
  heightCm: "ob-baseline-height",
  dateOfBirth: "ob-baseline-dob",
  gender: "ob-baseline-gender",
} as const;

export function BaselineFields({
  value,
  onChange,
  heightAdapter,
}: {
  value: BaselineFieldValues;
  onChange: <K extends keyof BaselineFieldValues>(
    key: K,
    next: BaselineFieldValues[K],
  ) => void;
  heightAdapter: HeightUnitAdapter;
}) {
  const { t } = useTranslations();

  return (
    <fieldset className="bg-card border-border space-y-4 rounded-xl border p-4 md:p-6">
      <legend className="sr-only">{t("onboarding.baseline.title")}</legend>

      <FieldGroup
        htmlFor={IDS.displayName}
        label={t("onboarding.baseline.displayNameLabel")}
        hint={t("onboarding.baseline.displayNameHint")}
      >
        <Input
          id={IDS.displayName}
          value={value.displayName}
          onChange={(e) => onChange("displayName", e.target.value)}
          autoComplete="nickname"
          maxLength={50}
          placeholder={t("onboarding.baseline.displayNamePlaceholder")}
        />
      </FieldGroup>

      <div className="grid gap-4 sm:grid-cols-2">
        <FieldGroup
          htmlFor={IDS.heightCm}
          label={
            heightAdapter.usesFeetInches
              ? t("onboarding.baseline.heightLabelFtIn")
              : t("onboarding.baseline.heightLabel")
          }
        >
          <HeightFieldControl
            idPrefix={IDS.heightCm}
            adapter={heightAdapter}
            value={value.height}
            onChange={(next) => onChange("height", next)}
            autoComplete="off"
          />
        </FieldGroup>
        <FieldGroup
          htmlFor={IDS.gender}
          label={t("onboarding.baseline.genderLabel")}
        >
          <Select
            // The design system's Radix Select uses an empty-string
            // sentinel to mean "no selection"; map back and forth so
            // the form state ("") and the Select's value (undefined-
            // adjacent) stay aligned. v1.4.25 W21 Fix-N (design-M1).
            value={value.gender === "" ? undefined : value.gender}
            onValueChange={(next) => onChange("gender", next)}
          >
            <SelectTrigger
              id={IDS.gender}
              className="w-full"
              data-slot="onboarding-baseline-gender"
            >
              <SelectValue placeholder={t("onboarding.baseline.genderNone")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MALE">
                {t("onboarding.baseline.genderMale")}
              </SelectItem>
              <SelectItem value="FEMALE">
                {t("onboarding.baseline.genderFemale")}
              </SelectItem>
              <SelectItem value="OTHER">
                {t("onboarding.baseline.genderOther")}
              </SelectItem>
            </SelectContent>
          </Select>
        </FieldGroup>
      </div>

      <FieldGroup
        htmlFor={IDS.dateOfBirth}
        label={t("onboarding.baseline.dateOfBirthLabel")}
        hint={t("onboarding.baseline.dateOfBirthHint")}
      >
        <DateField
          id={IDS.dateOfBirth}
          value={value.dateOfBirth}
          onChange={(next) => onChange("dateOfBirth", next)}
          max={new Date().toISOString().slice(0, 10)}
          autoComplete="bday"
        />
      </FieldGroup>
    </fieldset>
  );
}
