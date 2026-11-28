"use client";

import { useMemo } from "react";

import { FieldError } from "@/components/forms/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useTranslations } from "@/lib/i18n/context";
import { ownValue } from "@/lib/own-key";
import { isFullAccount, type AuthUser } from "@/hooks/use-auth";
import {
  ISO_COUNTRY_CODES,
  countryHasGroupNumber,
  displayInsuranceNumber,
  insuranceNumberRule,
  suggestInsuranceNumberCountry,
} from "@/lib/validations/insurance-number";

/** A number written the way each checked country writes it. */
const PLACEHOLDERS: Record<string, string> = {
  DE: "A123456780",
  AT: "1237 010180",
  CH: "756.9217.0769.85",
  NL: "111222333",
  FR: "1 85 05 75 056 123 88",
};

/** Countries whose number has a name of its own; every other reads generic. */
const NUMBER_LABEL_KEYS: Record<string, string> = {
  DE: "settings.identity.numberLabel.DE",
  AT: "settings.identity.numberLabel.AT",
  CH: "settings.identity.numberLabel.CH",
  NL: "settings.identity.numberLabel.NL",
  FR: "settings.identity.numberLabel.FR",
  US: "settings.identity.numberLabel.US",
};

/** Every country by its name in the interface language, sorted by name. */
function useCountryOptions(): Array<{ code: string; label: string }> {
  const { locale } = useTranslations();
  return useMemo(() => {
    let regionName: (code: string) => string = (code) => code;
    try {
      const names = new Intl.DisplayNames([locale], { type: "region" });
      regionName = (code) => names.of(code) ?? code;
    } catch {
      // An engine without region names shows the codes, which still read.
    }
    return ISO_COUNTRY_CODES.map((code) => ({
      code,
      label: regionName(code),
    })).sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [locale]);
}

/**
 * The form draft of the insurance row, from the account payload: the number
 * written the way its country writes it (the server stores it compact), the
 * stored country or a guess for an empty profile, and the US group number.
 */
export function insuranceDraft(user: AuthUser | null, locale: string) {
  // The insurance fields are withheld from the first-paint seed; a draft
  // built from it would save them as cleared.
  if (!isFullAccount(user)) {
    return {
      insuranceNumber: "",
      insuranceCountry: "DE",
      insuranceGroupNumber: "",
    };
  }
  return {
    insuranceNumber: displayInsuranceNumber(user) ?? "",
    insuranceCountry: suggestInsuranceNumberCountry({
      stored: user.insuranceNumberCountry,
      hasNumber: Boolean(user.insuranceNumber),
      languages: typeof navigator === "undefined" ? [] : navigator.languages,
      locale,
    }),
    insuranceGroupNumber: user.insuranceGroupNumber ?? "",
  };
}

/**
 * The insurance number's row on the account form: the country beside the
 * number, and for a US plan the group number. The rule for each country
 * lives on the server (`src/lib/validations/insurance-number.ts`); the form
 * only names the number the way that country does.
 */
export function InsuranceNumberFields({
  country,
  number,
  groupNumber,
  fieldErrors,
  clearFieldError,
  onCountryChange,
  onNumberChange,
  onGroupNumberChange,
}: {
  country: string;
  number: string;
  groupNumber: string;
  fieldErrors: Record<string, string>;
  clearFieldError: (slot: string) => void;
  onCountryChange: (next: string) => void;
  onNumberChange: (next: string) => void;
  onGroupNumberChange: (next: string) => void;
}) {
  const { t } = useTranslations();
  const countries = useCountryOptions();
  const labelKey =
    ownValue(NUMBER_LABEL_KEYS, country) ?? "settings.identity.insuranceNumber";
  const strict = insuranceNumberRule(country) !== "generic";

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="insurance-country">
          {t("settings.identity.insuranceCountry")}
        </Label>
        <NativeSelect
          id="insurance-country"
          value={country}
          onChange={(e) => {
            onCountryChange(e.target.value);
            clearFieldError("insuranceNumberCountry");
            clearFieldError("insuranceNumber");
          }}
          aria-invalid={fieldErrors.insuranceNumberCountry ? true : undefined}
          aria-describedby={
            fieldErrors.insuranceNumberCountry
              ? "insurance-country-error"
              : undefined
          }
        >
          {countries.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
        <FieldError
          id="insurance-country-error"
          message={fieldErrors.insuranceNumberCountry}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="insurance-number">{t(labelKey)}</Label>
        <Input
          id="insurance-number"
          value={number}
          onChange={(e) => {
            onNumberChange(e.target.value);
            clearFieldError("insuranceNumber");
          }}
          placeholder={ownValue(PLACEHOLDERS, country)}
          maxLength={40}
          autoCapitalize={strict ? "characters" : "off"}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={fieldErrors.insuranceNumber ? true : undefined}
          aria-describedby={
            fieldErrors.insuranceNumber ? "insurance-number-error" : undefined
          }
        />
        <FieldError
          id="insurance-number-error"
          message={fieldErrors.insuranceNumber}
        />
      </div>
      {countryHasGroupNumber(country) && (
        <div className="space-y-2">
          <Label htmlFor="insurance-group-number">
            {t("settings.identity.insuranceGroupNumber")}
          </Label>
          <Input
            id="insurance-group-number"
            value={groupNumber}
            onChange={(e) => {
              onGroupNumberChange(e.target.value);
              clearFieldError("insuranceGroupNumber");
            }}
            maxLength={30}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={fieldErrors.insuranceGroupNumber ? true : undefined}
            aria-describedby={
              fieldErrors.insuranceGroupNumber
                ? "insurance-group-number-error"
                : undefined
            }
          />
          <FieldError
            id="insurance-group-number-error"
            message={fieldErrors.insuranceGroupNumber}
          />
        </div>
      )}
    </div>
  );
}
