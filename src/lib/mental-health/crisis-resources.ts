/**
 * v1.25 — locale-aware crisis-resource signposting for the PHQ-9 item-9 safety
 * path. This is SUPPORT, not interpretation: when item 9 is answered with any
 * non-zero value the UI shows a calm, non-alarmist card pointing to real help.
 *
 * The list is maintained config (not hardcoded in a component) so a self-hoster
 * can localise it. Names resolve via the `mentalHealth.crisisResource.<id>.name`
 * i18n key; the contact lines (phone numbers / URLs) are literal data, never
 * translated. The emergency number is region-specific and always shown first.
 *
 * HARD RULE: showing these resources NEVER triggers any third-party alert,
 * never notifies a contact, never emails. It is private, on-device-only
 * signposting on a self-host.
 */

export interface CrisisResource {
  /** Stable id; the `mentalHealth.crisisResource.<id>.name` i18n key resolves the label. */
  id: string;
  /** Contact lines (phone / SMS / chat URL) — literal, not translated. */
  contacts: readonly string[];
}

export interface CrisisResourceSet {
  /** Region's universal emergency number, shown first ("if in immediate danger…"). */
  emergencyNumber: string;
  resources: readonly CrisisResource[];
}

/** International fallback set (used when a region has no dedicated entry). */
const INTERNATIONAL: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    { id: "findahelpline", contacts: ["findahelpline.com"] },
    { id: "euEmotionalSupport", contacts: ["116 123"] },
  ],
};

/** Germany (de) — TelefonSeelsorge + youth lines + acute emergency. */
const DE: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    {
      id: "telefonSeelsorge",
      contacts: ["0800 111 0 111", "0800 111 0 222", "telefonseelsorge.de"],
    },
    { id: "nummerGegenKummer", contacts: ["116 111"] },
    { id: "krisenchat", contacts: ["krisenchat.de"] },
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/** Austria (at) — Telefonseelsorge Österreich + acute emergency. */
const AT: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    { id: "telefonSeelsorgeAt", contacts: ["142", "telefonseelsorge.at"] },
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/** Switzerland (ch) — Die Dargebotene Hand + acute emergency. */
const CH: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    { id: "dargeboteneHand", contacts: ["143", "143.ch"] },
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/**
 * Combined DE/AT/CH set — used when the locale is the bare "de" code with no
 * region hint. `User.locale` in this app is a short code ("de"/"en"/…), so a
 * de-AT or de-CH self-hoster is otherwise indistinguishable from a de-DE one.
 * Serving the Germany-only freephone numbers to them left a Swiss or
 * Austrian user in crisis staring at numbers that don't connect from their
 * country. Leads with 112 (works across all three), then every country's
 * own line grouped together so nothing here is presented as DE-only.
 */
const DE_AT_CH: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    // Country-specific lines first, each set's own `findahelpline` entry
    // dropped so the worldwide directory appears exactly once, at the end.
    ...DE.resources.filter((r) => r.id !== "findahelpline"),
    ...AT.resources.filter((r) => r.id !== "findahelpline"),
    ...CH.resources.filter((r) => r.id !== "findahelpline"),
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/** United States (en-US region hint) — 988 + Crisis Text Line. */
const US: CrisisResourceSet = {
  emergencyNumber: "911",
  resources: [
    { id: "lifeline988", contacts: ["988"] },
    { id: "crisisTextLine", contacts: ["Text HOME to 741741"] },
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/**
 * Brazil, reached only by the bare region code "br". "pt-BR" and "pt_BR"
 * are not a region signal: the web folds every Portuguese reader into that
 * one bundle, so they get PT_BR_AMBIGUOUS. CVV by phone and chat, SAMU as
 * the emergency number. Both numbers are free and answer around the clock
 * (cvv.org.br; the Ministry of Health's SAMU 192 page).
 */
const BR: CrisisResourceSet = {
  emergencyNumber: "192",
  resources: [
    { id: "cvv", contacts: ["188", "cvv.org.br/chat"] },
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/**
 * Portugal (explicit "pt-PT" / "pt_PT" / "pt-pt"). 112 is the emergency
 * number. SNS 24 (808 24 24 24) runs the national psychological counselling
 * line around the clock as menu option 4 and transfers a call at risk to
 * INEM; SOS Voz Amiga answers daily from 15:30 to 00:30 (sosvozamiga.org).
 */
const PT: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    { id: "sns24", contacts: ["808 24 24 24"] },
    { id: "sosVozAmiga", contacts: ["213 544 545", "sosvozamiga.org"] },
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/**
 * Portuguese with no region signal. The app ships one Portuguese bundle,
 * `pt-BR`, and `localeFromLanguageTag` folds `pt-PT`, `pt-AO` and bare `pt`
 * into it, so a stored "pt-BR" says only that the reader reads Portuguese:
 * it is as likely to be someone in Lisbon as in São Paulo. The account keeps
 * no country to tell them apart. Following DE_AT_CH, the set leads with 112
 * (the emergency number across Portugal and the EU, which mobile networks in
 * Brazil also route to the police) and the worldwide directory, then names
 * every country's own lines with the country in the label, so nothing reads
 * as if it reached everyone.
 */
const PT_BR_AMBIGUOUS: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    { id: "findahelpline", contacts: ["findahelpline.com"] },
    ...BR.resources.filter((r) => r.id !== "findahelpline"),
    { id: "samu", contacts: ["192"] },
    ...PT.resources.filter((r) => r.id !== "findahelpline"),
  ],
};

/**
 * The Netherlands (explicit "nl-NL" / "nl_NL"). 112 is the emergency number.
 * 113 Zelfmoordpreventie answers by phone on 113 or the free 0800-0113 and by
 * chat on 113.nl, anonymously.
 */
const NL: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    {
      id: "zelfmoordpreventie113",
      contacts: ["113", "0800-0113", "113.nl"],
    },
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/**
 * Belgium (explicit "nl-BE" / "nl_BE", or the bare region "be"). 112 is the
 * emergency number. The Zelfmoordlijn answers 1813 around the clock and runs
 * a chat in the evenings (zelfmoord1813.be).
 */
const BE: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    { id: "zelfmoordlijn1813", contacts: ["1813", "zelfmoord1813.be"] },
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/**
 * Dutch with no region signal. The app ships one Dutch bundle, `nl`, read in
 * the Netherlands and in Flanders alike, and the account keeps no country to
 * tell them apart. Following DE_AT_CH, the set leads with 112 (the emergency
 * number in both countries) and names each country's line with the country
 * in its label, so nothing reads as if it reached everyone.
 */
const NL_BE: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    ...NL.resources.filter((r) => r.id !== "findahelpline"),
    ...BE.resources.filter((r) => r.id !== "findahelpline"),
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/**
 * Resolve a crisis-resource set from the user's locale. Region detection is
 * coarse (locale prefix) and defaults to the international set — the goal is to
 * always surface SOMETHING actionable, never to be exhaustive.
 *
 * A region-qualified tag ("de-AT", "de_CH", "pt-PT", …) resolves to the exact
 * country set when the caller has one to give us. The web stores the app
 * locale, which is a bare "de", "nl" or the folded "pt-BR", so it lands on the
 * combined sets: never assume Germany, the Netherlands or Brazil when the
 * region is unknown.
 */
export function crisisResourcesForLocale(
  locale: string | null | undefined,
): CrisisResourceSet {
  const lc = (locale ?? "").toLowerCase().replace("_", "-");
  if (lc === "de-at" || lc === "at") return AT;
  if (lc === "de-ch" || lc === "ch") return CH;
  if (lc.startsWith("de")) return DE_AT_CH;
  if (lc.startsWith("en-us") || lc === "us") return US;
  if (lc === "br") return BR;
  if (lc === "pt-pt") return PT;
  // "pt-BR" from the web is the folded app locale, not a region signal; see
  // PT_BR_AMBIGUOUS. Any other Portuguese tag (pt, pt-AO, pt-MZ) lands here
  // too, and still gets 112 and the worldwide directory first.
  if (lc === "pt" || lc.startsWith("pt-")) return PT_BR_AMBIGUOUS;
  if (lc === "nl-nl") return NL;
  if (lc === "nl-be" || lc === "be") return BE;
  // The bare "nl" the web stores, and any other Dutch tag: both countries.
  if (lc === "nl" || lc.startsWith("nl-")) return NL_BE;
  return INTERNATIONAL;
}
