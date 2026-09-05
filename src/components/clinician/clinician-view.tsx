/**
 * The public clinician view.
 *
 * A pure server component: it receives an already-resolved, owner-scoped
 * {@link DoctorReportData} plus a server-side translator and renders a
 * read-only clinical summary. NO client hooks, NO session, NO AI or coach, NO
 * markdown — every value renders as escaped React text.
 *
 * Layout follows the catalogue's own group order, which is also the PDF's, so
 * the picker a person ticked, the page their doctor opens and the file that
 * doctor files all describe the record in the same sequence: the emergency
 * sheet first (it is page one of the PDF for the same reason) → personal
 * details → the measurement groups → glucose → lab values → medications, GLP-1
 * and the dose log → conditions, visits, immunizations, allergies → family
 * history, health profile, mood, cycle → a FENCED, muted wellness card
 * carrying the load-bearing "descriptive, not a clinical assessment"
 * disclaimer → the attached documents.
 *
 * Every card is gated by the link's frozen selection through {@link LeafScope}
 * rather than by the presence of its data. The two are not the same question:
 * the aggregator already applies the selection, but a section that reads only
 * "is there data" trusts an upstream gate it cannot see, and it cannot tell a
 * withheld leaf from an empty one. `LeafScope` also carries the OWNER's module
 * state, which is the third case — shared, but the domain is switched off on
 * the account it came from.
 *
 * The section components live in `./report-sections` (measurements, glucose,
 * medications, allergies, health profile, wellness), `./identity-sections`,
 * `./history-sections`, `./therapy-sections` and `./sensitive-sections`; the
 * document list in `./documents-list`, the downloads in `./download-actions`.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import {
  makeFormatters,
  type DateFormatPreference,
  type TimeFormatPreference,
} from "@/lib/format-locale";
import type { Locale } from "@/lib/i18n/config";
import type { ShareViewDocument } from "@/lib/clinician-share/share-view-data";
import type { ReportLeafId } from "@/lib/report-selection/catalogue";
import type { ReportSelection } from "@/lib/report-selection/selection";
import { PageHeader } from "@/components/ui/page-header";
import { DocumentEntry } from "./documents-list";
import { ShareDownloadActions } from "./download-actions";
import { EmergencySection, PatientIdentitySection } from "./identity-sections";
import {
  IllnessSection,
  ImmunizationsSection,
  LabResultsSection,
  VisitsSection,
} from "./history-sections";
import { DoseLogSection, Glp1Section } from "./therapy-sections";
import {
  CycleSection,
  FamilyHistorySection,
  MoodSection,
} from "./sensitive-sections";
import {
  AllergiesSection,
  AnamnesisSection,
  GlucoseSection,
  MeasurementGroups,
  MedicationsSection,
  Section,
  StatRow,
  WellnessSection,
  makeLeafScope,
} from "./report-sections";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface ClinicianViewProps {
  t: Translate;
  /** Owner-set label for the share (e.g. a clinic note). */
  label: string;
  /** ISO expiry instant — surfaced so the clinician knows the link lifetime. */
  expiresAt: string;
  /**
   * The owner-scoped report payload, or `null` for a documents-only share.
   * When `null` NO health metric is rendered — only the header, the
   * disclaimer, and the attached documents.
   */
  report: DoctorReportData | null;
  /** The link's frozen selection, resolved. */
  selection: ReportSelection;
  /**
   * Leaves the link DOES carry whose owning module is switched off on the
   * owner's account. The payload cannot express this — the aggregator ANDs the
   * selection and the module map and returns the same nothing either way — so
   * it arrives beside the payload and the affected cards say so in words
   * rather than rendering as an empty section the recipient would read as "no
   * data recorded".
   */
  unavailableLeaves?: readonly ReportLeafId[];
  /**
   * A documents-only link. Hides the reporting-period line (there is no
   * report) and, together with a `null` report, keeps every health section off
   * the page.
   */
  documentOnly?: boolean;
  /**
   * The frozen document set on this link (metadata only — never bytes). Each
   * entry points at the token-scoped serve route, the one decrypt path.
   */
  documents?: ShareViewDocument[];
  /** The raw share token from the path — used to build serve-route URLs. */
  token?: string;
  /** Viewer locale (byte formatting only). Defaults to English. */
  locale?: Locale;
  /**
   * Issue #490 — the share OWNER's profile timezone. Period start/end and the
   * expiry date render in this zone so the dates agree with the patient-tz
   * aggregation behind the stats (and with the doctor-report PDF).
   */
  timezone?: string;
  /**
   * Issue #922 — the share OWNER's hour cycle and date order. This is the
   * owner's record, so it is spelled the owner's way; the viewing clinician
   * has no profile here. Both travel the same route as `timezone` above
   * (resolved off the owner row in the page), and both are REQUIRED so a
   * future caller cannot quietly drop the preference again.
   */
  timeFormat: TimeFormatPreference;
  dateFormat: DateFormatPreference;
}

export function ClinicianView({
  t,
  label,
  expiresAt,
  report,
  selection,
  unavailableLeaves = [],
  documents = [],
  documentOnly = false,
  token = "",
  locale = "en",
  timezone,
  timeFormat,
  dateFormat,
}: ClinicianViewProps) {
  // Owner-tz, locale-aware date rendering (issue #490) — `makeFormatters`
  // guards the zone and falls back to Europe/Berlin on garbage/absence.
  // Owner hour cycle + date order ride along (issue #922).
  const fmt = makeFormatters(locale, timezone, timeFormat, dateFormat);
  const fmtDate = (iso: string) => fmt.date(new Date(iso));
  const fmtDateTime = (iso: string) => fmt.dateTime(new Date(iso));
  const fmtNum = (n: number) => Math.round(n * 100) / 100;
  const scope = makeLeafScope(selection, unavailableLeaves);

  return (
    <main
      id="main-content"
      className="mx-auto min-h-dvh w-full max-w-3xl px-4 py-8"
    >
      {/* ── Provenance header ───────────────────────────────────────── */}
      <header className="mb-6 space-y-1.5">
        <PageHeader title={t("clinicianView.title")} description={label} />
        {report && !documentOnly ? (
          <p className="text-muted-foreground mt-3 text-sm">
            {t("clinicianView.period", {
              start: fmtDate(report.period.start),
              end: fmtDate(report.period.end),
            })}
          </p>
        ) : null}
        <p className="text-muted-foreground mt-1 text-xs">
          {t("clinicianView.expires", { date: fmtDate(expiresAt) })}
        </p>
        {report && !documentOnly && token ? (
          <ShareDownloadActions t={t} token={token} />
        ) : null}
        <p className="border-border bg-muted/40 text-muted-foreground mt-3 rounded-md border p-3 text-xs">
          {t("clinicianView.provenance")}
        </p>
      </header>

      <div className="space-y-4">
        {report ? (
          <>
            {/* ── identity ─────────────────────────────────────────── */}
            <EmergencySection t={t} report={report} scope={scope} />
            <PatientIdentitySection
              t={t}
              report={report}
              scope={scope}
              fmtDate={fmtDate}
            />

            {/* ── measurements ─────────────────────────────────────── */}
            <MeasurementGroups
              t={t}
              report={report}
              scope={scope}
              fmtNum={fmtNum}
            />
            {report.bmi !== null &&
            report.bmi !== undefined &&
            scope.admits("BODY_MASS_INDEX") ? (
              <Section
                title={t("clinicianView.bmiSection")}
                leaves={["BODY_MASS_INDEX"]}
              >
                <StatRow
                  label={t("clinicianView.bmi")}
                  value={String(fmtNum(report.bmi))}
                />
              </Section>
            ) : null}

            {/* ── glucose and labs ─────────────────────────────────── */}
            <GlucoseSection
              t={t}
              report={report}
              scope={scope}
              fmtNum={fmtNum}
            />
            <LabResultsSection
              t={t}
              report={report}
              scope={scope}
              fmtDate={fmtDate}
              fmtNum={fmtNum}
            />

            {/* ── medications ──────────────────────────────────────── */}
            <MedicationsSection t={t} report={report} scope={scope} />
            <Glp1Section
              t={t}
              report={report}
              scope={scope}
              fmtDate={fmtDate}
              fmtNum={fmtNum}
            />
            <DoseLogSection
              t={t}
              report={report}
              scope={scope}
              fmtDateTime={fmtDateTime}
              fmtNum={fmtNum}
            />

            {/* ── history ──────────────────────────────────────────── */}
            <IllnessSection
              t={t}
              report={report}
              scope={scope}
              fmtDate={fmtDate}
            />
            <VisitsSection
              t={t}
              report={report}
              scope={scope}
              fmtDate={fmtDate}
            />
            <ImmunizationsSection
              t={t}
              report={report}
              scope={scope}
              fmtDate={fmtDate}
            />
            <AllergiesSection t={t} report={report} scope={scope} />

            {/* ── the fenced tier, as the owner chose it ───────────── */}
            <FamilyHistorySection t={t} report={report} scope={scope} />
            <AnamnesisSection t={t} report={report} scope={scope} />
            <MoodSection t={t} report={report} scope={scope} fmtNum={fmtNum} />
            <CycleSection
              t={t}
              report={report}
              scope={scope}
              fmtDate={fmtDate}
              fmtNum={fmtNum}
            />

            <WellnessSection
              t={t}
              report={report}
              scope={scope}
              fmtNum={fmtNum}
            />
          </>
        ) : null}

        {/* ── Shared documents ────────────────────────────────────── */}
        {documents.length > 0 && token ? (
          <Section title={t("clinicianView.documents.title")}>
            <p className="text-muted-foreground mb-3 text-xs">
              {t("clinicianView.documents.exifNote")}
            </p>
            <ul className="space-y-3">
              {documents.map((doc) => (
                <DocumentEntry
                  key={doc.id}
                  t={t}
                  doc={doc}
                  token={token}
                  locale={locale}
                />
              ))}
            </ul>
          </Section>
        ) : null}
      </div>

      <footer className="border-border text-muted-foreground mt-8 border-t pt-4 text-center text-xs">
        {t("clinicianView.footer")}
      </footer>
    </main>
  );
}
