import { buildClinicalSummaryLines } from "./clinical-summary";
import {
  pdfCursorState,
  type DoctorReportPdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./render-context";

export function buildHeaderProfileSection(
  context: DoctorReportPdfRenderContext,
  state: DoctorReportPdfCursorState,
): DoctorReportPdfCursorState {
  const {
    doc,
    data,
    t,
    num,
    fmtDate,
    now,
    insuranceNumber,
    margin,
    pageWidth,
    contentMaxY,
    ensureSpace,
  } = context;
  let y = state.y;

  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(t("doctorReport.title"), margin, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(t("doctorReport.subtitle"), margin, y);
  y += 6;

  // Practice / clinic name on the cover. Rendered prominently above the
  // separator so the addressee is the first thing the doctor sees when
  // skimming the printout. Skipped entirely when the user did not supply
  // one — keeps the cover compact for self-archive use.
  if (data.practiceName) {
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(
      `${t("doctorReport.practiceLabel")}: ${data.practiceName}`,
      margin,
      y,
    );
    y += 6;
    doc.setFont("helvetica", "normal");
  }

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);
  y += 8;

  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  const patientInfo: string[] = [];
  // v1.7.0 — prefer the legal full name on the cover; fall back to the
  // username when no full name is set (collapses exactly like the
  // practice name when neither is present).
  const patientName = data.patient.fullName ?? data.patient.username ?? null;
  if (patientName) {
    patientInfo.push(`${t("doctorReport.patient")}: ${patientName}`);
  }
  if (data.patient.dateOfBirth) {
    patientInfo.push(
      `${t("doctorReport.dateOfBirth")}: ${fmtDate(data.patient.dateOfBirth)}`,
    );
  }
  if (data.patient.gender) {
    const genderKeys: Record<string, string> = {
      MALE: "doctorReport.genderMale",
      FEMALE: "doctorReport.genderFemale",
    };
    const genderKey =
      genderKeys[data.patient.gender] ?? "doctorReport.genderOther";
    patientInfo.push(`${t("doctorReport.gender")}: ${t(genderKey)}`);
  }
  if (data.patient.heightCm) {
    patientInfo.push(
      `${t("doctorReport.height")}: ${data.patient.heightCm} cm`,
    );
  }
  // v1.7.0 — optional insurer + KVNR. Each line collapses when its field
  // is unset, mirroring the existing practice-name behaviour.
  if (data.patient.insurerName) {
    patientInfo.push(
      `${t("doctorReport.insurer")}: ${data.patient.insurerName}`,
    );
  }
  if (insuranceNumber) {
    patientInfo.push(
      `${t("doctorReport.insuranceNumber")}: ${insuranceNumber}`,
    );
  }
  // Reporting period uses the explicit `start`/`end` from the data payload
  // (set by `normaliseDateRange()`). For older payloads that only carried
  // `since`, fall back to (since, now()) to preserve previous behaviour.
  const periodStart = data.period.start ?? data.period.since;
  const periodEnd = data.period.end ?? now.toISOString();
  patientInfo.push(
    `${t("doctorReport.period")}: ${fmtDate(periodStart)} — ${fmtDate(periodEnd)}`,
  );
  patientInfo.push(
    `${t("doctorReport.createdOn")}: ${fmtDate(now.toISOString())}`,
  );

  for (const line of patientInfo) {
    doc.text(line, margin, y);
    y += 4.5;
  }
  y += 4;

  // v1.7.0 — deterministic clinical-summary block. Pure data (NOT AI),
  // built from the same aggregated stats the tables print. Gives a
  // physician a one-paragraph orientation before the detail tables.
  const summaryLines = buildClinicalSummaryLines(data, t, num);
  if (summaryLines.length > 0) {
    // Keep the heading with at least its first line (heading 5 mm + one body
    // line 4.5 mm + trailing gap).
    y = ensureSpace(y, 5 + 4.5 + 4);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.summaryTitle"), margin, y);
    y += 5;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(60, 60, 60);
    for (const line of summaryLines) {
      const wrapped = doc.splitTextToSize(line, pageWidth - 2 * margin);
      for (const w of wrapped) {
        if (y + 4.5 > contentMaxY) {
          doc.addPage();
          y = margin;
        }
        doc.text(w, margin, y);
        y += 4.5;
      }
    }
    y += 4;
  }

  return pdfCursorState(doc, y);
}
