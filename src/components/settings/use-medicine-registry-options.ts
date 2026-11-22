"use client";

import { useMemo } from "react";

import { useTranslations } from "@/lib/i18n/context";
import {
  MEDICINE_REGISTRIES,
  registryAuthority,
  type MedicineRegistry,
} from "@/lib/medications/leaflet-registries";

/**
 * The medicine registries as select options, one list for every place that
 * offers the choice (Settings → Medications and the setup's "Region & units").
 *
 * Country names come from the browser's own region names in the interface
 * language (`Intl.DisplayNames`), so every locale reads them natively; the
 * registry's name beside each is a proper name and stays as it is.
 */
export function useMedicineRegistryOptions(): Array<{
  code: MedicineRegistry;
  label: string;
}> {
  const { locale } = useTranslations();
  return useMemo(() => {
    let regionName: (code: string) => string = (code) => code;
    try {
      const names = new Intl.DisplayNames([locale], { type: "region" });
      regionName = (code) => names.of(code) ?? code;
    } catch {
      // An engine without region names shows the codes, which still read.
    }
    return MEDICINE_REGISTRIES.map((code) => ({
      code,
      label: `${regionName(code)} (${registryAuthority(code)})`,
    })).sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [locale]);
}
