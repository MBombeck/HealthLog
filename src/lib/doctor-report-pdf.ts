/**
 * Client-side PDF generation for doctor reports.
 * Uses jspdf + jspdf-autotable for professional medical-style reports.
 */
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

interface ReportData {
  period: { days: number; since: string };
  patient: {
    username: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    heightCm: number | null;
  };
  stats: Record<
    string,
    { avg: number; min: number; max: number; count: number; latest: number }
  >;
  bmi: number | null;
  compliance: Record<
    string,
    { total: number; taken: number; skipped: number; missed: number }
  >;
  medications: Array<{
    name: string;
    dose: string;
    schedules: Array<{
      windowStart: string;
      windowEnd: string;
      label: string | null;
    }>;
  }>;
  mood: {
    avg: number;
    min: number;
    max: number;
    count: number;
    distribution: Record<number, number>;
  } | null;
}

const TYPE_LABELS: Record<string, string> = {
  WEIGHT: "Körpergewicht",
  BLOOD_PRESSURE_SYS: "Systolischer Blutdruck",
  BLOOD_PRESSURE_DIA: "Diastolischer Blutdruck",
  PULSE: "Ruhepuls",
  BODY_FAT: "Körperfettanteil",
  SLEEP_DURATION: "Schlafdauer",
  ACTIVITY_STEPS: "Aktivität (Schritte)",
};

const TYPE_UNITS: Record<string, string> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_FAT: "%",
  SLEEP_DURATION: "h",
  ACTIVITY_STEPS: "Schritte",
};

const MOOD_LABELS: Record<number, string> = {
  1: "Sehr schlecht",
  2: "Schlecht",
  3: "Neutral",
  4: "Gut",
  5: "Sehr gut",
};

function fmt(value: number, decimals = 1): string {
  return value.toFixed(decimals).replace(".", ",");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function getBmiClassification(bmi: number): string {
  if (bmi < 18.5) return "Untergewicht";
  if (bmi < 25) return "Normalgewicht";
  if (bmi < 30) return "Übergewicht (Präadipositas)";
  if (bmi < 35) return "Adipositas Grad I";
  if (bmi < 40) return "Adipositas Grad II";
  return "Adipositas Grad III";
}

function getBpClassification(sys: number, dia: number): string {
  if (sys < 120 && dia < 80) return "Optimal";
  if (sys < 130 && dia < 85) return "Normal";
  if (sys < 140 && dia < 90) return "Hochnormal";
  if (sys < 160 && dia < 100) return "Hypertonie Grad 1";
  if (sys < 180 && dia < 110) return "Hypertonie Grad 2";
  return "Hypertonie Grad 3";
}

export function generateDoctorReportPDF(data: ReportData): jsPDF {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  let y = margin;

  // ── Header ──────────────────────────────────────────────────────────────
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text("Gesundheitsbericht", margin, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text("HealthLog — Persönlicher Gesundheitsbericht", margin, y);
  y += 6;

  // Divider
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);
  y += 8;

  // ── Patient info ────────────────────────────────────────────────────────
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  const patientInfo: string[] = [];
  if (data.patient.username) patientInfo.push(`Patient: ${data.patient.username}`);
  if (data.patient.dateOfBirth) {
    patientInfo.push(`Geburtsdatum: ${formatDate(data.patient.dateOfBirth)}`);
  }
  if (data.patient.gender) {
    patientInfo.push(
      `Geschlecht: ${data.patient.gender === "MALE" ? "Männlich" : data.patient.gender === "FEMALE" ? "Weiblich" : "Divers"}`,
    );
  }
  if (data.patient.heightCm) {
    patientInfo.push(`Körpergröße: ${data.patient.heightCm} cm`);
  }
  patientInfo.push(
    `Berichtszeitraum: ${formatDate(data.period.since)} — ${formatDate(new Date().toISOString())}`,
  );
  patientInfo.push(`Erstellt am: ${formatDate(new Date().toISOString())}`);

  for (const line of patientInfo) {
    doc.text(line, margin, y);
    y += 4.5;
  }
  y += 4;

  // ── Vital Signs Summary ─────────────────────────────────────────────────
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text("Vitalparameter — Übersicht", margin, y);
  y += 6;

  const vitalRows: string[][] = [];
  const vitalTypes = [
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "PULSE",
    "BODY_FAT",
  ];

  for (const type of vitalTypes) {
    const s = data.stats[type];
    if (!s) continue;
    vitalRows.push([
      TYPE_LABELS[type] || type,
      `${fmt(s.latest)} ${TYPE_UNITS[type] || ""}`,
      `${fmt(s.avg)} ${TYPE_UNITS[type] || ""}`,
      `${fmt(s.min)}`,
      `${fmt(s.max)}`,
      `${s.count}`,
    ]);
  }

  if (vitalRows.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Parameter", "Aktuell", "Ø Zeitraum", "Min", "Max", "n"]],
      body: vitalRows,
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
      margin: { left: margin, right: margin },
    });
    y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
      .finalY + 8;
  }

  // ── Blood Pressure Classification ────────────────────────────────────────
  const sysStat = data.stats.BLOOD_PRESSURE_SYS;
  const diaStat = data.stats.BLOOD_PRESSURE_DIA;
  if (sysStat && diaStat) {
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("Blutdruck — ESC/ESH-Klassifikation (2018)", margin, y);
    y += 5;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    const bpClass = getBpClassification(sysStat.avg, diaStat.avg);
    doc.text(
      `Durchschnittlicher Blutdruck: ${fmt(sysStat.avg, 0)}/${fmt(diaStat.avg, 0)} mmHg — Klassifikation: ${bpClass}`,
      margin,
      y,
    );
    y += 8;
  }

  // ── BMI ──────────────────────────────────────────────────────────────────
  if (data.bmi) {
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("Body-Mass-Index (BMI)", margin, y);
    y += 5;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(
      `BMI: ${fmt(data.bmi)} kg/m² — Klassifikation: ${getBmiClassification(data.bmi)} (WHO)`,
      margin,
      y,
    );
    y += 8;
  }

  // ── Medication Compliance ────────────────────────────────────────────────
  const complianceEntries = Object.entries(data.compliance);
  if (complianceEntries.length > 0) {
    if (y > 240) {
      doc.addPage();
      y = margin;
    }

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("Medikamenten-Compliance", margin, y);
    y += 6;

    const compRows = complianceEntries.map(([name, c]) => {
      const rate = c.total > 0 ? ((c.taken / c.total) * 100).toFixed(1) : "—";
      return [name, `${c.taken}`, `${c.skipped}`, `${c.missed}`, `${c.total}`, `${rate}%`];
    });

    autoTable(doc, {
      startY: y,
      head: [
        ["Medikament", "Eingenommen", "Übersprungen", "Verpasst", "Gesamt", "Compliance-Rate"],
      ],
      body: compRows,
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
      margin: { left: margin, right: margin },
    });
    y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
      .finalY + 8;
  }

  // ── Mood ─────────────────────────────────────────────────────────────────
  if (data.mood) {
    if (y > 240) {
      doc.addPage();
      y = margin;
    }

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("Stimmungsverlauf", margin, y);
    y += 6;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(
      `Durchschnitt: ${fmt(data.mood.avg)} / 5,0  |  Einträge: ${data.mood.count}  |  Bereich: ${data.mood.min} – ${data.mood.max}`,
      margin,
      y,
    );
    y += 6;

    const distRows = Object.entries(data.mood.distribution).map(
      ([score, count]) => [
        MOOD_LABELS[Number(score)] || score,
        `${count}`,
        `${data.mood!.count > 0 ? ((count / data.mood!.count) * 100).toFixed(1) : 0}%`,
      ],
    );

    autoTable(doc, {
      startY: y,
      head: [["Stimmung", "Anzahl", "Anteil"]],
      body: distRows,
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
      margin: { left: margin, right: margin },
    });
    y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
      .finalY + 8;
  }

  // ── Footer / Disclaimer ──────────────────────────────────────────────────
  const addFooter = (pageDoc: jsPDF) => {
    const pageHeight = pageDoc.internal.pageSize.getHeight();
    pageDoc.setFontSize(7);
    pageDoc.setFont("helvetica", "italic");
    pageDoc.setTextColor(140, 140, 140);
    pageDoc.text(
      "Dieser Bericht wurde automatisch aus selbst erfassten Daten generiert und dient ausschließlich zur Unterstützung",
      margin,
      pageHeight - 14,
    );
    pageDoc.text(
      "des Arzt-Patienten-Gesprächs. Er ersetzt keine ärztliche Diagnose. Korrelationen implizieren keine Kausalität.",
      margin,
      pageHeight - 10,
    );
    pageDoc.text(
      `Quelle: HealthLog | Zeitzone: Europe/Berlin | Erstellt: ${new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}`,
      margin,
      pageHeight - 6,
    );
  };

  // Add footer to all pages
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addFooter(doc);
  }

  return doc;
}
