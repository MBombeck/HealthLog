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
 * here: field values in, field rejections in, markup out.
 *
 * Each field id doubles as the id of its error paragraph
 * (`<id>-error`), which is what the control points `aria-describedby`
 * at, so a rejection is announced with the input rather than only
 * painted next to it.
 */

export interface BaselineFieldValues {
  displayName: string;
  height: HeightDraft;
  dateOfBirth: string;
  gender: string;
}

/**
 * Per-field sentences keyed by the SCHEMA field name the server uses
 * (`heightCm`, not `height`) — the key the rejection arrives under, so
 * nothing has to be renamed between the wire and the slot.
 */
export type BaselineFieldErrors = Partial<
  Record<"displayName" | "heightCm" | "dateOfBirth" | "gender", string>
>;

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
  errors,
  readOnlyDisplayName = false,
}: {
  value: BaselineFieldValues;
  onChange: <K extends keyof BaselineFieldValues>(
    key: K,
    next: BaselineFieldValues[K],
  ) => void;
  heightAdapter: HeightUnitAdapter;
  errors: BaselineFieldErrors;
  /**
   * v1.39 — the instance cannot persist a display name, so the box does not
   * take one. True under `DEMO_MODE`, where `applyProfileUpdate` writes only
   * height, date of birth and sex: the demo's single published account means
   * a display name typed here would be the next visitor's. A field that
   * accepts input and silently discards it is the same dishonesty as a save
   * that fails, which is why it is disabled rather than merely ignored.
   */
  readOnlyDisplayName?: boolean;
}) {
  const { t } = useTranslations();

  return (
    <fieldset className="bg-card border-border space-y-4 rounded-xl border p-4 md:p-6">
      <legend className="sr-only">{t("onboarding.baseline.title")}</legend>

      <FieldGroup
        htmlFor={IDS.displayName}
        label={t("onboarding.baseline.displayNameLabel")}
        hint={t("onboarding.baseline.displayNameHint")}
        error={errors.displayName}
      >
        <Input
          id={IDS.displayName}
          value={value.displayName}
          onChange={(e) => onChange("displayName", e.target.value)}
          disabled={readOnlyDisplayName}
          autoComplete="nickname"
          maxLength={50}
          placeholder={t("onboarding.baseline.displayNamePlaceholder")}
          aria-invalid={errors.displayName ? true : undefined}
          aria-describedby={
            errors.displayName ? `${IDS.displayName}-error` : undefined
          }
        />
      </FieldGroup>

      {/* `min-w-0` on both cells: a grid item's automatic minimum is its
          min-content, and the sex select's value is `whitespace-nowrap` — a
          locale whose longest option is a third longer, or a runner whose
          fallback fonts render two pixels wider, then pinned the track past
          the card at 390 px (the string-headroom sweep caught it on CI). With
          the minimum released the track takes the free space and the value
          ellipsises, which is the select primitive's own design. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldGroup
          className="min-w-0"
          htmlFor={IDS.heightCm}
          label={
            heightAdapter.usesFeetInches
              ? t("onboarding.baseline.heightLabelFtIn")
              : t("onboarding.baseline.heightLabel")
          }
          error={errors.heightCm}
        >
          <HeightFieldControl
            idPrefix={IDS.heightCm}
            adapter={heightAdapter}
            value={value.height}
            onChange={(next) => onChange("height", next)}
            autoComplete="off"
            invalid={Boolean(errors.heightCm)}
            describedBy={errors.heightCm ? `${IDS.heightCm}-error` : undefined}
          />
        </FieldGroup>
        <FieldGroup
          className="min-w-0"
          htmlFor={IDS.gender}
          label={t("onboarding.baseline.genderLabel")}
          error={errors.gender}
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
              className="w-full min-w-0"
              data-slot="onboarding-baseline-gender"
              aria-invalid={errors.gender ? true : undefined}
              aria-describedby={
                errors.gender ? `${IDS.gender}-error` : undefined
              }
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
        error={errors.dateOfBirth}
      >
        <DateField
          id={IDS.dateOfBirth}
          value={value.dateOfBirth}
          onChange={(next) => onChange("dateOfBirth", next)}
          max={new Date().toISOString().slice(0, 10)}
          autoComplete="bday"
          aria-invalid={errors.dateOfBirth ? true : undefined}
          aria-describedby={
            errors.dateOfBirth ? `${IDS.dateOfBirth}-error` : undefined
          }
        />
      </FieldGroup>
    </fieldset>
  );
}
