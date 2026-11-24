/**
 * A synthetic lab report as a scan: the table drawn as a picture, so it has
 * no text layer, either as a photo (JPEG) or as an image-only PDF. Every
 * value is made up; nothing here is anyone's record.
 */
import { createCanvas } from "@napi-rs/canvas";
import { jsPDF } from "jspdf";

/** The rows drawn, in columns: name, value, unit, range. */
const SYNTHETIC_ROWS: readonly (readonly [string, string, string, string])[] = [
  ["Natrium", "141", "mmol/l", "135 - 145"],
  ["Kalium", "4,2", "mmol/l", "3,5 - 5,1"],
  ["Kreatinin", "1,08", "mg/dl", "0,70 - 1,20"],
  ["Hämoglobin", "14,6", "g/dl", "13,5 - 17,5"],
  ["TSH", "2,31", "mU/l", "0,27 - 4,20"],
];

/** An A4-shaped page with a header, a sample date and the table, as JPEG. */
export function syntheticLabScanJpeg(): Buffer {
  const width = 2480;
  const height = 3508;
  const canvas = createCanvas(width, height);
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#000000";
  g.font = "bold 56px sans-serif";
  g.fillText("Labor Beispielstadt - Befundbericht", 160, 220);
  g.font = "44px sans-serif";
  g.fillText("Probeneingang: 03.11.2026", 160, 320);
  const columns = [160, 1000, 1450, 1900];
  ["Parameter", "Ergebnis", "Einheit", "Referenzbereich"].forEach((h, i) =>
    g.fillText(h, columns[i], 480),
  );
  SYNTHETIC_ROWS.forEach((row, r) => {
    row.forEach((cell, i) => g.fillText(cell, columns[i], 580 + r * 90));
  });
  return canvas.toBuffer("image/jpeg", 92);
}

/** The same page as an image-only PDF: a scan with no text layer. */
export function syntheticLabScanPdf(pages = 1): Buffer {
  const jpeg = syntheticLabScanJpeg().toString("base64");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  for (let i = 0; i < pages; i++) {
    if (i > 0) doc.addPage();
    doc.addImage(`data:image/jpeg;base64,${jpeg}`, "JPEG", 0, 0, 210, 297);
  }
  return Buffer.from(doc.output("arraybuffer"));
}
