/**
 * The emergency card as a printable wallet card (v1.49).
 *
 * One A4 page with the card's two sides at credit-card size (85.6 × 54 mm)
 * next to each other, joined at a fold line: print, cut along the outline,
 * fold, and it fits a wallet. The front holds the name, when the card shows
 * it, under the title, then what a first responder acts on first (blood
 * type, allergies, conditions, medications, pregnancy); the back
 * holds who to call, implants and the declarations, and, when the owner hands
 * in the live link, its QR code. Text that does not fit is cut with an
 * ellipsis and the card says so: the full card is behind the QR code and in
 * the app.
 *
 * Rendered with the doctor report's embedded fonts, so every language the app
 * speaks prints, Hangul included.
 */
import { jsPDF } from "jspdf";
import QRCode from "qrcode";

import {
  PDF_FONT_FAMILY,
  registerReportFonts,
} from "@/lib/doctor-report-pdf/fonts";
import type { Locale } from "@/lib/i18n/config";

import type { EmergencyCardView } from "./card-data";
import {
  emergencyCardRows,
  formatCardDay,
  splitCardTitle,
  type Translate,
} from "./rows";

const CARD_W = 85.6;
const CARD_H = 54;
const PAD = 3;
const FRONT_KEYS = [
  "NAME",
  "BLOOD_TYPE",
  "ALLERGIES",
  "CONDITIONS",
  "MEDICATIONS",
  "PREGNANCY",
];

type Row = ReturnType<typeof emergencyCardRows>[number];

/** Write rows into a box; returns whether anything was cut. */
function writeRows(
  doc: jsPDF,
  rows: Row[],
  x: number,
  top: number,
  width: number,
  bottom: number,
): boolean {
  let y = top;
  let cut = false;
  for (const row of rows) {
    if (y + 5 > bottom) {
      cut = true;
      break;
    }
    doc.setFont(PDF_FONT_FAMILY, "bold");
    doc.setFontSize(5.5);
    doc.setTextColor(110, 110, 120);
    doc.text(row.label.toUpperCase(), x, y);
    y += 2.6;
    doc.setFont(PDF_FONT_FAMILY, row.emphasise ? "bold" : "normal");
    doc.setFontSize(row.emphasise ? 7.5 : 6.5);
    doc.setTextColor(25, 25, 35);
    const wrapped = doc.splitTextToSize(
      row.lines.join("; "),
      width,
    ) as string[];
    for (const [i, line] of wrapped.entries()) {
      if (y + 2.8 > bottom) {
        cut = true;
        // Mark the cut on the last line that fits.
        if (i > 0) doc.text("…", x + width - 2, y - 2.8);
        break;
      }
      doc.text(line, x, y);
      y += 2.8;
    }
    y += 1.2;
    if (cut) break;
  }
  return cut;
}

export async function buildWalletCardPdf(args: {
  view: EmergencyCardView;
  t: Translate;
  locale: Locale;
  /** The live link, when the owner has it in hand; drawn as a QR code. */
  linkUrl: string | null;
}): Promise<Uint8Array> {
  const { view, t, locale, linkUrl } = args;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  registerReportFonts(
    doc,
    locale === "ko" || /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿]/.test(JSON.stringify(view)),
  );
  doc.setFont(PDF_FONT_FAMILY, "normal");

  const left = 20;
  const top = 30;
  // A recorded name is the front's title line; asked for and not recorded,
  // it stays a row on the front that says so.
  const { title: name, rows } = splitCardTitle(
    emergencyCardRows(view, t, locale),
  );
  const front = rows.filter((r) => FRONT_KEYS.includes(r.key));
  const back = rows.filter((r) => !FRONT_KEYS.includes(r.key));

  // Instructions above the card.
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 100);
  doc.text(t("emergencyCard.wallet.instructions"), left, top - 10, {
    maxWidth: CARD_W * 2,
  });

  // Outlines and fold.
  doc.setDrawColor(150, 150, 160);
  doc.setLineWidth(0.2);
  doc.roundedRect(left, top, CARD_W * 2, CARD_H, 3, 3, "S");
  doc.setLineDashPattern([1, 1], 0);
  doc.line(left + CARD_W, top, left + CARD_W, top + CARD_H);
  doc.setLineDashPattern([], 0);

  // Front.
  doc.setFillColor(180, 30, 30);
  doc.rect(left, top + 3, 2, CARD_H - 6, "F");
  doc.setFont(PDF_FONT_FAMILY, "bold");
  doc.setFontSize(9);
  doc.setTextColor(180, 30, 30);
  doc.text(t("emergencyCard.title"), left + PAD + 2, top + PAD + 3);
  let rowsTop = top + PAD + 8;
  let nameCut = false;
  if (name) {
    doc.setFontSize(8.5);
    doc.setTextColor(25, 25, 35);
    const lines = doc.splitTextToSize(name, CARD_W - 2 * PAD - 2) as string[];
    doc.text(lines[0], left + PAD + 2, top + PAD + 7.5);
    nameCut = lines.length > 1;
    rowsTop += 4;
  }
  let cut =
    writeRows(
      doc,
      front,
      left + PAD + 2,
      rowsTop,
      CARD_W - 2 * PAD - 2,
      top + CARD_H - PAD - 3,
    ) || nameCut;

  // Back.
  const bx = left + CARD_W + PAD;
  const qrSize = linkUrl ? 24 : 0;
  const textWidth = CARD_W - 2 * PAD - (qrSize ? qrSize + 2 : 0);
  cut =
    writeRows(
      doc,
      back,
      bx,
      top + PAD + 3,
      textWidth,
      top + CARD_H - PAD - 3,
    ) || cut;
  if (linkUrl) {
    const dataUrl = await QRCode.toDataURL(linkUrl, {
      margin: 1,
      width: 300,
      errorCorrectionLevel: "M",
    });
    const qx = left + 2 * CARD_W - PAD - qrSize;
    doc.addImage(dataUrl, "PNG", qx, top + PAD, qrSize, qrSize);
    doc.setFont(PDF_FONT_FAMILY, "normal");
    doc.setFontSize(5);
    doc.setTextColor(90, 90, 100);
    doc.text(t("emergencyCard.wallet.scan"), qx, top + PAD + qrSize + 3, {
      maxWidth: qrSize,
    });
  }

  // Footer line on both sides: the day it was printed, and the cut note.
  doc.setFont(PDF_FONT_FAMILY, "normal");
  doc.setFontSize(5);
  doc.setTextColor(110, 110, 120);
  const footer = t("emergencyCard.savedOn", {
    date: formatCardDay(locale, view.asOf),
  });
  doc.text(footer, left + PAD + 2, top + CARD_H - PAD);
  doc.text(
    cut ? t("emergencyCard.wallet.cut") : t("emergencyCard.subtitle"),
    bx,
    top + CARD_H - PAD,
    { maxWidth: CARD_W - 2 * PAD },
  );

  return new Uint8Array(doc.output("arraybuffer"));
}
