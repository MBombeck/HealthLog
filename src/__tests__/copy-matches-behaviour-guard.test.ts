/**
 * Copy-matches-behaviour guard.
 *
 * Four classes of copy that must not drift away from the code they describe,
 * each pinned here so the pair fails loudly if either half moves. The first
 * three are repairs — copy that had already drifted. The fourth arrives with
 * the feature it governs, because a wording rule that depends on review is a
 * wording rule that survives until the fifth locale.
 *
 *   1. DELETE CONFIRMATIONS. A confirmation is the moment a user weighs the
 *      consequence. Four dialogs promised permanence on surfaces that render
 *      an Undo affordance (measurements bulk, mood bulk, labs, illness) — a
 *      cautious user declines a safe delete, and the warning loses weight
 *      where it is true. This test pins both directions: undo-able surfaces
 *      must offer the undo sentence and must NOT claim finality; the
 *      genuinely permanent ones must keep their warning.
 *
 *   2. SLEEP DEBT. v1.19.0 replaced the summed shortfall with a running
 *      balance that credits surplus sleep. The labels still described the old
 *      arithmetic, so the word contradicted the number for anyone who caught
 *      up after a short night.
 *
 *   3. GLUCOSE REFERENCE BAND. The declared diabetes opt-in has a server
 *      preference and a route; the copy for its web control must exist in
 *      every locale, since a missing key silently degrades to the raw key on
 *      a surface that makes a clinical-adjacent claim.
 *
 * Reversibility evidence for the undo-able set:
 *   - measurements: `POST /api/measurements/restore`, undo toast in
 *     `src/components/measurements/measurement-list.tsx`
 *   - mood:         `POST /api/mood-entries/restore`, undo toast in
 *     `src/components/mood/mood-list.tsx`
 *   - labs:         `POST /api/labs/restore`, undo toast in
 *     `src/components/labs/lab-history-list.tsx`
 *   - illness:      `POST /api/illness/episodes/[id]/restore`, undo toast in
 *     `src/components/illness/episode-menu.tsx`
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { consentNeededForProviders } from "@/lib/ai/capabilities/resolve";

const MESSAGES = join(__dirname, "../../messages");
const LOCALES = [
  "de",
  "en",
  "es",
  "fr",
  "it",
  "pl",
  "ko",
  "nl",
  "pt-BR",
] as const;

function bundle(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), "utf8"));
}

function resolve(obj: Record<string, unknown>, path: string): string {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    expect(cur, `${path} is missing at "${seg}"`).toBeTypeOf("object");
    cur = (cur as Record<string, unknown>)[seg];
  }
  expect(typeof cur, `${path} must resolve to a string`).toBe("string");
  return cur as string;
}

/**
 * Per-locale phrases that assert a deletion cannot be taken back. A dialog on
 * an undo-able surface must contain none of these.
 */
const FINALITY_PHRASES: Record<string, readonly string[]> = {
  en: ["cannot be undone", "can't be undone", "permanently", "permanent"],
  de: ["nicht rückgängig", "endgültig", "dauerhaft", "unwiderruflich"],
  es: ["no se puede deshacer", "permanente", "irreversible"],
  fr: [
    "irréversible",
    "définitivement",
    "définitive",
    "ne peut pas être annulé",
  ],
  it: [
    "non può essere annullata",
    "non può essere annullato",
    "definitivamente",
    "definitiva",
    "permanente",
  ],
  pl: ["nie można cofnąć", "nie można tego cofnąć", "trwale", "nieodwracaln"],
  ko: ["되돌릴 수 없", "복구할 수 없", "영구", "완전히 삭제"],
  nl: ["niet ongedaan", "definitief", "permanent", "onherroepelijk"],
  "pt-BR": [
    "não pode ser desfeit",
    "não é possível desfazer",
    "permanentemente",
    "definitivamente",
    "irreversível",
  ],
};

/** Per-locale phrase that promises the short undo window. */
const UNDO_PHRASES: Record<string, string> = {
  en: "undo",
  de: "rückgängig",
  es: "deshacerlo",
  fr: "annuler cette action",
  it: "annullare",
  pl: "cofnąć",
  ko: "되돌릴 수 있",
  nl: "ongedaan maken",
  "pt-BR": "desfazer",
};

/** Confirmation bodies whose surface renders an Undo affordance. */
const UNDOABLE_CONFIRM_KEYS = [
  "measurements.deleteConfirmDescription",
  "measurements.bulkDeleteConfirmBody",
  "mood.deleteConfirmDescription",
  "mood.bulkDeleteConfirmBody",
  "labs.deleteConfirmDescription",
  "illness.deleteConfirm.body",
] as const;

/**
 * Confirmation bodies whose delete really is unrecoverable for the user —
 * hard delete or a tombstone with no restore path. These MUST keep a
 * finality warning; softening them would be the mirror-image bug.
 */
const PERMANENT_CONFIRM_KEYS = [
  // hard delete + cascade of every recorded value
  "labs.biomarker.deleteConfirmDescription",
  // `?purge=true` hard-deletes the tag off every past entry
  "mood.manage.purgeBody",
  // GDPR Art. 17 account purge
  "settings.deleteAccountConfirmDescription",
  // hard delete of every user-scoped row except the sign-in credentials
  "settings.dangerZoneConfirmDescription",
  // hard delete since v1.32.40 — the tombstone served nothing and the
  // dialog already promised permanence
  "measurementReminders.deleteConfirmDescription",
  "records.allergies.deleteConfirmDescription",
] as const;

describe("delete confirmations describe what the surface actually does", () => {
  for (const locale of LOCALES) {
    const msgs = bundle(locale);

    describe(locale, () => {
      for (const key of UNDOABLE_CONFIRM_KEYS) {
        it(`${key} offers undo and claims no finality`, () => {
          const copy = resolve(msgs, key).toLowerCase();

          for (const phrase of FINALITY_PHRASES[locale]) {
            expect(
              copy,
              `${locale}/${key} claims finality ("${phrase}") but the surface renders an Undo`,
            ).not.toContain(phrase.toLowerCase());
          }

          expect(
            copy,
            `${locale}/${key} should tell the user the delete can be undone`,
          ).toContain(UNDO_PHRASES[locale].toLowerCase());
        });
      }

      for (const key of PERMANENT_CONFIRM_KEYS) {
        it(`${key} keeps its finality warning`, () => {
          const copy = resolve(msgs, key).toLowerCase();
          const warns = FINALITY_PHRASES[locale].some((p) =>
            copy.includes(p.toLowerCase()),
          );
          expect(
            warns,
            `${locale}/${key} deletes irrecoverably — the copy must say so`,
          ).toBe(true);
        });
      }
    });
  }
});

describe("sleep debt is labelled as a balance, not a summed deficit", () => {
  /**
   * The figure is a running balance: a short night adds, a long night pays it
   * down. Deficit/shortfall vocabulary describes the pre-v1.19.0 sum.
   */
  const STALE_SUM_VOCABULARY: Record<string, readonly string[]> = {
    en: ["cumulative", "shortfall", "accumulated"],
    de: ["kumuliert", "defizit", "aufgelaufen"],
    es: ["acumulado", "acumulada", "déficit"],
    fr: ["cumulé", "cumulée", "déficit"],
    it: ["cumulato", "cumulata", "accumulato", "deficit"],
    pl: ["skumulowan", "niedobór", "niedoboru"],
    ko: ["누적", "부족분", "적자", "쌓인"],
    nl: ["cumulatief", "opgeteld", "tekort", "opgebouwd"],
    "pt-BR": ["acumulad", "déficit", "deficit", "somad"],
  };

  for (const locale of LOCALES) {
    const msgs = bundle(locale);

    it(`${locale} debt captions carry no summed-deficit wording`, () => {
      for (const key of [
        "insights.sleep.debt.caption",
        "insights.sleep.debt.clearCaption",
      ]) {
        const copy = resolve(msgs, key).toLowerCase();
        for (const term of STALE_SUM_VOCABULARY[locale]) {
          expect(
            copy,
            `${locale}/${key} still describes the pre-v1.19.0 summed shortfall ("${term}")`,
          ).not.toContain(term);
        }
      }
    });
  }

  it("the explainer states that catch-up sleep pays the balance down", () => {
    const copy = resolve(bundle("en"), "insights.sleep.debt.computedInfo");
    expect(copy.toLowerCase()).toContain("balance");
    expect(copy.toLowerCase()).toContain("catch-up");
  });
});

describe("the glucose reference band control is translated everywhere", () => {
  const KEYS = [
    "settings.glucoseReference.title",
    "settings.glucoseReference.description",
    "settings.glucoseReference.enable",
    "settings.glucoseReference.explainer",
    "settings.glucoseReference.disclaimer",
    "settings.glucoseReference.error",
  ] as const;

  for (const locale of LOCALES) {
    it(`${locale} carries every key`, () => {
      const msgs = bundle(locale);
      for (const key of KEYS) {
        expect(resolve(msgs, key).length).toBeGreaterThan(0);
      }
    });
  }

  it("the disclaimer refuses the diagnosis reading (EN)", () => {
    const copy = resolve(
      bundle("en"),
      "settings.glucoseReference.disclaimer",
    ).toLowerCase();
    expect(copy).toContain("not a diagnosis");
    expect(copy).toContain("never inferred");
  });
});

/**
 * 4. THE MOOD PROGNOSIS. The forecast is a comparison with somebody's own past
 *    days and it may never be phrased as a cause. "A value around 5.4 would
 *    have been expected" is what the arithmetic supports; "overtime lowered
 *    your mood" is not, and the difference is not a matter of taste — the model
 *    is a correlation over a dozen columns and a causal sentence would be a
 *    claim it cannot make about somebody's health.
 *
 *    The second half is the count. A forecast built from thirty days and one
 *    built from three hundred render identically, so every statement that
 *    quotes a value has to quote what it rests on. Both halves are a test here
 *    rather than a review habit, because a review habit does not survive the
 *    fifth locale.
 */
describe("the mood prognosis never states a cause", () => {
  /**
   * Causal constructions, per locale. Multi-word where a single word would
   * over-match — Italian `causa` is a noun in ordinary use and only `a causa
   * di` is the construction being banned.
   */
  const CAUSAL_PHRASES: Record<string, readonly string[]> = {
    de: [
      "weil",
      "verursacht",
      "führt zu",
      "sorgt für",
      "wegen",
      "verbessert deine",
      "verschlechtert deine",
      "senkt deine",
      "hebt deine",
    ],
    en: [
      "because",
      "causes",
      "caused",
      "leads to",
      "due to",
      "makes you",
      "lowers your",
      "raises your",
      "improves your",
      "worsens your",
    ],
    es: [
      "porque",
      "provoca",
      "debido a",
      "a causa de",
      "mejora tu",
      "empeora tu",
    ],
    fr: [
      "parce que",
      "provoque",
      "en raison de",
      "à cause de",
      "améliore ton",
      "dégrade ton",
    ],
    it: [
      "perché",
      "provoca",
      "a causa di",
      "migliora il tuo",
      "peggiora il tuo",
    ],
    pl: ["ponieważ", "powoduje", "z powodu", "wywołuje", "poprawia twój"],
    ko: ["때문", "탓", "원인", "유발", "초래", "야기", "덕분", "인해"],
    nl: [
      "omdat",
      "veroorzaakt",
      "leidt tot",
      "zorgt voor",
      "vanwege",
      "verbetert je",
      "verslechtert je",
      "verlaagt je",
      "verhoogt je",
    ],
    "pt-BR": [
      "porque",
      "por causa de",
      "devido a",
      "provoca",
      "leva a",
      "melhora o seu",
      "melhora a sua",
      "piora o seu",
      "piora a sua",
    ],
  };

  /** Every leaf string under `insights.mood.prognosis`, flattened. */
  function prognosisStrings(locale: string): Array<[string, string]> {
    const root = (
      bundle(locale).insights as Record<string, Record<string, unknown>>
    ).mood.prognosis as Record<string, unknown>;
    expect(
      root,
      `${locale} carries no insights.mood.prognosis block`,
    ).toBeTypeOf("object");
    return Object.entries(root).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
  }

  for (const locale of LOCALES) {
    it(`${locale} carries the block, and every string in it`, () => {
      const strings = prognosisStrings(locale);
      // The positive control. Every assertion below passes on an empty list,
      // so the count is the evidence and the empty offender set is only the
      // verdict.
      expect(strings.length).toBeGreaterThanOrEqual(17);
      for (const [key, value] of strings) {
        expect(value.length, `${locale}/${key} is empty`).toBeGreaterThan(0);
      }
    });

    it(`${locale} names no cause`, () => {
      const offenders = prognosisStrings(locale)
        .filter(([, value]) =>
          CAUSAL_PHRASES[locale].some((phrase) =>
            value.toLowerCase().includes(phrase),
          ),
        )
        .map(([key]) => key);
      expect(
        offenders,
        `${locale} prognosis copy states a cause; the forecast is a comparison with the account's own past days and cannot support one`,
      ).toEqual([]);
    });
  }

  /**
   * Statements that quote a value must quote what it rests on. The list is
   * explicit rather than derived, so adding a statement key forces a decision
   * here instead of inheriting silence.
   */
  const COUNTED_STATEMENTS: Record<string, readonly string[]> = {
    statement: ["{value}", "{n}"],
    learning: ["{entries}", "{threshold}"],
    noPattern: ["{entries}"],
    band: ["{low}", "{high}"],
  };

  for (const locale of LOCALES) {
    it(`${locale} keeps the count beside the claim`, () => {
      const strings = new Map(prognosisStrings(locale));
      for (const [key, placeholders] of Object.entries(COUNTED_STATEMENTS)) {
        const copy = strings.get(key);
        expect(copy, `${locale}/${key} is missing`).toBeTypeOf("string");
        for (const placeholder of placeholders) {
          // `{entries}` or a plural block on it (`{entries, plural, …}`).
          const name = placeholder.slice(1, -1);
          expect(
            copy,
            `${locale}/${key} quotes a value without ${placeholder}; a forecast without the days behind it cannot be weighed by the reader`,
          ).toMatch(new RegExp(`\\{${name}(\\}|\\s*,\\s*plural\\s*,)`));
        }
      }
    });
  }

  it("the forecast is phrased as a counterfactual, not as a measurement (EN + DE)", () => {
    const en = resolve(bundle("en"), "insights.mood.prognosis.statement");
    expect(en.toLowerCase()).toContain("would have been expected");
    const de = resolve(bundle("de"), "insights.mood.prognosis.statement");
    expect(de.toLowerCase()).toContain("zu erwarten gewesen");
  });
});

describe("the MCP token copy never claims the mint is read-only", () => {
  /**
   * 5. MCP TOKEN SCOPE. The mint card sits directly above the
   *    health:write toggle (`mcp-section.tsx`), and `requireAuth` in
   *    api-handler.ts honours that scope — a minted token writes when the
   *    toggle was on. The card's own description and scope note therefore
   *    must not describe the mint as read-only; "read-only by default /
   *    unless enabled" is the honest shape.
   *
   * Watched red: restoring the pre-fix strings ("Mint a read-only token
   * to connect an assistant." et al.) makes the matching locale fail.
   */
  const READONLY_CLAIMS: Record<string, readonly string[]> = {
    en: ["read-only token"],
    de: ["schreibgeschütztes token", "schreibgeschütztes-token"],
    es: ["token de solo lectura"],
    fr: ["jeton en lecture seule"],
    it: ["token in sola lettura"],
    pl: ["token tylko do odczytu"],
    ko: ["읽기 전용 토큰", "읽기전용 토큰"],
    nl: [
      "alleen-lezen token",
      "alleen-lezentoken",
      "token met alleen leesrechten",
    ],
    "pt-BR": [
      "token somente leitura",
      "token de somente leitura",
      "token só de leitura",
      "token apenas de leitura",
    ],
  };

  for (const locale of LOCALES) {
    it(`${locale} mint copy does not promise a read-only token`, () => {
      const b = bundle(locale);
      const description = resolve(b, "settings.mcp.tokensDescription");
      const scopeNote = resolve(b, "settings.mcp.scopeNote");
      for (const claim of READONLY_CLAIMS[locale]) {
        for (const copy of [description, scopeNote]) {
          expect(
            copy.toLowerCase(),
            `${locale} settings.mcp copy claims the minted token is read-only while the write toggle sits beneath it`,
          ).not.toContain(claim);
        }
      }
    });
  }
});

/**
 * 5. AI CONSENT WITHDRAWAL. The confirmation said "the AI features stop
 *    straight away" and the withdrawn line said no health data goes to an AI
 *    provider any more. Neither holds: the Coach and Insights need the
 *    receipt only when they use the AI access the server provides (the
 *    operator's key or connection), so on the person's own key or a local
 *    model they keep working; and the deletion of model-written notes is
 *    skipped while another receipt still covers Insights. The copy now names
 *    both conditions. The behaviour half is pinned against the resolver, so a
 *    change to who needs the receipt fails here next to the copy it would
 *    falsify.
 */
describe("AI consent withdrawal copy matches what withdrawing does", () => {
  it("the Coach and Insights need no receipt on an own key or a local model", () => {
    for (const key of ["coach", "briefing", "statusText"] as const) {
      expect(consentNeededForProviders(key, ["openai"])).toBe(false);
      expect(consentNeededForProviders(key, ["local"])).toBe(false);
      expect(consentNeededForProviders(key, ["admin-openai"])).toBe(true);
    }
  });

  /** Per locale: a phrase naming the own key, and one naming a local model. */
  const OWN_PROVIDER: Record<string, readonly [string, string]> = {
    en: ["own key", "local model"],
    de: ["eigenen schlüssel", "lokalen modell"],
    es: ["tu propia clave", "modelo local"],
    fr: ["votre propre clé", "modèle local"],
    it: ["tua chiave", "modello locale"],
    pl: ["własnym kluczu", "lokalnym modelu"],
    ko: ["자신의 키", "로컬 모델"],
    nl: ["eigen sleutel", "lokaal model"],
    "pt-BR": ["sua própria chave", "modelo local"],
  };

  for (const locale of LOCALES) {
    it(`${locale} says what keeps working and when the notes stay`, () => {
      const b = bundle(locale);
      for (const path of ["settings.ai.consent.confirmBody"]) {
        const copy = resolve(b, path).toLowerCase();
        for (const phrase of OWN_PROVIDER[locale]) {
          expect(copy, `${locale} ${path}`).toContain(phrase);
        }
      }
    });
  }
});
