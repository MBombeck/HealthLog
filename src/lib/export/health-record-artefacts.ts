/**
 * The three health-record artefacts, produced from one aggregated payload.
 *
 * Moved out of `POST /api/export/health-record` so the route keeps the HTTP
 * concerns — auth, module gate, rate limit, validation, audit — and the
 * rendering keeps its own. All three read the SAME `DoctorReportData`, which
 * is what makes the PDF, the bundle and the zip describe an identical record
 * by construction rather than by three renderers each remembering the scope.
 */
import { zipSync, strToU8 } from "fflate";

import type { DoctorReportData } from "@/lib/doctor-report-data";
import { renderDoctorReportPdfBytes } from "@/lib/doctor-report-pdf-core";
import { buildFhirDocumentBundle } from "@/lib/fhir/build-bundle";
import type { FhirRecordInputs } from "@/lib/fhir/build-bundle";
import type { FhirPatientIdentity } from "@/lib/fhir/resources/common";
import type { Locale } from "@/lib/i18n/config";
import type {
  DateFormatPreference,
  TimeFormatPreference,
} from "@/lib/format-locale";

export interface ArtefactInputs {
  data: DoctorReportData;
  /**
   * The decrypted insurance identity; every field null when the insurance
   * leaf was not selected.
   */
  insurance: FhirPatientIdentity;
  records: FhirRecordInputs;
  germanAtc: boolean;
  includeCharts: boolean;
  locale: Locale;
  userTz: string;
  timeFormat: TimeFormatPreference;
  dateFormat: DateFormatPreference;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

/** The FHIR R4 document Bundle, serialised. */
export function buildBundleJson(input: ArtefactInputs): string {
  const bundle = buildFhirDocumentBundle(
    input.data,
    input.insurance,
    undefined,
    { germanAtc: input.germanAtc },
    input.records,
  );
  return JSON.stringify(bundle);
}

/** The rendered clinical PDF. */
export function buildPdfBytes(input: ArtefactInputs): Uint8Array {
  return renderDoctorReportPdfBytes(input.data, {
    t: input.t,
    locale: input.locale,
    userTz: input.userTz,
    timeFormat: input.timeFormat,
    dateFormat: input.dateFormat,
    insuranceNumber: input.insurance.insuranceNumber,
    insuranceNumberCountry: input.insurance.insuranceNumberCountry,
    insuranceGroupNumber: input.insurance.insuranceGroupNumber,
    includeCharts: input.includeCharts,
  });
}

/** One zip holding the PDF, the Bundle and a README. */
export function buildPackageZip(
  input: ArtefactInputs,
  pdfBytes: Uint8Array,
): Uint8Array {
  const bundle = buildFhirDocumentBundle(
    input.data,
    input.insurance,
    undefined,
    { germanAtc: input.germanAtc },
    input.records,
  );
  return zipSync(
    {
      "report.pdf": pdfBytes,
      "bundle.json": strToU8(JSON.stringify(bundle, null, 2)),
      "README.txt": strToU8(input.t("doctorReport.packageReadme")),
    },
    { level: 6 },
  );
}
