/**
 * The client half of the CSV record imports (#1215): reading the head of a
 * file for the mapping screen, suggesting which column feeds which field and
 * how the file writes numbers and dates, and the downloadable templates.
 *
 * Suggestions only. The person sees every choice on the mapping screen and
 * the server checks every row against what was chosen; nothing here decides
 * a value.
 */
import { CsvTokenizer, type CsvDelimiter } from "@/lib/import/csv-stream";

export type RecordImportKind = "labs" | "medications";

export const LAB_FIELDS = [
  { key: "analyte", required: true },
  { key: "value", required: true },
  { key: "unit", required: false },
  { key: "date", required: true },
  { key: "time", required: false },
  { key: "referenceRange", required: false },
  { key: "referenceLow", required: false },
  { key: "referenceHigh", required: false },
  { key: "panel", required: false },
  { key: "note", required: false },
] as const;

export const MEDICATION_FIELDS = [
  { key: "name", required: true },
  { key: "dose", required: true },
  { key: "times", required: false },
  { key: "asNeeded", required: false },
  { key: "startsOn", required: false },
  { key: "endsOn", required: false },
] as const;

export type FieldKey =
  | (typeof LAB_FIELDS)[number]["key"]
  | (typeof MEDICATION_FIELDS)[number]["key"];

export function fieldsFor(kind: RecordImportKind) {
  return kind === "labs" ? LAB_FIELDS : MEDICATION_FIELDS;
}

/** Header words per field, in the languages HealthLog speaks, folded. */
const SYNONYMS: Record<FieldKey, string[]> = {
  analyte: [
    "analyte",
    "marker",
    "biomarker",
    "test",
    "parameter",
    "analyt",
    "laborwert",
    "wert name",
    "name",
    "prueba",
    "analyse",
    "esame",
    "badanie",
  ],
  value: [
    "value",
    "result",
    "wert",
    "ergebnis",
    "resultado",
    "valor",
    "valeur",
    "resultat",
    "valore",
    "risultato",
    "wynik",
    "waarde",
    "uitslag",
    "결과",
    "값",
  ],
  unit: [
    "unit",
    "units",
    "einheit",
    "unidad",
    "unite",
    "unita",
    "jednostka",
    "eenheid",
    "단위",
  ],
  date: [
    "date",
    "datum",
    "fecha",
    "data",
    "day",
    "tag",
    "taken",
    "taken at",
    "collected",
    "abnahme",
    "날짜",
  ],
  time: [
    "time",
    "uhrzeit",
    "zeit",
    "hora",
    "heure",
    "ora",
    "godzina",
    "tijd",
    "시간",
  ],
  referenceRange: [
    "reference",
    "reference range",
    "range",
    "referenz",
    "referenzbereich",
    "normbereich",
    "norm",
    "rango",
    "reference interval",
    "intervalle",
    "riferimento",
    "zakres",
    "referentie",
  ],
  referenceLow: ["low", "min", "lower", "untergrenze", "von", "ref low"],
  referenceHigh: ["high", "max", "upper", "obergrenze", "bis", "ref high"],
  panel: ["panel", "group", "gruppe", "profil", "category", "kategorie"],
  note: [
    "note",
    "notes",
    "comment",
    "kommentar",
    "notiz",
    "bemerkung",
    "nota",
    "remarque",
    "uwagi",
    "opmerking",
  ],
  name: [
    "name",
    "medication",
    "medicine",
    "drug",
    "medikament",
    "arznei",
    "präparat",
    "praparat",
    "wirkstoff",
    "medicamento",
    "medicament",
    "farmaco",
    "lek",
    "medicijn",
    "약",
  ],
  dose: [
    "dose",
    "dosage",
    "dosis",
    "dosierung",
    "strength",
    "stärke",
    "starke",
    "dosage",
    "dawka",
    "용량",
  ],
  times: [
    "times",
    "time",
    "schedule",
    "uhrzeit",
    "uhrzeiten",
    "einnahme",
    "zeiten",
    "horario",
    "heures",
    "orari",
    "godziny",
    "tijden",
    "시간",
  ],
  asNeeded: [
    "as needed",
    "prn",
    "bei bedarf",
    "bedarf",
    "a demanda",
    "si besoin",
    "al bisogno",
    "w razie potrzeby",
    "zo nodig",
    "필요시",
  ],
  startsOn: [
    "start",
    "starts",
    "start date",
    "begin",
    "beginn",
    "seit",
    "from",
    "von",
    "inicio",
    "debut",
    "inizio",
    "od",
    "begin datum",
  ],
  endsOn: [
    "end",
    "ends",
    "end date",
    "until",
    "bis",
    "ende",
    "fin",
    "fine",
    "do",
    "einddatum",
  ],
};

function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\-./()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Suggest a column per field from the header names. Exact synonym first, then
 * a header that starts with one; a column is offered to one field at most,
 * and the required fields choose first.
 */
export function guessMapping(
  headers: readonly string[],
  kind: RecordImportKind,
): Partial<Record<FieldKey, number>> {
  const folded = headers.map(fold);
  const taken = new Set<number>();
  const out: Partial<Record<FieldKey, number>> = {};
  const order = [...fieldsFor(kind)].sort(
    (a, b) => Number(b.required) - Number(a.required),
  );
  for (const pass of ["exact", "prefix"] as const) {
    for (const { key } of order) {
      if (out[key] !== undefined) continue;
      const words = SYNONYMS[key];
      const index = folded.findIndex(
        (h, i) =>
          !taken.has(i) &&
          words.some((w) =>
            pass === "exact" ? h === w : h.startsWith(`${w} `),
          ),
      );
      if (index >= 0) {
        out[key] = index;
        taken.add(index);
      }
    }
  }
  return out;
}

export interface FileHead {
  delimiter: CsvDelimiter;
  rows: string[][];
}

/** The first `maxRows` records of a file's head text. */
export function readHead(text: string, maxRows = 6): FileHead {
  const tokenizer = new CsvTokenizer("auto");
  const rows: string[][] = [];
  for (const record of [...tokenizer.push(text), ...tokenizer.end()]) {
    rows.push(record.fields);
    if (rows.length >= maxRows) break;
  }
  return { delimiter: tokenizer.detectedDelimiter ?? ",", rows };
}

/**
 * How the sample writes numbers and dates. A semicolon file almost always
 * writes a decimal comma; a sample cell like `5,4` says so outright. The date
 * order follows the first date-shaped cell: ISO, then a first number above 12
 * (day first) or a second above 12 (month first), then the separator habit
 * (`.` is day first, `/` alone is left to the person: it stays ISO-default
 * `dmy` only when a dot is seen).
 */
export function guessFormat(
  head: FileHead,
  dateColumn: number | undefined,
): { decimal: "dot" | "comma"; dateOrder: "iso" | "dmy" | "mdy" } {
  const data = head.rows.slice(1);
  const cells = data.flat();
  const commaNumber = cells.some((c) => /^-?\d+,\d{1,2}$/.test(c.trim()));
  const decimal = head.delimiter === ";" || commaNumber ? "comma" : "dot";

  let dateOrder: "iso" | "dmy" | "mdy" = "iso";
  const dates = data
    .map((r) => (dateColumn === undefined ? "" : (r[dateColumn] ?? "").trim()))
    .filter(Boolean);
  for (const d of dates) {
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
      dateOrder = "iso";
      break;
    }
    const m = /^(\d{1,2})([./-])(\d{1,2})\2\d{4}/.exec(d);
    if (!m) continue;
    if (Number(m[1]) > 12) {
      dateOrder = "dmy";
      break;
    }
    if (Number(m[3]) > 12) {
      dateOrder = "mdy";
      break;
    }
    dateOrder = m[2] === "." ? "dmy" : "mdy";
  }
  return { decimal, dateOrder };
}

export const RECORD_IMPORT_TEMPLATES: Record<RecordImportKind, string> = {
  labs: [
    "analyte,value,unit,date,time,reference range,panel,note",
    "HbA1c,5.4,%,2025-03-01,08:15,4.0-5.6,Diabetes,",
    "Ferritin,85,ng/mL,2025-03-01,08:15,30-400,Iron,",
    "INR,1.1,1,2025-03-01,08:15,0.8-1.2,Coagulation,",
    "Urine protein,negative,,2025-03-01,,,Urine,",
    "",
  ].join("\n"),
  medications: [
    "name,dose,times,as needed,start,end",
    "Ramipril,5 mg,08:00,,2025-01-01,",
    "Metformin,500 mg,08:00 20:00,,,",
    "Ibuprofen,400 mg,,yes,,",
    "",
  ].join("\n"),
};
