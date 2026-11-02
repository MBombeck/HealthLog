import { PDF_FONT_FAMILY } from "./fonts";
import {
  pdfCursorState,
  type DoctorReportPdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./render-context";

/**
 * Page one of the doctor report: the emergency ("Notfalldaten") sheet a
 * clinician reads first in an acute situation.
 *
 * Rendered before the header profile and followed by an explicit page break, so
 * whatever a first responder needs — blood type, severe allergies, the current
 * drug list, chronic conditions, implants, the advance-directive and
 * organ-donor declarations, who to call — sits alone on the opening page.
 *
 * The section only renders when `data.emergency` is present; the aggregator
 * returns null unless the EMERGENCY leaf was admitted AND the profile holds
 * something worth surfacing, so the presence check here is the render half of
 * that one gate.
 */
export function buildEmergencyFirstPageSection(
  context: DoctorReportPdfRenderContext,
  state: DoctorReportPdfCursorState,
): DoctorReportPdfCursorState {
  const { doc, data, t, margin, pageWidth, contentMaxY } = context;
  const emergency = data.emergency;
  if (!emergency) return state;

  const contentWidth = pageWidth - 2 * margin;
  let y = state.y;

  const ensureRoom = (needed: number) => {
    if (y + needed > contentMaxY) {
      doc.addPage();
      y = margin;
    }
  };

  // Banner: a filled bar so the page reads as the emergency sheet at a glance.
  doc.setFillColor(180, 30, 30);
  doc.rect(margin, y, contentWidth, 12, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(15);
  doc.setFont(PDF_FONT_FAMILY, "bold");
  doc.text(t("doctorReport.emergency.title"), margin + 3, y + 8);
  y += 12;

  doc.setTextColor(120, 120, 120);
  doc.setFontSize(8);
  doc.setFont(PDF_FONT_FAMILY, "normal");
  y += 5;
  doc.text(t("doctorReport.emergency.subtitle"), margin, y);
  y += 6;

  // A labelled paragraph block: bold label, wrapped body beneath. `emphasise`
  // draws the value darker (blood type, severe allergies) so it carries.
  const block = (label: string, body: string, emphasise = false) => {
    ensureRoom(5 + 4.8);
    doc.setFontSize(10);
    doc.setFont(PDF_FONT_FAMILY, "bold");
    doc.setTextColor(40, 40, 40);
    doc.text(label, margin, y);
    y += 5;
    doc.setFontSize(emphasise ? 11 : 9.5);
    doc.setFont(PDF_FONT_FAMILY, emphasise ? "bold" : "normal");
    doc.setTextColor(
      emphasise ? 150 : 60,
      emphasise ? 20 : 60,
      emphasise ? 20 : 60,
    );
    for (const wrapped of doc.splitTextToSize(body, contentWidth) as string[]) {
      ensureRoom(4.8);
      doc.text(wrapped, margin, y);
      y += 4.8;
    }
    y += 3;
  };

  const notRecorded = t("doctorReport.emergency.none");

  // Blood type.
  const bloodType =
    emergency.bloodType && emergency.bloodType !== "UNKNOWN"
      ? t(`doctorReport.emergency.bloodTypeValues.${emergency.bloodType}`)
      : emergency.bloodType === "UNKNOWN"
        ? t("doctorReport.emergency.bloodTypeUnknown")
        : notRecorded;
  block(t("doctorReport.emergency.bloodType"), bloodType, true);

  // Severe allergies — reuse the report's allergy collection, filter SEVERE.
  const severe = (data.allergies ?? []).filter((a) => a.severity === "SEVERE");
  if (severe.length > 0) {
    const lines = severe.map((a) => {
      const reaction = a.reactionUnreadable
        ? t("doctorReport.emergency.unreadable")
        : a.reaction;
      return reaction ? `${a.substance} (${reaction})` : a.substance;
    });
    block(t("doctorReport.emergency.severeAllergies"), lines.join("; "), true);
  } else {
    block(t("doctorReport.emergency.severeAllergies"), notRecorded);
  }

  // Active medications — reuse the report's medication list.
  const meds = data.medications ?? [];
  const medLine =
    meds.length > 0
      ? meds.map((m) => (m.dose ? `${m.name} ${m.dose}` : m.name)).join("; ")
      : notRecorded;
  block(t("doctorReport.emergency.activeMedications"), medLine);

  // Chronic conditions — ongoing illness episodes plus the anamnesis free text.
  const chronic = (data.illnessEpisodes ?? [])
    .filter((e) => e.lifecycle === "CHRONIC_ONGOING")
    .map((e) => e.label);
  const anamnesisConditions = data.anamnesis?.conditions ?? null;
  const conditionParts = [...chronic];
  if (anamnesisConditions) conditionParts.push(anamnesisConditions);
  block(
    t("doctorReport.emergency.chronicConditions"),
    conditionParts.length > 0 ? conditionParts.join("; ") : notRecorded,
  );

  // Implants / devices.
  const implants = emergency.implantsUnreadable
    ? t("doctorReport.emergency.unreadable")
    : (emergency.implants ?? notRecorded);
  block(t("doctorReport.emergency.implants"), implants);

  // Advance directive + organ donor.
  const advanceDirective = emergency.advanceDirective
    ? t(
        `doctorReport.emergency.advanceDirectiveValues.${emergency.advanceDirective}`,
      )
    : notRecorded;
  block(t("doctorReport.emergency.advanceDirective"), advanceDirective);

  const organDonor = emergency.organDonor
    ? t(`doctorReport.emergency.organDonorValues.${emergency.organDonor}`)
    : notRecorded;
  block(t("doctorReport.emergency.organDonor"), organDonor);

  // Emergency contacts.
  const contacts = emergency.contactsUnreadable
    ? t("doctorReport.emergency.unreadable")
    : (emergency.contacts ?? notRecorded);
  block(t("doctorReport.emergency.contacts"), contacts, true);

  // ICE note.
  const note = emergency.noteUnreadable
    ? t("doctorReport.emergency.unreadable")
    : emergency.note;
  if (note) {
    block(t("doctorReport.emergency.notes"), note);
  }

  return pdfCursorState(doc, y);
}
