/**
 * v1.37.20 — German/English medical synonym groups for document search.
 *
 * The blind token index (see `content-index.ts`) does whole-token equality
 * only, so a search for "Blutdruck" never found the letter that says "blood
 * pressure" and a search for "Zucker" missed "Glukose". This module closes
 * that gap at QUERY time: the query's tokens are expanded with their group
 * members before hashing, so the index itself never changes — no re-index,
 * no tokenizer-version bump, no schema movement. Recall widens; the match
 * still runs over the same opaque hashes.
 *
 * Deliberately a static curated list. Each group is a set of interchangeable
 * search terms, stored in the SAME normal form the tokeniser produces:
 * lowercase, diacritics stripped ("röntgen" → "rontgen"), single tokens of
 * three characters or more (shorter ones never reach the index). A
 * multi-word clinical phrase appears as its individual content-bearing
 * tokens; array-overlap matching means a partial hit still surfaces the
 * document, which is the right trade for a search box.
 *
 * Curation rule: common terms a German- or English-speaking self-hoster
 * would type against a letter written in the other register (lay term ↔
 * clinical term, German ↔ English). No vendor names, no drug brand names.
 */

/** Interchangeable search-term groups, in tokeniser normal form. */
export const SEARCH_SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  // Vitals
  ["blutdruck", "blood", "pressure", "hypertonie", "hypertension"],
  ["puls", "pulse", "herzfrequenz", "heart", "rate"],
  ["gewicht", "weight", "korpergewicht", "body"],
  ["blutzucker", "zucker", "glukose", "glucose", "sugar", "diabetes"],
  ["sauerstoffsattigung", "sauerstoff", "oxygen", "saturation", "spo2"],
  ["temperatur", "temperature", "fieber", "fever"],
  // Common labs
  ["blutbild", "hamogramm", "hemogram", "cbc", "blutwerte", "laborwerte"],
  ["cholesterin", "cholesterol", "ldl", "hdl", "blutfette", "lipide", "lipids"],
  ["hba1c", "langzeitzucker", "glykohamoglobin"],
  ["schilddruse", "thyroid", "tsh"],
  ["leber", "liver", "leberwerte", "got", "gpt", "transaminasen"],
  ["niere", "kidney", "renal", "kreatinin", "creatinine", "gfr"],
  ["eisen", "iron", "ferritin", "hamoglobin", "hemoglobin", "anamie", "anemia"],
  ["vitamin", "vitamine"],
  ["entzundung", "inflammation", "crp"],
  ["harnsaure", "urat", "urate", "gicht", "gout"],
  // Imaging / procedures
  ["rontgen", "xray", "radiograph"],
  ["ultraschall", "sonographie", "sonografie", "ultrasound"],
  ["mrt", "mri", "kernspintomographie", "kernspin"],
  ["computertomographie", "computertomografie", "tomographie", "tomography"],
  ["mammographie", "mammografie", "mammography", "mammogram"],
  ["bildgebung", "imaging", "radiologie", "radiology"],
  ["ekg", "ecg", "elektrokardiogramm", "electrocardiogram"],
  ["darmspiegelung", "koloskopie", "colonoscopy"],
  ["magenspiegelung", "gastroskopie", "gastroscopy"],
  // Specialties / encounter words
  ["impfung", "impfpass", "vaccination", "vaccine", "immunisierung"],
  ["hausarzt", "allgemeinmedizin", "practitioner"],
  ["kardiologie", "kardiologe", "cardiology", "herz", "cardiac"],
  ["dermatologie", "hautarzt", "dermatology", "haut", "skin"],
  ["orthopadie", "orthopade", "orthopedics", "orthopaedics"],
  ["augenarzt", "ophthalmologie", "ophthalmology", "auge", "eye"],
  ["zahnarzt", "dental", "dentist", "zahn", "tooth"],
  ["gynakologie", "frauenarzt", "gynecology", "gynaecology"],
  ["urologie", "urologe", "urology"],
  // Documents / admin
  ["arztbrief", "befund", "bericht", "letter", "report", "findings"],
  ["uberweisung", "referral"],
  ["rezept", "verordnung", "prescription"],
  ["entlassung", "entlassungsbrief", "discharge"],
  ["operation", "surgery", "eingriff"],
  ["allergie", "allergy", "unvertraglichkeit", "intolerance"],
  ["medikament", "medikation", "medication", "arznei"],
  ["schwangerschaft", "pregnancy"],
  ["schlaf", "sleep", "apnoe", "apnea"],
];

/** Cap on the expanded token set — bounds the hash array the query matches. */
export const MAX_EXPANDED_QUERY_TOKENS = 64;

// Token → its group members, built once at module load.
const SYNONYMS_BY_TOKEN: ReadonlyMap<string, ReadonlyArray<string>> = (() => {
  const map = new Map<string, string[]>();
  for (const group of SEARCH_SYNONYM_GROUPS) {
    for (const token of group) {
      const existing = map.get(token);
      if (existing) {
        // A token may sit in more than one group ("blood" rides both the
        // pressure and the count groups); merge, keep unique.
        for (const member of group) {
          if (!existing.includes(member)) existing.push(member);
        }
      } else {
        map.set(token, [...group]);
      }
    }
  }
  return map;
})();

/**
 * Expand normalised query tokens with their synonym-group members. The
 * original tokens always survive (and lead the list, so the cap trims
 * expansions before it ever trims what the user actually typed).
 */
export function expandQueryTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    if (seen.has(token) || out.length >= MAX_EXPANDED_QUERY_TOKENS) return;
    seen.add(token);
    out.push(token);
  };
  for (const token of tokens) push(token);
  for (const token of tokens) {
    const members = SYNONYMS_BY_TOKEN.get(token);
    if (!members) continue;
    for (const member of members) push(member);
  }
  return out;
}
