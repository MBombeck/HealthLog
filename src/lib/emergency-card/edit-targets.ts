/**
 * Where each line of the emergency card is edited, for the owner's own view.
 *
 * The card gathers facts that live on other surfaces: allergies and the
 * emergency details in the medical history, a chronic condition on its
 * illness page, a medication on its own page, the name and birth date in the
 * account. Each line opens the surface that owns it, so the owner changes a
 * fact where it lives instead of hunting for it from a single "edit" link.
 *
 * A surface whose module is switched off is not linked: its route would only
 * send the owner home. The condition and medication lines then fall back to
 * nothing rather than to a page that does not open.
 *
 * Owner only. The read-only link, its offline copy and the wallet card never
 * carry these targets or the ids inside them.
 */
import type { ModuleKey } from "@/lib/modules/registry";

import type { EmergencyCardField } from "./fields";

export interface EmergencyCardTargets {
  /** Where each item is edited, or null when its surface is switched off. */
  fields: Record<EmergencyCardField, string | null>;
  /** One per condition line, in card order. */
  conditions: Array<string | null>;
  /** One per medication line, in card order. */
  medications: Array<string | null>;
}

const ACCOUNT_PROFILE = "/settings/account#profile";
const EMERGENCY_DETAILS = "/settings/anamnesis#emergency";
const ALLERGIES = "/settings/anamnesis#allergies";
const MEDICAL_HISTORY = "/settings/anamnesis";

export function emergencyCardTargets(args: {
  conditionEpisodeIds: ReadonlyArray<string | null>;
  medicationIds: readonly string[];
  modules: Readonly<Partial<Record<ModuleKey, boolean>>>;
}): EmergencyCardTargets {
  const on = (key: ModuleKey) => args.modules[key] !== false;
  const illness = on("illness");
  // The written note's editor sits in the medical history while the Coach
  // is on; without it the page still opens, at its top.
  const conditionsNote = on("coach")
    ? `${MEDICAL_HISTORY}#conditions`
    : MEDICAL_HISTORY;
  return {
    fields: {
      NAME: ACCOUNT_PROFILE,
      BLOOD_TYPE: EMERGENCY_DETAILS,
      ALLERGIES,
      CONDITIONS: illness ? "/illness" : conditionsNote,
      MEDICATIONS: on("medications") ? "/medications" : null,
      PREGNANCY: on("cycle") ? "/cycle?tab=settings" : null,
      IMPLANTS: EMERGENCY_DETAILS,
      CONTACTS: EMERGENCY_DETAILS,
      ADVANCE_DIRECTIVE: EMERGENCY_DETAILS,
      ORGAN_DONOR: EMERGENCY_DETAILS,
      NOTE: EMERGENCY_DETAILS,
      DATE_OF_BIRTH: ACCOUNT_PROFILE,
    },
    conditions: args.conditionEpisodeIds.map((id) =>
      id === null
        ? conditionsNote
        : illness
          ? `/illness/${encodeURIComponent(id)}`
          : null,
    ),
    medications: args.medicationIds.map((id) =>
      on("medications") ? `/medications/${encodeURIComponent(id)}` : null,
    ),
  };
}
