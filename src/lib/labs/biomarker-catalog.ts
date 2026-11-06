/**
 * v1.18.1 — static seed catalog of common blood/lab biomarkers.
 *
 * This is NOT a DB table. It is a curated list offered at the add step
 * ("pick a common marker, or create your own") so a self-hoster does not
 * type a marker definition from scratch. Selecting a seed pre-fills the
 * inline definition form (canonical name, unit, suggested reference bounds)
 * which the user then accepts or overrides before it becomes a real,
 * user-scoped `Biomarker` row.
 *
 * The suggested ranges are EDITABLE DEFAULTS, never gospel — reference
 * windows vary by lab, sex, and age. The display name is localised via the
 * `labs.catalog.<slug>` i18n key; the EN slug is the stable identity (mirrors
 * the Insights slug/alias pattern). Units stay literal (mg/dL etc. are not
 * translated).
 *
 * Source ranges: common adult fasting reference windows (US conventional
 * units where the metric/SI split matters). Presented as starting points.
 */

export interface BiomarkerSeed {
  /** Stable EN identity; the `labs.catalog.<slug>` i18n key resolves the name. */
  slug: string;
  /** Panel grouping key; the `labs.catalog.panel.<panel>` i18n key labels it. */
  panel: string;
  /** Canonical unit for every reading against this marker. */
  unit: string;
  /** Suggested lower bound (editable default), or null when open-ended. */
  lowerBound: number | null;
  /** Suggested upper bound (editable default), or null when open-ended. */
  upperBound: number | null;
}

export const BIOMARKER_CATALOG: readonly BiomarkerSeed[] = [
  // Lipids
  {
    slug: "total-cholesterol",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 200,
  },
  {
    slug: "ldl",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 116,
  },
  {
    slug: "hdl",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: 40,
    upperBound: null,
  },
  {
    slug: "triglycerides",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 150,
  },
  // v1.25 — longevity panel: atherogenic-particle burden + genetic + RBC EPA/DHA.
  // ApoB is the primary atherogenic-burden number (ESC/EAS 2019); the upper
  // bound is the population-desirable line, lower goals are care-context-specific.
  {
    slug: "apob",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 90,
  },
  // Lp(a) is largely genetically fixed (measure once, flag elevated); molar
  // (nmol/L) reporting preferred — never interconvert mass↔molar by a factor.
  {
    slug: "lp-a",
    panel: "lipids",
    unit: "nmol/L",
    lowerBound: null,
    upperBound: 125,
  },
  // Omega-3 index (RBC EPA+DHA %): cardioprotective/optimal 8–12%.
  {
    slug: "omega-3-index",
    panel: "lipids",
    unit: "%",
    lowerBound: 8,
    upperBound: null,
  },
  // Glucose metabolism
  {
    slug: "fasting-glucose",
    panel: "glucose",
    unit: "mg/dL",
    lowerBound: 70,
    upperBound: 100,
  },
  {
    slug: "hba1c",
    panel: "glucose",
    unit: "%",
    lowerBound: null,
    upperBound: 5.7,
  },
  // v1.25 — longevity panel: fasting insulin (metabolically-optimal often
  // cited < 8 µIU/mL; typical reference ~2.5–13). HOMA-IR is derived from
  // fasting glucose × insulin (see `homa-ir.ts`), not a stored catalog marker.
  {
    slug: "fasting-insulin",
    panel: "glucose",
    unit: "µIU/mL",
    lowerBound: 2.5,
    upperBound: 13,
  },
  // Thyroid
  {
    slug: "tsh",
    panel: "thyroid",
    unit: "mIU/L",
    lowerBound: 0.4,
    upperBound: 4,
  },
  {
    slug: "ft3",
    panel: "thyroid",
    unit: "pg/mL",
    lowerBound: 2.3,
    upperBound: 4.2,
  },
  {
    slug: "ft4",
    panel: "thyroid",
    unit: "ng/dL",
    lowerBound: 0.8,
    upperBound: 1.8,
  },
  // Iron
  {
    slug: "ferritin",
    panel: "iron",
    unit: "ng/mL",
    lowerBound: 30,
    upperBound: 400,
  },
  {
    slug: "transferrin-saturation",
    panel: "iron",
    unit: "%",
    lowerBound: 20,
    upperBound: 50,
  },
  // Vitamins
  {
    slug: "vitamin-d",
    panel: "vitamins",
    unit: "ng/mL",
    lowerBound: 30,
    upperBound: 100,
  },
  {
    slug: "vitamin-b12",
    panel: "vitamins",
    unit: "pg/mL",
    lowerBound: 200,
    upperBound: 900,
  },
  {
    slug: "folate",
    panel: "vitamins",
    unit: "ng/mL",
    lowerBound: 3,
    upperBound: 20,
  },
  // Inflammation
  {
    slug: "hs-crp",
    panel: "inflammation",
    unit: "mg/L",
    lowerBound: null,
    upperBound: 3,
  },
  // Renal
  {
    slug: "creatinine",
    panel: "renal",
    unit: "mg/dL",
    lowerBound: 0.6,
    upperBound: 1.3,
  },
  {
    slug: "egfr",
    panel: "renal",
    unit: "mL/min/1.73m²",
    lowerBound: 90,
    upperBound: null,
  },
  // Liver
  {
    slug: "alt",
    panel: "liver",
    unit: "U/L",
    lowerBound: null,
    upperBound: 40,
  },
  {
    slug: "ast",
    panel: "liver",
    unit: "U/L",
    lowerBound: null,
    upperBound: 40,
  },
  {
    slug: "ggt",
    panel: "liver",
    unit: "U/L",
    lowerBound: null,
    upperBound: 55,
  },
  // v1.43 — the two markers a report most often prints in shorthand
  // ("Alk.P", "T.Bili"). Adult reference windows per MedlinePlus: ALP 44-147
  // IU/L, total bilirubin 0.1-1.2 mg/dL. Editable defaults like every seed.
  {
    slug: "alkaline-phosphatase",
    panel: "liver",
    unit: "U/L",
    lowerBound: 44,
    upperBound: 147,
  },
  {
    slug: "bilirubin-total",
    panel: "liver",
    unit: "mg/dL",
    lowerBound: 0.1,
    upperBound: 1.2,
  },
  // Electrolytes
  {
    slug: "sodium",
    panel: "electrolytes",
    unit: "mmol/L",
    lowerBound: 135,
    upperBound: 145,
  },
  {
    slug: "potassium",
    panel: "electrolytes",
    unit: "mmol/L",
    lowerBound: 3.5,
    upperBound: 5.1,
  },
  // Blood count
  {
    slug: "hemoglobin",
    panel: "bloodCount",
    unit: "g/dL",
    lowerBound: 12,
    upperBound: 17.5,
  },
  {
    slug: "hematocrit",
    panel: "bloodCount",
    unit: "%",
    lowerBound: 36,
    upperBound: 50,
  },
  {
    slug: "wbc",
    panel: "bloodCount",
    unit: "10³/µL",
    lowerBound: 4,
    upperBound: 11,
  },
  {
    slug: "platelets",
    panel: "bloodCount",
    unit: "10³/µL",
    lowerBound: 150,
    upperBound: 400,
  },
] as const;

/** The set of panel keys present in the catalog, in display order. */
export const BIOMARKER_PANELS = [
  "lipids",
  "glucose",
  "thyroid",
  "iron",
  "vitamins",
  "inflammation",
  "renal",
  "liver",
  "electrolytes",
  "bloodCount",
] as const;

export type BiomarkerPanelKey = (typeof BIOMARKER_PANELS)[number];

/**
 * The panel an analyte with no seed belongs to, for grouping the labs list.
 * Every key in `ANALYTE_ALIASES` and `LAB_NAME_ALIASES` that is not a seed
 * slug is listed here, so a marker recognised by one of those names lands in
 * a catalog category instead of "Other" (`marker-category-coverage.test.ts`
 * holds the two lists together). Uric acid sits with the kidney markers and
 * LDH with the liver markers, the way German lab reports print them.
 */
export const ALIAS_PANEL: Readonly<Record<string, BiomarkerPanelKey>> = {
  urea: "renal",
  "blood-urea-nitrogen": "renal",
  "uric-acid": "renal",
  ldh: "liver",
  "calcium-total": "electrolytes",
  crp: "inflammation",
  rbc: "bloodCount",
  mcv: "bloodCount",
  mch: "bloodCount",
  mchc: "bloodCount",
};

/**
 * Names a marker may carry for an analyte the unit-conversion registry knows
 * (`src/lib/labs/unit-conversion/registry.ts`), keyed by the analyte key a
 * marker stores: the catalog slug (`ldl`, `hdl`, `fasting-glucose`), or a
 * registry-only key for an analyte with no seed.
 *
 * A `Biomarker` row keeps only its name, not the seed it came from, so this is
 * how a marker is told which analyte it is: its folded name equals one of these,
 * or one of the localised names of a seed the registry knows (`ldl`, `hba1c`,
 * `fasting-glucose`, ...). The match is the WHOLE name, never a part of it, so
 * "Calcium (ionisiert)" is not "Calcium" and "Urea nitrogen" is not "Urea". A
 * name that two analytes claim is left out of the match, and a marker named in
 * some other way stays unlinked, which is the safe default.
 *
 * Names are compared folded (lower case, no accents, hyphens and slashes as
 * spaces), so "Harnsäure" is written "harnsaure" here and "Nüchtern-Glukose"
 * needs no entry of its own. The registry-only keys (urea, blood urea
 * nitrogen, uric acid, total calcium) have no seed, so their names live only
 * here; total bilirubin has had a seed since v1.43.
 */
export interface AnalyteAliases {
  /** The analyte key: a catalog slug, or a registry-only key. */
  key: string;
  names: readonly string[];
}

export const ANALYTE_ALIASES: readonly AnalyteAliases[] = [
  {
    key: "fasting-glucose",
    names: [
      "glucose",
      "blood glucose",
      "blood sugar",
      "plasma glucose",
      "fasting blood glucose",
      "fasting blood sugar",
      "fasting plasma glucose",
      "glukose",
      "blutglukose",
      "blutzucker",
      "nuchternblutzucker",
      "glucosa",
      "glicemia",
      "glycemie",
      "glucosio",
      "glukoza",
      "glikemia",
    ],
  },
  {
    key: "hba1c",
    names: [
      "hb a1c",
      "a1c",
      "hemoglobin a1c",
      "glycated hemoglobin",
      "glycosylated hemoglobin",
      "glykohamoglobin",
      "hamoglobin a1c",
      // v1.43 — MedlinePlus, Lab Tests Online (es, it, pl), Medics
      // Labor, CHU de Lille, IUCPQ / CHUM, Asan Medical Center.
      "hba1c",
      "glycohemoglobin",
      "glykohamoglobin a1c",
      "hemoglobina glicada",
      "hemoglobina glicosilada",
      "glicohemoglobina",
      "hemoglobine glyquee",
      "hb glyque",
      "glycohemoglobine",
      "hemoglobine glycosylee",
      "emoglobina a1c",
      "glicoemoglobina",
      "emoglobina glicosilata",
      "hemoglobina glikowana",
      "glikohemoglobina",
      "당화혈색소",
    ],
  },
  {
    key: "total-cholesterol",
    names: [
      "cholesterol",
      "cholesterin",
      "cholesterol total",
      "cholesterin gesamt",
      "cholesterol gesamt",
      "colesterol",
      "colesterolo",
      "cholesterol calkowity",
    ],
  },
  {
    key: "ldl",
    names: [
      "ldl",
      "ldl c",
      "ldl chol",
      "ldl cholesterin",
      // v1.43 — Labor Limbach, Medics Labor, gesundheit.gv.at, CHU de Lille,
      // the Korean national screening form.
      "ldl direkt",
      "ldlch",
      "cholesterol ldl",
      "저밀도 콜레스테롤",
    ],
  },
  {
    key: "hdl",
    names: [
      "hdl",
      "hdl c",
      "hdl chol",
      "hdl cholesterin",
      "hdlch",
      "cholesterol hdl",
      "고밀도 콜레스테롤",
    ],
  },
  {
    key: "creatinine",
    names: [
      "serum creatinine",
      "serumkreatinin",
      "kreatinin im serum",
      "creatinine serique",
      // v1.43 — Labor Limbach ("Krea/S", serum only: the urine "Krea/U" is a
      // different measurement and is not here), Medics Labor, Lab Tests
      // Online (es, it, pl), CHU de Lille, CHUM, the Korean screening form.
      "krea s",
      "krea",
      "crea",
      "creatinin",
      "kreatinin",
      "creatininemie",
      "creat",
      "creatinina sierica",
      "혈청 크레아티닌",
    ],
  },
  {
    key: "vitamin-d",
    names: [
      "25 oh vitamin d",
      "25 hydroxy vitamin d",
      "25 hydroxyvitamin d",
      "25 oh d",
      "calcidiol",
      "vitamin d 25 oh",
      // v1.43 — 25-OH only; calcitriol (1,25-(OH)2 D) is a different test and
      // stays out. MedlinePlus, Medics Labor, gesundheit.gv.at, Lab Tests
      // Online (es, it, pl), CHU de Lille, IUCPQ.
      "25(oh)d",
      "25 (oh)d",
      "calcifediol",
      "25 hydroxycholecalciferol",
      "vd25",
      "25 hidroxivitamina d",
      "25 (oh) vitamine d",
      "25 oh, vitamine d3",
      "25 oh vitamina d",
      "25 idrossi vitamina d",
      "25 hydroksy witamina d3",
      "kalcydiol",
      "25 hydroksykolekalciferol",
    ],
  },
  { key: "urea", names: ["urea", "harnstoff", "uree", "urea serum"] },
  {
    key: "blood-urea-nitrogen",
    names: [
      "bun",
      "blood urea nitrogen",
      "urea nitrogen",
      "harnstoff stickstoff",
      "stickstoff harnstoff",
      "azote ureique",
    ],
  },
  {
    key: "uric-acid",
    names: [
      "uric acid",
      "urate",
      "harnsaure",
      "acide urique",
      "acido urico",
      "kwas moczowy",
    ],
  },
  {
    key: "calcium-total",
    names: [
      "calcium",
      "total calcium",
      "calcium total",
      "calcium gesamt",
      "gesamtcalcium",
      "kalzium",
      "kalzium gesamt",
      "gesamtkalzium",
      "calcio",
      "wapn",
    ],
  },
  {
    key: "bilirubin-total",
    names: [
      "bilirubin",
      "total bilirubin",
      "bilirubin total",
      "bilirubin gesamt",
      "gesamtbilirubin",
      "bilirrubina",
      "bilirubine",
      "bilirubina",
      // v1.43 — "Alk.P" / "T.Bili" are how the reports in the
      // discussion print them; the rest are MedlinePlus, testing.com, Labor
      // Limbach, Medics Labor, Lab Tests Online (es, it), Dimedic (pl) and
      // Asan Medical Center. The bare "BIL" is left out: lower case it is the
      // urine dipstick field in German code lists.
      "t.bili",
      "t. bili",
      "tbil",
      "total serum bilirubin",
      "tsb",
      "bili",
      "totales bilirubin",
      "bilirrubina total",
      "bilirubina totale",
      "bilirubina całkowita",
      "총 빌리루빈",
    ],
  },
];

/**
 * v1.43 — other names for analytes, for recognising that two
 * spellings on two reports are one marker. Same shape and fold as
 * `ANALYTE_ALIASES`, and read together with it by `catalogNameIndex`, but
 * with no conversion attached: an analyte here may have no entry in the
 * unit-conversion registry ("GPT" is "ALT" whatever the unit), and the key may
 * be a catalog slug or a name-only key for an analyte with no seed (`ldh`,
 * `mcv`). Nothing here changes which unit conversion a marker gets.
 *
 * Every name is written folded (`foldForMatch`); a dot in shorthand is kept
 * ("alk.p") and also matched without it. Each name was checked against a
 * laboratory or clinical reference; a shorthand that names two analytes in
 * different places ("PCR", "AP" outside German reports, "Cr") is left out,
 * because a wrong automatic match moves a reading into the wrong history.
 */
export const LAB_NAME_ALIASES: readonly AnalyteAliases[] = [
  {
    key: "alkaline-phosphatase",
    names: [
      "alp",
      "alkp",
      "alk phos",
      "alk.p",
      "ap",
      "alk. phosphatase",
      "alkalische phosphatase",
      "fosfatasa alcalina",
      "pal",
      "phosphatases alcalines",
      "fosfatasi alcalina",
      "fosfataza alkaliczna",
      "fosfataza zasadowa",
      "알칼리인산분해효소",
    ],
  },
  {
    key: "alt",
    names: [
      "alt",
      "sgpt",
      "gpt",
      "alanine transaminase",
      "alanine aminotransferase",
      "alat",
      "glutamat pyruvat transaminase",
      "alanina aminotransferasa",
      "transaminasa glutamico piruvico",
      "tgp",
      "alanina aminotransferasi",
      "aminotransferaza alaninowa",
      "alt(sgpt)",
      "혈청gpt",
      "알라닌아미노전달효소",
      "알라닌아미노전이효소",
    ],
  },
  {
    key: "ast",
    names: [
      "ast",
      "sgot",
      "got",
      "aspartate transaminase",
      "aspartate aminotransferase",
      "asat",
      "glutamat oxalacetat transaminase",
      "aspartato aminotransferasa",
      "transaminasa glutamico oxalacetico",
      "tgo",
      "aspartato transaminasi",
      "aspat",
      "aminotransferaza asparaginianowa",
      "ast(sgot)",
      "혈청got",
      "아스파테이트아미노전달효소",
      "아스파테이트아미노전이효소",
    ],
  },
  {
    key: "ggt",
    names: [
      "ggt",
      "ggtp",
      "gtp",
      "gamma gt",
      "γ gt",
      "γgt",
      "gamma glutamyltransferase",
      "gammaglutamyltransferase",
      "gamma glutamil transferasa",
      "gamma glutamylotranspeptydaza",
      "감마지티피(γgtp)",
      "γgtp",
      "감마지티피",
      "감마지티",
      "r gtp",
      "감마 gtp",
      "감마글루타밀전이효소",
    ],
  },
  {
    key: "ldh",
    names: [
      "ldh",
      "ld",
      "lactate dehydrogenase",
      "lactic dehydrogenase",
      "lactatdehydrogenase",
      "laktatdehydrogenase",
      "lactato deshidrogenasa",
      "lactate deshydrogenase",
      "lattico deidrogenasi",
      "lattato deidrogenasi",
      "dehydrogenaza mleczanowa",
      "젖산탈수효소",
    ],
  },
  {
    // The standard assay. "PCR" is left out: it is CRP on Spanish and
    // Italian reports and polymerase chain reaction everywhere else.
    key: "crp",
    names: [
      "crp",
      "c reactive protein",
      "c reaktives protein",
      "proteina c reactiva",
      "proteine c reactive",
      "proteina c reattiva",
      "białko c reaktywne",
      "c 반응성 단백",
    ],
  },
  {
    // The high-sensitivity assay, kept apart from the standard one: the two
    // are read against different ranges, and a merge is the person's call.
    key: "hs-crp",
    names: [
      "hs crp",
      "hscrp",
      "high sensitivity crp",
      "cardiac crp",
      "crp hochsensitiv",
      "pcr ultrasensible",
      "pcr us",
      "proteina c reactiva ultrasensible",
      "crp ultrasensible",
      "crp hs",
      "hs pcr",
      "pcr ultrasensibile",
      "proteina c reattiva ultrasensibile",
      "crp wysoko czułe",
      "crp ultra czułe",
      "wysoko czułe białko c reaktywne",
    ],
  },
  {
    key: "tsh",
    names: [
      "tsh",
      "thyrotropin",
      "thyroid stimulating hormone",
      "thyreotropin",
      "tsh basal",
      "tirotropina",
      "hormona estimulante del tiroides",
      "hormona tiroestimulante",
      "tsh us",
      "tsh ultra sensible",
      "thyrotropine",
      "tireotropina",
      "ormone tireotropo",
      "tyreotropina",
      "hormon tyreotropowy",
      "갑상선자극호르몬",
    ],
  },
  {
    // Free T3 only: a bare "T3" is the total hormone.
    key: "ft3",
    names: [
      "ft3",
      "free t3",
      "free triiodothyronine",
      "t3 frei",
      "freies t3",
      "trijodthyronin frei",
      "t3 libre",
      "t3l",
      "triiodotironina libera",
      "wolna t3",
    ],
  },
  {
    // Free T4 only: a bare "T4" is the total hormone.
    key: "ft4",
    names: [
      "ft4",
      "free t4",
      "free thyroxine",
      "t4 frei",
      "freies t4",
      "thyroxin frei",
      "t4l",
      "t4 libre",
      "tiroxina libre",
      "thyroxine libre",
      "tiroxina libera",
      "wolna t4",
      "유리 싸이록신",
    ],
  },
  {
    // Estimates only: a bare "GFR" may be a measured rate, and a
    // Cockcroft-Gault clearance is a different quantity.
    key: "egfr",
    names: [
      "egfr",
      "estimated gfr",
      "cgfr",
      "egfr nach ckd epi formel",
      "ckdepi",
      "egfr nach mdrd formel",
      "tefg",
      "tfg calculada",
      "tasa estimada de filtrado glomerular",
      "fge",
      "dfg",
      "dfge",
      "szacowana filtracja kłebuszkowa",
      "신사구체여과율 (e gfr)",
      "e gfr",
      "신사구체여과율",
    ],
  },
  {
    key: "hemoglobin",
    names: ["hb", "hgb", "hemogl", "hemoglobine", "혈색소"],
  },
  {
    key: "hematocrit",
    names: [
      "hct",
      "pcv",
      "crit",
      "packed cell volume",
      "hkt",
      "hto",
      "ht",
      "적혈구용적률",
    ],
  },
  {
    key: "mcv",
    names: [
      "mcv",
      "mittleres zellvolumen",
      "vcm",
      "volumen corpuscular medio",
      "vgm",
      "volume globulaire moyen",
      "평균적혈구용적",
    ],
  },
  {
    // "Hb/E" is Labor Limbach's code for MCH, not haemoglobin.
    key: "mch",
    names: ["mch", "hb e", "hcm", "tcmh", "tgmh", "평균적혈구혈색소량"],
  },
  {
    key: "mchc",
    names: [
      "mchc",
      "chcm",
      "ccmh",
      "cgmh",
      "평균적혈구 헤모글로빈농도",
      "평균 적혈구혈색소 농도",
    ],
  },
  {
    key: "rbc",
    names: [
      "rbc",
      "rbc count",
      "erythrocyte count",
      "red count",
      "ery",
      "erythrozyten",
      "recuento de hematies",
      "recuento eritrocitario",
      "erythrocytes",
      "hematies",
      "liczba erytrocytow",
      "적혈구",
    ],
  },
  {
    key: "wbc",
    names: [
      "wbc",
      "leukocyte count",
      "white cell count",
      "leuko",
      "leukozyten",
      "leuc",
      "leucocitos",
      "leucocytes",
      "liczba leukocytow",
      "백혈구",
    ],
  },
  {
    key: "platelets",
    names: [
      "plt",
      "plt count",
      "thrombocyte count",
      "thromb",
      "thr",
      "thrombozyten",
      "plaq",
      "plaquetas",
      "plaquettes",
      "conta piastrinica",
      "liczba płytek krwi",
      "liczba trombocytow",
      "platelet",
      "혈소판",
    ],
  },
  {
    // "TG" is left out: written "Tg" it is thyroglobulin, and the match
    // ignores case.
    key: "triglycerides",
    names: [
      "trig",
      "tgl",
      "trg",
      "triglyceride",
      "triglycerides",
      "trigliceridos",
      "trigliceridi",
      "triglicerydy",
      "중성지방",
    ],
  },
  {
    key: "ferritin",
    names: [
      "ferritin",
      "serum ferritin",
      "ferr",
      "ferritina",
      "ferritine",
      "ferritina sierica",
      "ferrytyna",
    ],
  },
  {
    key: "vitamin-b12",
    names: [
      "vitamin b12",
      "b12",
      "cobalamin",
      "cobalamina",
      "vitamine b12",
      "cyanocobalamine",
      "vb12",
      "vitamina b12",
      "witamina b12",
      "kobalamina",
    ],
  },
  {
    key: "sodium",
    names: ["na", "na+", "natrium", "sodium", "sodio", "natremie", "소디움"],
  },
  {
    // A bare "K" only ever reaches a potassium marker whose unit the reading
    // fits (`resolveInIndex`), never vitamin K.
    key: "potassium",
    names: [
      "k",
      "k+",
      "kalium",
      "potassium",
      "potasio",
      "potassio",
      "potas",
      "kaliemie",
      "포타슘",
    ],
  },
];
