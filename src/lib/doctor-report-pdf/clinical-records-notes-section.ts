import type { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { EncounterKind, Laterality } from "@/generated/prisma/client";
import {
  encounterKindLabelKey,
  lateralityLabelKey,
} from "../encounters/kind-label";
import {
  classifyReferenceRange,
  formatReferenceRange,
} from "../labs/reference-range";
import {
  pdfCursorState,
  type DoctorReportPdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./render-context";

export function buildClinicalRecordsNotesSection(
  context: DoctorReportPdfRenderContext,
  state: DoctorReportPdfCursorState,
): DoctorReportPdfCursorState {
  const { doc, data, t, num, fmtDate, margin, tableBottomMargin, ensureSpace } =
    context;
  let y = state.y;

  // v1.17.1 — structured lab-results section. Populated when the `labs`
  // toggle is ON (default) and the user recorded at least one result in the
  // window. One row per analyte (latest reading), with the reference range and
  // a NEUTRAL in/out-of-range marker — informative, never an alarming red. The
  // marker is a quiet glyph (↓ / ↑ / —), not a colour, so the clinical PDF
  // stays calm.
  //
  // The reference column prints the window the reading was JUDGED against, and
  // when that window came off the source report it prints the report's own
  // string verbatim — a clinician comparing this table against the original
  // report should read the same characters. A reading whose report window
  // differs from the catalog band carries a footnote marker, and the catalog
  // band is named beneath the table, because "3,9–5,4" and "3,5–5,0" disagree
  // about the same number and a table that shows only one is a partial answer.
  if (data.labResults && data.labResults.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.labsTitle"), margin, y);
    y += 6;

    const rangeText = (low: number | null, high: number | null): string =>
      formatReferenceRange(low, high, num, { emptyText: "—" });
    // Quiet, non-colour status glyph. In-range reads as a neutral dash so
    // the table is not a field of warning marks; out-of-range reads as a
    // direction arrow the clinician can scan, with no alarm tint.
    const statusGlyph = (
      value: number,
      low: number | null,
      high: number | null,
    ): string => {
      switch (classifyReferenceRange(value, low, high)) {
        case "unknown":
          return "";
        case "below":
          return "↓";
        case "above":
          return "↑";
        default:
          return "—";
      }
    };

    // The reference cell: the report's own string when the report stated the
    // window, else the formatted catalog band. A divergence gets a "*" the
    // note under the table explains.
    const referenceCell = (
      lr: NonNullable<typeof data.labResults>[number],
    ): string => {
      const printed =
        lr.referenceOrigin === "source" && lr.sourceReferenceText
          ? lr.sourceReferenceText
          : rangeText(lr.referenceLow, lr.referenceHigh);
      return lr.referenceDivergesFromCatalog ? `${printed} *` : printed;
    };

    const diverging = data.labResults.filter(
      (lr) => lr.referenceDivergesFromCatalog,
    );

    const labRows = data.labResults.map((lr) => {
      // v1.18.9 — a qualitative reading (`value === null`) prints its result
      // text in the value column and has no numeric range / status glyph.
      const isQualitative = lr.value === null;
      return [
        lr.panel ? `${lr.analyte} (${lr.panel})` : lr.analyte,
        isQualitative
          ? (lr.valueText ?? "")
          : `${num(lr.value as number)} ${lr.unit}`.trim(),
        isQualitative ? "—" : referenceCell(lr),
        isQualitative
          ? ""
          : statusGlyph(lr.value as number, lr.referenceLow, lr.referenceHigh),
        fmtDate(lr.takenAt),
      ];
    });

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.labsColAnalyte"),
          t("doctorReport.labsColValue"),
          t("doctorReport.labsColReference"),
          t("doctorReport.labsColStatus"),
          t("doctorReport.labsColDate"),
        ],
      ],
      body: labRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;

    // Name every diverging marker's catalog band, so the reader can see both
    // windows rather than being told only that they differ.
    if (diverging.length > 0) {
      y = ensureSpace(y, 4 + diverging.length * 4);
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(110, 110, 110);
      doc.text(t("doctorReport.labsSourceRangeNote"), margin, y);
      y += 4;
      for (const lr of diverging) {
        doc.text(
          `* ${lr.analyte}: ${t("doctorReport.labsCatalogRangeLabel")} ${rangeText(
            lr.catalogReferenceLow,
            lr.catalogReferenceHigh,
          )} ${lr.unit}`.trim(),
          margin,
          y,
        );
        y += 4;
      }
      doc.setTextColor(30, 30, 30);
      y += 4;
    }
  }

  // v1.18.1 P4 — illness / condition episodes overlapping the window. Present
  // only when the illness module is on AND the window held an episode (the
  // aggregator gates `data.illnessEpisodes`). Labels + lifecycle + dates and
  // the body site where one is stated; the encrypted note is never read. A purely retrospective, factual table —
  // no colour, no severity tint — matching the clinical-document register.
  if (data.illnessEpisodes && data.illnessEpisodes.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.illnessTitle"), margin, y);
    y += 6;

    // v1.39.2 — the body site, in its own column only when at least one
    // condition in the window names one, so a report without any keeps the
    // table it always had. Same wording as the surgical history's site cell.
    const withSite = data.illnessEpisodes.some((ep) => ep.bodySite);
    const conditionSite = (ep: (typeof data.illnessEpisodes)[number]) => {
      if (!ep.bodySite) return "—";
      if (!ep.laterality) return ep.bodySite;
      return t("encounters.bodySiteWithSide", {
        site: ep.bodySite,
        side: t(lateralityLabelKey(ep.laterality as Laterality)),
      });
    };
    const illnessRows = data.illnessEpisodes.map((ep) => [
      ep.label,
      ...(withSite ? [conditionSite(ep)] : []),
      t(`illness.type.${ep.type}`),
      t(`illness.lifecycle.${ep.lifecycle}`),
      fmtDate(ep.onsetAt),
      ep.resolvedAt ? fmtDate(ep.resolvedAt) : t("doctorReport.illnessOngoing"),
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.illnessColCondition"),
          ...(withSite ? [t("doctorReport.illnessColBodySite")] : []),
          t("doctorReport.illnessColType"),
          t("doctorReport.illnessColLifecycle"),
          t("doctorReport.illnessColOnset"),
          t("doctorReport.illnessColResolved"),
        ],
      ],
      body: illnessRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // Visits inside the window — what happened at a practice, and what came out
  // of it. Present only when the VISITS leaf was selected AND the window held a
  // visit (the aggregator gates `data.visits`); the leaf carries no module of
  // its own, because a visit is core and the whole report is already gated by
  // `doctorReport`. Same calm factual register as the illness table above: no
  // colour, no status tint. The encrypted reason and outcome decrypt at render
  // and never enter the stored selection.
  if (data.visits && data.visits.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.visitsTitle"), margin, y);
    y += 6;

    const visitRows = data.visits.map((visit) => [
      fmtDate(visit.occurredAt),
      // The practice, with its specialty when there is one; an em dash when
      // the visit named neither, which is honest rather than invented.
      [visit.practitionerName, visit.practitionerSpecialty]
        .filter(Boolean)
        .join(" · ") || "—",
      // Through the key resolver: the enum is `ROUTINE` and the bundle leaf is
      // `routine`, so the interpolated key printed raw dot notation into the
      // clinical document.
      t(encounterKindLabelKey(visit.kind as EncounterKind)),
      visit.reason ?? "—",
      visit.outcome ?? "—",
      visit.conditionLabels.length > 0 ? visit.conditionLabels.join(", ") : "—",
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.visitsColDate"),
          t("doctorReport.visitsColPractice"),
          t("doctorReport.visitsColKind"),
          t("doctorReport.visitsColReason"),
          t("doctorReport.visitsColOutcome"),
          t("doctorReport.visitsColConditions"),
        ],
      ],
      body: visitRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // The surgical history. Reference data (not time-windowed), populated when
  // the SURGICAL_HISTORY leaf is selected AND a procedure happened. Oldest
  // first, the order an intake form asks for it in. What was done is the
  // visit's reason; the site carries its side after it in the report's
  // language. Same calm register as the tables around it.
  if (data.surgicalHistory && data.surgicalHistory.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.surgicalHistoryTitle"), margin, y);
    y += 6;

    const siteCell = (site: string | null, side: string | null): string => {
      if (!site) return "—";
      if (!side) return site;
      return t("encounters.bodySiteWithSide", {
        site,
        side: t(lateralityLabelKey(side as Laterality)),
      });
    };

    const procedureRows = data.surgicalHistory.map((row) => [
      fmtDate(row.occurredAt),
      row.procedure ?? "—",
      siteCell(row.bodySite, row.laterality),
      row.outcome ?? "—",
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.surgicalHistoryColDate"),
          t("doctorReport.surgicalHistoryColProcedure"),
          t("doctorReport.surgicalHistoryColBodySite"),
          t("doctorReport.surgicalHistoryColOutcome"),
        ],
      ],
      body: procedureRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // The immunization history. Reference data (not time-windowed), populated
  // when the `IMMUNIZATIONS` leaf is selected AND the `vaccinations` module is
  // on AND live doses exist. A compact chronological table — date, vaccine
  // (catalogue name or verbatim free text), dose display, lot — in the same
  // calm factual register. No due-status, no gap analysis: the report
  // reproduces the record, it does not adjudicate it. The dose display is
  // composed from the server-resolved series numbers; nothing is re-derived.
  if (data.immunizations && data.immunizations.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.immunizationsTitle"), margin, y);
    y += 6;

    const doseDisplay = (
      series: (typeof data.immunizations)[number]["series"],
    ): string => {
      const primary = series[0];
      if (!primary) return "—";
      if (primary.booster) return t("vaccinations.series.booster");
      if (primary.total !== null) {
        return t("vaccinations.series.ofTotal", {
          position: primary.position,
          total: primary.total,
        });
      }
      return t("vaccinations.series.doseN", { position: primary.position });
    };

    const immunizationRows = data.immunizations.map((row) => [
      fmtDate(row.occurredAt),
      row.antigenSlug
        ? t(`vaccinations.catalog.${row.antigenSlug}`)
        : (row.vaccineName ?? "—"),
      doseDisplay(row.series),
      row.lotNumber ?? "—",
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.immunizationsColDate"),
          t("doctorReport.immunizationsColVaccine"),
          t("doctorReport.immunizationsColDose"),
          t("doctorReport.immunizationsColLot"),
        ],
      ],
      body: immunizationRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // v1.27.x — structured allergy / intolerance records. Reference data
  // (not time-windowed) the aggregator populates when the `allergies`
  // toggle is ON (default) and rows exist. Stored fields only — substance,
  // category, kind, severity, reaction, status — in the same calm factual
  // table register as the illness section; no colour, no severity tint.
  if (data.allergies && data.allergies.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.allergiesTitle"), margin, y);
    y += 6;

    const allergyRows = data.allergies.map((al) => [
      al.substance,
      t(`records.allergies.category.${al.category}`),
      t(`records.allergies.type.${al.type}`),
      al.severity ? t(`records.allergies.severity.${al.severity}`) : "—",
      // A reaction that WAS recorded but could not be decrypted renders an
      // honest marker, never a blank "—" that reads as "no reaction recorded".
      al.reactionUnreadable
        ? t("doctorReport.reactionUnreadable")
        : (al.reaction ?? "—"),
      t(`records.allergies.status.${al.status}`),
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.allergiesColSubstance"),
          t("doctorReport.allergiesColCategory"),
          t("doctorReport.allergiesColKind"),
          t("doctorReport.allergiesColSeverity"),
          t("doctorReport.allergiesColReaction"),
          t("doctorReport.allergiesColStatus"),
        ],
      ],
      body: allergyRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // v1.27.x — structured family-history records. Reference data the
  // aggregator populates when the `familyHistory` toggle is ON (default)
  // and rows exist. Relationship + condition + age at onset only — the
  // free-text note never reaches this surface.
  if (data.familyHistory && data.familyHistory.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.familyHistoryTitle"), margin, y);
    y += 6;

    const familyRows = data.familyHistory.map((fh) => [
      t(`records.family.relationship.${fh.relationship}`),
      fh.condition,
      fh.ageAtOnset !== null ? String(fh.ageAtOnset) : "—",
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.familyHistoryColRelationship"),
          t("doctorReport.familyHistoryColCondition"),
          t("doctorReport.familyHistoryColAgeAtOnset"),
        ],
      ],
      body: familyRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  if (data.anamnesis) {
    y = ensureSpace(y, 6 + 22);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.anamnesisTitle"), margin, y);
    y += 6;

    const absent = t("doctorReport.anamnesisNotRecorded");
    const unreadable = t("doctorReport.anamnesisUnreadable");
    const factValue = (
      kind: "SMOKING_STATUS" | "ALCOHOL_PATTERN" | "SHIFT_SCHEDULE",
      value: string | null,
    ) => {
      if (data.anamnesis!.unreadableFacts.includes(kind)) return unreadable;
      return value ? t(`records.profileFacts.values.${kind}.${value}`) : absent;
    };
    const rows = [
      [
        t("doctorReport.anamnesisConditions"),
        data.anamnesis.conditionsUnreadable
          ? unreadable
          : (data.anamnesis.conditions ?? absent),
      ],
      [
        t("doctorReport.anamnesisSmoking"),
        factValue("SMOKING_STATUS", data.anamnesis.smokingStatus),
      ],
      [
        t("doctorReport.anamnesisAlcohol"),
        factValue("ALCOHOL_PATTERN", data.anamnesis.alcoholPattern),
      ],
      [
        t("doctorReport.anamnesisShiftSchedule"),
        factValue("SHIFT_SCHEDULE", data.anamnesis.shiftSchedule),
      ],
    ];

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.anamnesisColFact"),
          t("doctorReport.anamnesisColValue"),
        ],
      ],
      body: rows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  return pdfCursorState(doc, y);
}
