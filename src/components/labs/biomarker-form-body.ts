/**
 * The request body the marker form sends.
 *
 * A new marker omits every empty field: the create schema has no "clear",
 * and an omitted field simply stays unset. An edit omits a field that was
 * empty and still is, so it stays as stored, and sends `null` for a field the
 * person emptied: panel, context or a bound that held a value and now holds
 * none is cleared, which an omitted key never did. Only a field that held a
 * value when the form opened can be emptied, so a context the list could not
 * decrypt (shown empty) is never wiped by saving another field.
 *
 * An edit sends the unit only when it changed. A marker with readings refuses
 * a unit change, so a unit sent back unchanged could only trip that check, and
 * did on a marker minted from a text result: its empty unit opens as "no unit",
 * which the box states as the unity, and a rename then read as a unit change.
 * The empty unit and the unity are the same "no unit" here; saving leaves the
 * empty one as it is, so the marker still takes the unit of its first number.
 */

import { DIMENSIONLESS_UNIT, markerHasNoUnit } from "@/lib/labs/dimensionless";

export interface BiomarkerFormFields {
  name: string;
  unit: string;
  lower: number | null;
  upper: number | null;
  panel: string;
  context: string;
}

export interface BiomarkerFormInitial {
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  context: string | null;
}

export type BiomarkerBody = {
  name: string;
  unit?: string;
  lowerBound?: number | null;
  upperBound?: number | null;
  panel?: string | null;
  context?: string | null;
};

export function buildBiomarkerBody(
  fields: BiomarkerFormFields,
  initial: BiomarkerFormInitial | null,
): BiomarkerBody {
  const panel = fields.panel.trim();
  const context = fields.context.trim();
  const unit = fields.unit.trim();
  const body: BiomarkerBody = { name: fields.name.trim() };
  if (!initial || !sameFormUnit(unit, initial.unit)) body.unit = unit;
  if (fields.lower !== null) body.lowerBound = fields.lower;
  else if (initial?.lowerBound != null) body.lowerBound = null;
  if (fields.upper !== null) body.upperBound = fields.upper;
  else if (initial?.upperBound != null) body.upperBound = null;
  if (panel) body.panel = panel;
  else if (initial?.panel) body.panel = null;
  if (context) body.context = context;
  else if (initial?.context) body.context = null;
  return body;
}

/**
 * The unit an edit opens with. A marker minted from a text result has an
 * empty unit, none chosen yet; it opens as "no unit", like the unity, rather
 * than as a unit still to be typed.
 */
export function formUnit(stored: string): string {
  return markerHasNoUnit(stored) ? DIMENSIONLESS_UNIT : stored;
}

/** Whether the unit the form holds is the one the marker opened with. */
function sameFormUnit(unit: string, initial: string): boolean {
  if (unit === initial.trim()) return true;
  return markerHasNoUnit(unit) && markerHasNoUnit(initial);
}
