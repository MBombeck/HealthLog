import type { RelatedLink } from "@/lib/links/related";

import type {
  ReferenceRangeOrigin,
  ReferenceRangeStatus,
} from "@/lib/validations/labs";

/** A lab-result row as the list / create endpoints serialise it. */
export interface LabResultDto {
  id: string;
  /** v1.18.1 — link to the catalog marker (null for legacy free-text rows). */
  biomarkerId: string | null;
  panel: string | null;
  analyte: string;
  /** Numeric reading; null for a qualitative row (see `valueText`). v1.18.9. */
  value: number | null;
  /** v1.18.9 — qualitative result text ("negativ" / …); null for a numeric row. */
  valueText: string | null;
  unit: string;
  /**
   * True when the stored number was converted into the marker's unit from
   * another one; `sourceValue` and `sourceUnit` are then what the report
   * printed. A reading stored as stated has `converted: false` and two nulls.
   */
  converted: boolean;
  sourceValue: number | null;
  sourceUnit: string | null;
  /**
   * The window this reading is judged against and the one `rangeStatus` was
   * computed from: the range its own report printed when it carries one, the
   * catalog band otherwise. Render these and the range shown always matches
   * the verdict shown.
   */
  referenceLow: number | null;
  referenceHigh: number | null;
  /** The catalog marker's band, so both windows can be drawn. */
  catalogReferenceLow: number | null;
  catalogReferenceHigh: number | null;
  /** The window the source report printed; the text verbatim, bounds when derivable. */
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  sourceReferenceText: string | null;
  /**
   * A converted reading's printed range text, verbatim and in `sourceUnit`;
   * `sourceReferenceText` is then null. Null for every other reading.
   */
  printedReferenceText: string | null;
  /** Which window is in force. */
  referenceOrigin: ReferenceRangeOrigin;
  /** True when the report's window and the catalog band state different limits. */
  referenceDivergesFromCatalog: boolean;
  takenAt: string;
  source: string;
  hasNote: boolean;
  rangeStatus: ReferenceRangeStatus;
  createdAt: string;
  updatedAt: string;
}

/** The single-resource detail DTO — carries the decrypted note. */
export interface LabResultDetailDto extends Omit<LabResultDto, "hasNote"> {
  note: string | null;
  /** v1.43 — the records this reading relates to, resolved on the server. */
  related?: RelatedLink[];
}

export interface LabResultListResponse {
  results: LabResultDto[];
  meta: { total: number; limit: number; offset: number };
}

/** One biomarker in `GET /api/labs/overview`. */
export interface LabOverviewMarkerDto {
  /** `bm:<biomarkerId>`, or `analyte:<lower-cased name>` for a legacy row. */
  key: string;
  /** Every live reading of the marker. */
  count: number;
  /** Values of the newest readings, oldest first; null for a qualitative one. */
  trend: (number | null)[];
  latest: LabResultDto;
}

/** One category of the labs list, resolved by the server; rendered as given. */
export interface LabOverviewCategoryDto {
  /** Opaque: a catalog panel key, `custom:<hash>`, or `other`. */
  key: string;
  label: string;
  /** The `markers[].key` values in this category. */
  markerKeys: string[];
  counts: { inRange: number; below: number; above: number; unknown: number };
  status: LabResultDto["rangeStatus"];
}

export interface LabOverviewResponse {
  markers: LabOverviewMarkerDto[];
  categories: LabOverviewCategoryDto[];
  /** True when grouping adds anything; a flat list otherwise. */
  grouped: boolean;
}

/** A user-scoped Biomarker catalog entry as the API serialises it. */
export interface BiomarkerDto {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  /**
   * Which analyte the marker is, for converting a reading in another unit
   * (the catalog slug, e.g. `ldl`, or a registry-only key such as `urea`), or null when it is none that is known.
   */
  analyteKey: string | null;
  hasContext: boolean;
  context: string | null;
  /**
   * v1.43 — other spellings that resolve to this marker, sorted, without its
   * own name. Absent from an older server.
   */
  aliases?: string[];
  /** v1.22 — a hidden marker drops from the active list + lab-entry pickers. */
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  /** v1.44 — the detail read's trend line; absent on the list and older servers. */
  trend?: BiomarkerTrendDto;
}

/** v1.44 — `GET /api/biomarkers/{id}` `trend` (`computeLabTrend`). */
export type BiomarkerTrendDto =
  | {
      status: "ok";
      n: number;
      firstAt: string;
      lastAt: string;
      spanDays: number;
      slopePerYear: number;
      slopeCi95: [number, number];
      pValue: number;
      fittedNow: number;
      asOf: string;
      horizonYears: number;
      horizonCapped: boolean;
      projection:
        | "exits"
        | "beyond_horizon"
        | "no_exit"
        | "already_outside"
        | "no_clear_trend"
        | "no_band"
        | "stale";
      exitDate: string | null;
      exitBound: "low" | "high" | null;
    }
  | {
      status: "insufficient";
      reason: "too_few_values" | "span_too_short";
      n: number;
      spanDays: number;
    };

export interface BiomarkerListResponse {
  biomarkers: BiomarkerDto[];
  /**
   * The person's own panels that are no catalog panel, one spelling each,
   * for the panel suggestions.
   */
  customPanels: string[];
}

/** v1.43 — `POST /api/biomarkers/{id}/merge`, for the preview and the result. */
export interface BiomarkerMergeResultDto {
  dryRun: boolean;
  target: BiomarkerDto;
  sources: Array<{
    id: string;
    name: string;
    unit: string;
    readingCount: number;
    conversion: "none" | "converted" | "refused";
    refusal: "unknown_analyte" | "unknown_unit" | "not_finite" | null;
  }>;
  movedReadings: number;
  convertedReadings: number;
  aliasesAdded: string[];
  /** The panel the target takes over from a source, or null. */
  adoptedPanel: string | null;
  mergeId: string | null;
}
