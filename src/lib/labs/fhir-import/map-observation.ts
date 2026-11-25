/**
 * One FHIR lab result (an `Observation`, DSTU2 or R4) → one lab reading, or
 * the closed reason it is not one. Pure.
 *
 * Only whitelisted fields are read: `resourceType`, `id`, `status`,
 * `category`, `code`, `effective*`, `issued`, `value*`, `dataAbsentReason`,
 * `interpretation`, `referenceRange`, `hasMember` / `related`, `note` /
 * `comments`. The patient, the performer and any contained resource are never
 * looked at, and nothing from the resource ever reaches an error message: a
 * malformed field is a reason, not a quote.
 *
 * The rules, in brief:
 *   - a result counts when it is final (`final`, `amended`, `corrected`);
 *     a preliminary one is skipped and a withdrawn one never written;
 *   - a category other than laboratory (a vital sign, a survey) is skipped,
 *     matched on the whole word (`laboratory`, `LAB`), never a substring;
 *     a resource with no category at all is taken only when the record was
 *     typed as a lab result (`requireLabCategory` unset), and skipped
 *     `not_lab` when it was handed on for its resource type alone;
 *   - the name is the code's text, else the LOINC coding's display, else any
 *     coding's display; the LOINC code is a matching hint;
 *   - a number with a comparator ("<0.5 mg/L") is kept as text, as the report
 *     printed it, since a bound is not a value;
 *   - the report's own reference range is kept, in the reading's unit only;
 *   - a result with no value whose interpretation says positive, negative,
 *     detected, not detected or indeterminate is kept as that text;
 *   - a result with no value but members is a panel header: not a reading,
 *     but its name becomes its members' panel (`assignPanels`).
 */
import { catalogSlugForLoinc } from "@/lib/fhir/lab-loinc";
import {
  parseReferenceRange,
  SOURCE_REFERENCE_TEXT_MAX,
} from "@/lib/labs/parse-reference-range";
import { DIMENSIONLESS_UNIT } from "@/lib/labs/dimensionless";
import { LAB_TEXT_LIMITS } from "@/lib/labs/reading-keys";
import { sameLabUnit } from "@/lib/labs/unit-normalise";

import { fhirLabExternalId } from "./external-id";
import type {
  FhirLabFailureReason,
  FhirLabRecordInput,
  FhirLabSkipReason,
  MappedFhirLab,
} from "./types";
import { isDimensionlessLoinc, labUnitFromFhirQuantity } from "./units";
import { ownValue } from "@/lib/own-key";

/** A reading dated more than a day ahead is a mistake, not a result. */
const FUTURE_SLACK_MS = 86_400_000;
const EARLIEST = Date.UTC(1900, 0, 1);
const LOINC_SYSTEMS = new Set([
  "http://loinc.org",
  "urn:oid:2.16.840.1.113883.6.1",
]);

export type FhirLabMapping =
  | {
      kind: "reading";
      reading: MappedFhirLab;
      selfRef: string | null;
      memberRefs: string[];
    }
  | {
      kind: "skip";
      reason: FhirLabSkipReason;
      selfRef: string | null;
      memberRefs: string[];
      /** A panel header's name, for its members. */
      panelName: string | null;
    }
  | { kind: "fail"; reason: FhirLabFailureReason; selfRef: string | null };

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** A field DSTU2 writes as one object and R4 as a list, read as a list. */
function list(value: unknown): Json[] {
  if (Array.isArray(value)) {
    return value.map(obj).filter((v): v is Json => v !== null);
  }
  const one = obj(value);
  return one ? [one] : [];
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed === "" ? null : collapsed;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function codings(concept: unknown): Json[] {
  return list(obj(concept)?.coding);
}

/** `Observation/<id>` for a reference however it is written. */
export function normaliseObservationRef(raw: unknown): string | null {
  const reference = str(raw);
  if (!reference) return null;
  const parts = reference.split(/[/?#]/u).filter(Boolean);
  const at = parts.lastIndexOf("Observation");
  if (at < 0 || at + 1 >= parts.length) return null;
  return `Observation/${parts[at + 1]}`;
}

/**
 * The institution a record came from, as a namespace for its references. A
 * local id such as `Observation/1` is unique only within one FHIR server, and
 * one export holds the records of several institutions, so a panel and its
 * members are matched within the institution they came from: its FHIR base
 * (`sourceURL`), else the name the Health app gives it, else none.
 */
function issuerOf(input: FhirLabRecordInput): string {
  const url = input.sourceURL?.trim().toLowerCase().replace(/\/+$/u, "");
  if (url) return url;
  return input.sourceName?.trim().toLowerCase() ?? "";
}

/** A reference key scoped to the institution that wrote the record. */
function scopedRef(issuer: string, ref: string): string {
  return `${issuer}|${ref}`;
}

function memberRefs(resource: Json): string[] {
  const refs: string[] = [];
  for (const member of list(resource.hasMember)) {
    const ref = normaliseObservationRef(member.reference);
    if (ref) refs.push(ref);
  }
  for (const related of list(resource.related)) {
    if (str(related.type) !== "has-member") continue;
    const ref = normaliseObservationRef(obj(related.target)?.reference);
    if (ref) refs.push(ref);
  }
  return refs;
}

/**
 * Whether a category names lab results. FHIR's own code is "laboratory", but
 * a record reaches the import only because Apple Health already filed it as
 * a lab result (or the phone sends lab records alone), and systems spell the
 * category their own way ("LAB", "Lab Results"). Any code, display or text
 * naming a lab counts; a record whose categories are all something else (vital
 * signs, say) is still left out.
 */
/**
 * The spellings of the laboratory category, matched whole and case-blind: the
 * R4 code `laboratory`, the DSTU2 / HL7 v2 `LAB`, and the displays and texts
 * sources print beside them. A word that merely contains "lab" ("available",
 * "collaborative") is not one.
 */
const LABORATORY_NAMES: ReadonlySet<string> = new Set([
  "laboratory",
  "lab",
  "laboratory result",
  "laboratory results",
  "lab result",
  "lab results",
]);

function isLaboratory(concept: Json): boolean {
  const names = [
    str(concept.text),
    ...codings(concept).flatMap((c) => [str(c.code), str(c.display)]),
  ];
  return names.some(
    (name) => name !== null && LABORATORY_NAMES.has(name.trim().toLowerCase()),
  );
}

function analyteName(code: Json | null): string | null {
  if (!code) return null;
  const text = str(code.text);
  if (text) return text;
  const all = codings(code);
  const loinc = all.find((c) => LOINC_SYSTEMS.has(str(c.system) ?? ""));
  return (
    str(loinc?.display) ?? all.map((c) => str(c.display)).find(Boolean) ?? null
  );
}

function loincCode(code: Json | null): string | null {
  if (!code) return null;
  for (const c of codings(code)) {
    if (LOINC_SYSTEMS.has(str(c.system) ?? "")) {
      const value = str(c.code);
      if (value) return value;
    }
  }
  return null;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T[\d:.]+$/u;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/u;

/**
 * A FHIR date or dateTime as an instant. A date alone, or a time with no
 * offset, is the day at the noon-UTC anchor the labs feature stores a date
 * at; a year or a year and month alone does not say which day and is
 * unusable.
 */
export function fhirInstant(raw: unknown): Date | null {
  const text = str(raw);
  if (!text) return null;
  const day = DATE_ONLY.exec(text) ?? LOCAL_DATE_TIME.exec(text);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const at = new Date(Date.UTC(y, m - 1, d, 12));
    return at.getUTCFullYear() === y &&
      at.getUTCMonth() === m - 1 &&
      at.getUTCDate() === d
      ? at
      : null;
  }
  if (!WITH_OFFSET.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function takenAtOf(resource: Json): Date | null {
  return (
    fhirInstant(resource.effectiveDateTime) ??
    fhirInstant(obj(resource.effectivePeriod)?.start) ??
    fhirInstant(resource.effectiveInstant) ??
    fhirInstant(resource.issued)
  );
}

const INTERPRETATION_TEXT: Readonly<Record<string, string>> = {
  POS: "Positive",
  NEG: "Negative",
  DET: "Detected",
  ND: "Not detected",
  IND: "Indeterminate",
};

function interpretationText(resource: Json): string | null {
  for (const concept of list(resource.interpretation)) {
    for (const c of codings(concept)) {
      const code = str(c.code)?.toUpperCase();
      const text = code ? ownValue(INTERPRETATION_TEXT, code) : undefined;
      if (text) return str(c.display) ?? str(concept.text) ?? text;
    }
  }
  return null;
}

const UNSUPPORTED_VALUES = [
  "valueBoolean",
  "valueRange",
  "valueRatio",
  "valueSampledData",
  "valueAttachment",
  "valueTime",
  "valuePeriod",
  "valueDateTime",
];

type ValueRead =
  | {
      ok: true;
      value: number | null;
      valueText: string | null;
      unit: string | null;
    }
  | { ok: false; skip?: FhirLabSkipReason; fail?: FhirLabFailureReason }
  | null;

/**
 * `dimensionless` says the analyte's value has no unit (its LOINC code is a
 * specific gravity, a pH or an INR): a bare number is then the unity "1"
 * rather than a number whose unit was dropped.
 */
function readValue(resource: Json, dimensionless: boolean): ValueRead {
  const bare = dimensionless ? DIMENSIONLESS_UNIT : null;
  const quantity = obj(resource.valueQuantity);
  if (quantity) {
    const value = num(quantity.value);
    if (value === null) return { ok: false, skip: "no_value" };
    const unit = labUnitFromFhirQuantity(quantity) ?? bare;
    const comparator = str(quantity.comparator);
    if (comparator) {
      const printed =
        unit && unit !== "1"
          ? `${comparator}${value} ${unit}`
          : `${comparator}${value}`;
      return { ok: true, value: null, valueText: printed, unit };
    }
    if (!unit) return { ok: false, fail: "missing_unit" };
    return { ok: true, value, valueText: null, unit };
  }
  if (Number.isSafeInteger(resource.valueInteger)) {
    if (!bare) return { ok: false, fail: "missing_unit" };
    const value = resource.valueInteger as number;
    return { ok: true, value, valueText: null, unit: bare };
  }
  const text = str(resource.valueString);
  if (text) return { ok: true, value: null, valueText: text, unit: null };
  const concept = obj(resource.valueCodeableConcept);
  if (concept) {
    const first = codings(concept)[0];
    const label = str(concept.text) ?? str(first?.display) ?? str(first?.code);
    if (label) return { ok: true, value: null, valueText: label, unit: null };
    return { ok: false, skip: "no_value" };
  }
  if (UNSUPPORTED_VALUES.some((key) => ownValue(resource, key) !== undefined)) {
    return { ok: false, skip: "unsupported_value" };
  }
  return null;
}

function referenceRangeOf(
  resource: Json,
  unit: string | null,
): { low: number | null; high: number | null; text: string | null } {
  const ranges = list(resource.referenceRange);
  const chosen =
    ranges.find((r) => r.appliesTo === undefined && r.age === undefined) ??
    ranges.find((r) =>
      codings(r.type).some((c) => str(c.code)?.toLowerCase() === "normal"),
    );
  if (!chosen) return { low: null, high: null, text: null };

  const bound = (q: unknown): number | null => {
    const quantity = obj(q);
    if (!quantity) return null;
    const value = num(quantity.value);
    if (value === null) return null;
    const boundUnit = labUnitFromFhirQuantity(quantity);
    if (boundUnit && unit && !sameLabUnit(boundUnit, unit)) return null;
    if (boundUnit && !unit) return null;
    return value;
  };
  let low = bound(chosen.low);
  let high = bound(chosen.high);
  const text = str(chosen.text)?.slice(0, SOURCE_REFERENCE_TEXT_MAX) ?? null;
  if (low === null && high === null && text) {
    const parsed = parseReferenceRange(text, unit);
    low = parsed?.low ?? null;
    high = parsed?.high ?? null;
  }
  if (low !== null && high !== null && low > high) {
    low = null;
    high = null;
  }
  return { low, high, text };
}

function noteOf(resource: Json): string | null {
  const parts = list(resource.note)
    .map((n) => str(n.text))
    .filter((t): t is string => t !== null);
  const comments = str(resource.comments);
  if (comments) parts.push(comments);
  if (parts.length === 0) return null;
  const joined = parts.join("\n");
  return joined.length > LAB_TEXT_LIMITS.note
    ? `${joined.slice(0, LAB_TEXT_LIMITS.note - 1)}…`
    : joined;
}

const FINAL = new Set(["final", "amended", "corrected", "missing"]);
const NOT_YET = new Set(["preliminary", "registered", "unknown"]);
const WITHDRAWN = new Set(["entered-in-error", "cancelled"]);

export function mapFhirLabRecord(
  input: FhirLabRecordInput,
  now: Date = new Date(),
): FhirLabMapping {
  const resource = obj(input.resource);
  const id = resource ? str(resource.id) : null;
  const issuer = issuerOf(input);
  const selfRef = id ? scopedRef(issuer, `Observation/${id}`) : null;
  const skip = (
    reason: FhirLabSkipReason,
    members: string[] = [],
    panelName: string | null = null,
  ): FhirLabMapping => ({
    kind: "skip",
    reason,
    selfRef,
    memberRefs: members,
    panelName,
  });
  const fail = (reason: FhirLabFailureReason): FhirLabMapping => ({
    kind: "fail",
    reason,
    selfRef,
  });

  if (!resource || resource.resourceType !== "Observation") {
    return skip("not_observation");
  }

  const status = str(resource.status)?.toLowerCase() ?? "";
  if (WITHDRAWN.has(status)) return skip("withdrawn");
  if (NOT_YET.has(status) || !FINAL.has(status)) return skip("not_final");

  // No category is taken only from a record typed as a lab result; one handed
  // on for its FHIR resource type alone may be a vital sign or a survey.
  const categories = list(resource.category);
  if (
    categories.length > 0
      ? !categories.some(isLaboratory)
      : input.requireLabCategory === true
  ) {
    return skip("not_lab");
  }

  const code = obj(resource.code);
  const analyte = analyteName(code);
  const members = memberRefs(resource).map((ref) => scopedRef(issuer, ref));
  if (analyte && analyte.length > LAB_TEXT_LIMITS.analyte) {
    return fail("text_too_long");
  }

  const loinc = loincCode(code);
  let read = readValue(resource, isDimensionlessLoinc(loinc));
  if (read === null && resource.dataAbsentReason !== undefined) {
    read = { ok: false, skip: "no_value" };
  }
  if (read === null) {
    const interpreted = interpretationText(resource);
    if (interpreted) {
      read = { ok: true, value: null, valueText: interpreted, unit: null };
    } else if (members.length > 0) {
      return skip(
        "panel_header",
        members,
        analyte ? analyte.slice(0, LAB_TEXT_LIMITS.panel) : null,
      );
    } else if (resource.component !== undefined) {
      return skip("unsupported_value");
    } else {
      return skip("no_value");
    }
  }
  if (!read.ok) {
    return read.fail ? fail(read.fail) : skip(read.skip ?? "no_value", members);
  }
  if (!analyte) return skip("no_value", members);
  if (
    read.valueText !== null &&
    read.valueText.length > LAB_TEXT_LIMITS.valueText
  ) {
    return fail("text_too_long");
  }
  if (read.unit !== null && read.unit.length > LAB_TEXT_LIMITS.unit) {
    return fail("text_too_long");
  }

  const takenAt = takenAtOf(resource);
  if (!takenAt) return skip("no_date", members);
  if (takenAt.getTime() > now.getTime() + FUTURE_SLACK_MS) {
    return skip("future_date", members);
  }
  if (takenAt.getTime() < EARLIEST) return skip("invalid_date", members);

  const range = referenceRangeOf(resource, read.unit);

  return {
    kind: "reading",
    selfRef,
    memberRefs: members,
    reading: {
      externalId: fhirLabExternalId({
        sourceURL: input.sourceURL,
        sourceName: input.sourceName,
        identifier: input.identifier,
        resourceId: id,
        loinc,
        analyte,
        takenAt,
        value: read.value,
        valueText: read.valueText,
      }),
      analyte,
      loinc,
      catalogKey: loinc ? catalogSlugForLoinc(loinc) : null,
      value: read.value,
      valueText: read.valueText,
      unit: read.unit,
      takenAt,
      // Like the CSV import: on a text result the window only seeds a new
      // marker; the reading itself records none.
      sourceReferenceLow: range.low,
      sourceReferenceHigh: range.high,
      sourceReferenceText: read.valueText === null ? range.text : null,
      panel: null,
      note: noteOf(resource),
    },
  };
}

/**
 * Give each reading the name of the panel that lists it as a member (R4
 * `hasMember`, DSTU2 `related` of type `has-member`). Mutates the readings in
 * place; a reading already carrying a panel keeps it.
 */
export function assignPanels(results: readonly FhirLabMapping[]): void {
  const panelOf = new Map<string, string>();
  for (const result of results) {
    if (result.kind !== "skip" || result.reason !== "panel_header") continue;
    if (!result.panelName) continue;
    for (const ref of result.memberRefs) {
      if (!panelOf.has(ref)) panelOf.set(ref, result.panelName);
    }
  }
  if (panelOf.size === 0) return;
  for (const result of results) {
    if (result.kind !== "reading" || !result.selfRef) continue;
    if (result.reading.panel !== null) continue;
    result.reading.panel = panelOf.get(result.selfRef) ?? null;
  }
}
