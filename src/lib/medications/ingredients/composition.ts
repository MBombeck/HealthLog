/**
 * v1.43 — a supplement's composition per unit (tablet, capsule): checking
 * what was entered against the nutrient catalogue, storing it canonically,
 * and publishing it.
 *
 * Every amount is stored in the catalogue's canonical unit for its code. An
 * amount entered in another input unit (vitamin D in IU) is converted through
 * the catalogue and the entered amount and unit are kept beside it, so the
 * form shows the person what they typed. The catalogue is the only place a
 * unit or a factor is spelled; nothing here names one.
 */
import { coerceLocale } from "@/lib/i18n/config";
import { labelIn } from "@/lib/i18n/localised-label-index";
import {
  NUTRIENT_CATALOG,
  catalogEntryFor,
  isCanonicalNutrientUnit,
  isIngredientNutrientCode,
  toCanonicalNutrientAmount,
  type NutrientCode,
} from "@/lib/nutrients/catalog";

/** One ingredient as the PUT body carries it. */
export interface IngredientInput {
  nutrient: string;
  amount: number;
  unit: string;
}

/** One ingredient as it is stored. */
export interface CanonicalIngredient {
  nutrient: NutrientCode;
  amountPerUnit: number;
  unit: string;
  enteredAmount: number | null;
  enteredUnit: string | null;
}

export type CompositionCheck =
  | { ok: true; ingredients: CanonicalIngredient[] }
  | { ok: false; kind: "unknownNutrient"; index: number }
  | {
      ok: false;
      kind: "unitMismatch";
      index: number;
      allowedUnits: string[];
    };

/**
 * Check each entry against the catalogue and convert it to the canonical
 * unit. The first entry that fails decides the answer, with its index, so
 * the form can point at the row.
 */
export function canonicalComposition(
  inputs: ReadonlyArray<IngredientInput>,
): CompositionCheck {
  const ingredients: CanonicalIngredient[] = [];
  for (const [index, input] of inputs.entries()) {
    // Water, energy, the macros and alcohol are catalogue codes but no
    // ingredient a capsule declares: refused as unknown, like a code the
    // catalogue never heard of.
    if (!isIngredientNutrientCode(input.nutrient)) {
      return { ok: false, kind: "unknownNutrient", index };
    }
    const code = input.nutrient;
    const canonical = toCanonicalNutrientAmount(code, input.amount, input.unit);
    if (canonical === null || !(canonical > 0)) {
      return {
        ok: false,
        kind: "unitMismatch",
        index,
        allowedUnits: NUTRIENT_CATALOG[code].inputUnits.map((u) => u.unit),
      };
    }
    const converted = !isCanonicalNutrientUnit(code, input.unit);
    ingredients.push({
      nutrient: code,
      amountPerUnit: canonical,
      unit: NUTRIENT_CATALOG[code].unit,
      enteredAmount: converted ? input.amount : null,
      enteredUnit: converted ? input.unit : null,
    });
  }
  return { ok: true, ingredients };
}

/** One ingredient on the wire (`MedicationIngredient`). */
export interface MedicationIngredientDto {
  nutrient: string;
  amountPerUnit: number;
  unit: string;
  enteredAmount: number | null;
  enteredUnit: string | null;
  labelKey: string;
  label: string;
}

/** The nutrient's name in `locale`, falling back to the code itself. */
export function nutrientLabel(code: string, locale: string | null): string {
  const entry = catalogEntryFor(code);
  if (!entry) return code;
  return labelIn(coerceLocale(locale), entry.labelKey) ?? code;
}

/**
 * Publish stored rows in catalogue order, each labelled in the account's
 * language. A stored code the catalogue no longer knows still travels, under
 * its raw code, rather than vanishing from the person's medication.
 */
export function toIngredientDtos(
  rows: ReadonlyArray<{
    nutrient: string;
    amountPerUnit: number;
    unit: string;
    enteredAmount: number | null;
    enteredUnit: string | null;
  }>,
  locale: string | null,
): MedicationIngredientDto[] {
  const order = (code: string) => {
    const entry = catalogEntryFor(code);
    return entry ? entry.order : Number.MAX_SAFE_INTEGER;
  };
  return [...rows]
    .sort((a, b) => order(a.nutrient) - order(b.nutrient))
    .map((row) => ({
      nutrient: row.nutrient,
      amountPerUnit: row.amountPerUnit,
      unit: row.unit,
      enteredAmount: row.enteredAmount,
      enteredUnit: row.enteredUnit,
      labelKey: catalogEntryFor(row.nutrient)?.labelKey ?? row.nutrient,
      label: nutrientLabel(row.nutrient, locale),
    }));
}

/**
 * One comparable line for a composition (`dha=250 mg; vitamin_d=25 ug`), for
 * the audit row's before and after. Codes sorted, so an unchanged set reads
 * as unchanged; the empty set is the empty string.
 */
export function compositionSummary(
  rows: ReadonlyArray<{
    nutrient: string;
    amountPerUnit: number;
    unit: string;
  }>,
): string {
  return [...rows]
    .sort((a, b) => a.nutrient.localeCompare(b.nutrient))
    .map((row) => `${row.nutrient}=${row.amountPerUnit} ${row.unit}`)
    .join("; ");
}
