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
 */

export interface BiomarkerFormFields {
  name: string;
  unit: string;
  lower: number | null;
  upper: number | null;
  panel: string;
  context: string;
}

export interface BiomarkerFormInitial {
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  context: string | null;
}

export type BiomarkerBody = {
  name: string;
  unit: string;
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
  const body: BiomarkerBody = {
    name: fields.name.trim(),
    unit: fields.unit.trim(),
  };
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
