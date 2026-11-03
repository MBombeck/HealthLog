import type { Locale } from "@/lib/i18n/config";
import { formatDecimal } from "@/lib/format-locale";
import type { MetricSignal } from "@/lib/insights/metric-signal";

/**
 * v1.4.25 v1.31.0 — these no-key fallbacks now carry a written body for
 * every shipped locale (de/en/fr/es/it/pl). They used to ship DE + EN only and
 * route the other four through the English body, which meant a French, Spanish,
 * Italian or Polish self-hoster read English on nine metric surfaces whenever
 * no provider was reachable. `pick` selects the reader's own body; English
 * stays as the structural floor for a locale that is ever genuinely missing
 * one, not as the shipped answer for four of six.
 *
 * The bodies are written per language rather than translated token-for-token.
 * Where a sentence cannot carry the English shape — a comparative adjective
 * that would have to agree with the metric noun's gender, a locative "is at"
 * with no natural equivalent — that language's sentence is restructured. The
 * per-language notes sit at the templates themselves.
 *
 * v1.21.0 (coach C1 HIGH-1/2) — these surfaces used to emit static
 * clinical tips with ZERO reference to the user's own numbers, and the
 * timeout path rendered them as if they were a fresh AI assessment.
 * Each `getNoKey*StatusText` now accepts the per-metric `MetricSignal`
 * the card already built and, when present, composes a SIGNAL-GROUNDED
 * deterministic line: it names the user's current value, places it
 * against their own baseline, and ends with ONE plain-language pointer
 * — the same warm voice the LLM surfaces use, without an LLM call. The
 * generic best-practice tip stays only as the honest no-signal floor
 * (no fabricated numbers when a metric has no usable history).
 */
export type InsightLocale = Locale;

/**
 * A per-locale table with English required.
 *
 * English is required so the fallback arm can never itself be undefined; every
 * other locale is optional so a genuinely missing body degrades to English
 * rather than to `undefined`. Every table in this file fills all six.
 */
type Localized<T> = { en: T } & Partial<Record<InsightLocale, T>>;

function pick<T>(locale: InsightLocale, table: Localized<T>): T {
  return table[locale] ?? table.en;
}

function getLocalizedText(
  locale: InsightLocale,
  text: Localized<string>,
): string {
  return pick(locale, text);
}

// ── signal-grounded composer ────────────────────────────────────────────────

/** A natural-language metric label + the pointer phrasing for one metric. */
interface FallbackCopy {
  /** Possessive natural-language label ("your blood pressure"). */
  label: Localized<string>;
  /** Unit suffix appended to a value (" bpm"), empty when none. */
  unit?: string;
  /** Digits to round the rendered value to (0 for integers). */
  digits?: number;
  /**
   * One grounded pointer used when the value sits outside the user's own
   * usual swing — framed as an opportunity, never an order.
   */
  pointer: Localized<string>;
}

function fmtValue(
  value: number,
  copy: FallbackCopy,
  locale: InsightLocale,
): string {
  const digits = copy.digits ?? 0;
  // Round to the metric's precision, but never render a trailing zero — an
  // integer reading (steps, a whole-number BMI day) reads as "4200", not
  // "4200.0" — and print the decimal in the reader's notation ("72,5").
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  const text = formatDecimal(rounded, locale, digits);
  return copy.unit ? `${text}${copy.unit}` : text;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * v1.28.40 — the verdict-first opener for the deterministic floor. A tiny
 * CLOSED vocabulary keyed by (direction, outsideNormalSwing) so the line leads
 * with MEANING before the number, matching the warm AI voice above it. It
 * introduces no new figure and no new claim — the numbers still come from the
 * value sentence right after — so grounding is untouched. Returns null when the
 * signal is too thin to state a confident read (no baseline / no delta), in
 * which case the line simply opens on the value as before.
 */
const VERDICT_STEADY: Localized<string> = {
  de: "Stabil und wie gewohnt",
  en: "Steady and much as usual",
  fr: "Stable, comme d’habitude",
  es: "Estable, como de costumbre",
  it: "Stabile, come al solito",
  pl: "Stabilnie, tak jak zwykle",
  nl: "Stabiel en zoals gewoonlijk",
  ru: "Стабильно, как обычно",
  "pt-BR": "Estável e como de costume",
};

const VERDICT_FAVOURABLE: Localized<string> = {
  de: "Das geht in eine gute Richtung",
  en: "This is moving in a good direction",
  fr: "Cela évolue dans le bon sens",
  es: "Esto va en buena dirección",
  it: "Sta andando nella direzione giusta",
  pl: "To zmierza w dobrym kierunku",
  nl: "Dit gaat de goede kant op",
  ru: "Это движется в хорошую сторону",
  "pt-BR": "Isso está indo numa boa direção",
};

const VERDICT_OFF_USUAL: Localized<string> = {
  de: "Zuletzt etwas außerhalb deines üblichen Rahmens",
  en: "A little off your usual lately",
  fr: "Un peu en dehors de tes repères habituels ces derniers temps",
  es: "Últimamente algo fuera de tu rango habitual",
  it: "Ultimamente un po’ fuori dal tuo intervallo abituale",
  pl: "Ostatnio nieco poza twoim zwykłym zakresem",
  nl: "De laatste tijd iets buiten je gebruikelijke bereik",
  ru: "В последнее время немного выходит за ваши обычные рамки",
  "pt-BR": "Ultimamente um pouco fora do seu padrão habitual",
};

function verdictLead(
  signal: MetricSignal,
  locale: InsightLocale,
): string | null {
  // Inside the user's own usual swing → a steady, reassuring verdict.
  if (signal.outsideNormalSwing === false) {
    return pick(locale, VERDICT_STEADY);
  }
  // Outside the usual swing → is the move in a favourable or unfavourable
  // direction? For a target-band metric the direction alone can't say, so it
  // stays a neutral "worth a look" verdict.
  if (
    signal.outsideNormalSwing === true &&
    signal.delta !== null &&
    signal.delta !== 0
  ) {
    const favourable =
      signal.direction === "higher-better"
        ? signal.delta > 0
        : signal.direction === "lower-better"
          ? signal.delta < 0
          : null;
    if (favourable === true) {
      return pick(locale, VERDICT_FAVOURABLE);
    }
    return pick(locale, VERDICT_OFF_USUAL);
  }
  // No baseline / no usable delta → no confident verdict; open on the value.
  return null;
}

/**
 * The value sentence, placed against the user's own baseline.
 *
 * Three shapes, one per grounding level. Each is a per-locale template rather
 * than one template with swapped words, because the languages do not share a
 * sentence shape here:
 *
 * · de/en keep the locative "liegt bei" / "is at" plus a comparative adjective.
 * · fr/es/it drop the comparative ("plus haut", "más alto", "più alto") for a
 *   PREPOSITION — "au-dessus de", "por encima de", "sopra". The comparative
 *   would have to agree in gender with the metric noun, which differs across
 *   the labels (ta tension / ton poids, tu presión / tu peso, la tua pressione
 *   / il tuo peso), so a single template carrying an adjective cannot be
 *   correct for all of them. The preposition governs the noun without agreeing
 *   with it, which makes one template safe for every metric.
 * · pl restructures further: there is no natural locative "is at" for a
 *   measurement, so the sentence takes the verb `wynosi` ("amounts to"), which
 *   is invariant for the subject's gender — Polish adjectives and past-tense
 *   verbs are not, and the labels span all three genders (twój nastrój m.,
 *   twoja waga f., twoje tętno n.). The comparison likewise uses the
 *   prepositions `powyżej` / `poniżej` with the genitive rather than a
 *   comparative adjective.
 */
const VALUE_VS_BASELINE: Localized<
  (label: string, current: string, baseline: string, higher: boolean) => string
> = {
  de: (l, c, b, higher) =>
    `${l} liegt aktuell bei ${c} — ${higher ? "höher" : "niedriger"} als dein üblicher Schnitt von ${b}.`,
  en: (l, c, b, higher) =>
    `${l} is at ${c} right now — ${higher ? "higher" : "lower"} than your usual average of ${b}.`,
  fr: (l, c, b, higher) =>
    `${l} est à ${c} en ce moment — ${higher ? "au-dessus" : "en dessous"} de ta moyenne habituelle de ${b}.`,
  es: (l, c, b, higher) =>
    `${l} está en ${c} ahora mismo — ${higher ? "por encima" : "por debajo"} de tu promedio habitual de ${b}.`,
  it: (l, c, b, higher) =>
    `${l} è a ${c} in questo momento — ${higher ? "sopra" : "sotto"} la tua media abituale di ${b}.`,
  pl: (l, c, b, higher) =>
    `${l} wynosi obecnie ${c} — ${higher ? "powyżej" : "poniżej"} twojej zwykłej średniej ${b}.`,
  nl: (l, c, b, higher) =>
    `${l} staat nu op ${c}, ${higher ? "hoger" : "lager"} dan je gebruikelijke gemiddelde van ${b}.`,
  ru: (l, c, b, higher) =>
    `${l} сейчас ${c} — ${higher ? "выше" : "ниже"} вашей обычной средней ${b}.`,
  "pt-BR": (l, c, b, higher) =>
    `${l} está em ${c} agora, ${higher ? "acima" : "abaixo"} da sua média habitual de ${b}.`,
};

const VALUE_AT_BASELINE: Localized<(label: string, current: string) => string> =
  {
    de: (l, c) =>
      `${l} liegt aktuell bei ${c}, im Bereich deines üblichen Schnitts.`,
    en: (l, c) => `${l} is at ${c}, right around your usual average.`,
    fr: (l, c) => `${l} est à ${c}, tout près de ta moyenne habituelle.`,
    es: (l, c) => `${l} está en ${c}, justo en torno a tu promedio habitual.`,
    it: (l, c) => `${l} è a ${c}, più o meno sulla tua media abituale.`,
    pl: (l, c) =>
      `${l} wynosi obecnie ${c}, czyli mniej więcej tyle co twoja zwykła średnia.`,
    nl: (l, c) =>
      `${l} staat op ${c}, ongeveer op je gebruikelijke gemiddelde.`,
    ru: (l, c) => `${l} сейчас ${c}, примерно на уровне вашей обычной средней.`,
    "pt-BR": (l, c) => `${l} está em ${c}, bem perto da sua média habitual.`,
  };

const VALUE_ALONE: Localized<(label: string, current: string) => string> = {
  de: (l, c) => `${l} liegt aktuell bei ${c}.`,
  en: (l, c) => `${l} is at ${c} right now.`,
  fr: (l, c) => `${l} est à ${c} en ce moment.`,
  es: (l, c) => `${l} está en ${c} ahora mismo.`,
  it: (l, c) => `${l} è a ${c} in questo momento.`,
  pl: (l, c) => `${l} wynosi obecnie ${c}.`,
  nl: (l, c) => `${l} staat nu op ${c}.`,
  ru: (l, c) => `${l} сейчас ${c}.`,
  "pt-BR": (l, c) => `${l} está em ${c} agora.`,
};

const CLOSER_IN_RANGE: Localized<string> = {
  de: "Das ist in deinem gewohnten Rahmen — nichts, worauf du jetzt reagieren musst.",
  en: "That sits in your usual range — nothing you need to act on right now.",
  fr: "C’est dans tes repères habituels — rien qui appelle une réaction maintenant.",
  es: "Eso queda dentro de tu rango habitual — nada que pida una reacción ahora.",
  it: "Rientra nel tuo intervallo abituale — niente su cui intervenire adesso.",
  pl: "Mieści się to w twoim zwykłym zakresie — nic, na co trzeba teraz reagować.",
  nl: "Dat valt binnen je gebruikelijke bereik, dus niets waar je nu iets mee hoeft te doen.",
  ru: "Это в ваших обычных пределах — сейчас ничего предпринимать не нужно.",
  "pt-BR":
    "Isso está dentro da sua faixa habitual, nada que peça uma ação agora.",
};

const CLOSER_UNKNOWN_SWING: Localized<string> = {
  de: "Ein paar Messungen mehr machen die Tendenz belastbar — beobachte sie über die nächsten Tage.",
  en: "A few more readings will make the trend dependable — keep an eye on it over the coming days.",
  fr: "Quelques mesures de plus rendront la tendance fiable — garde un œil dessus les prochains jours.",
  es: "Unas pocas mediciones más harán fiable la tendencia — obsérvala durante los próximos días.",
  it: "Qualche misurazione in più renderà la tendenza affidabile — tienila d’occhio nei prossimi giorni.",
  pl: "Kilka kolejnych pomiarów sprawi, że tendencja stanie się wiarygodna — obserwuj ją przez najbliższe dni.",
  nl: "Met nog een paar metingen wordt de trend betrouwbaar. Houd hem de komende dagen in de gaten.",
  ru: "Ещё несколько измерений сделают тенденцию надёжной — последите за ней в ближайшие дни.",
  "pt-BR":
    "Mais algumas medições vão tornar a tendência confiável. Acompanhe nos próximos dias.",
};

/**
 * Compose a warm, grounded deterministic line from a metric signal. Leads with
 * a plain-words verdict (meaning first), then names the current value placed
 * against the user's own baseline, and ends with one pointer (when the value is
 * outside their usual swing) or an honest "nothing to act on" (when it sits in
 * range). Returns null when the signal carries no current value — the caller
 * then uses the generic tip.
 */
function composeGroundedFallback(
  signal: MetricSignal | null | undefined,
  copy: FallbackCopy,
  locale: InsightLocale,
): string | null {
  if (!signal || !Number.isFinite(signal.current)) return null;

  const label = capitalise(pick(locale, copy.label));
  const current = fmtValue(signal.current, copy, locale);

  const sentences: string[] = [];

  // 0) Verdict-first: lead with what it MEANS in plain words before the number,
  // so the floor reads like the warm AI voice and never opens on a bare value.
  const lead = verdictLead(signal, locale);
  if (lead) sentences.push(`${lead}.`);

  // 1) Then the current value, placed against the user's own baseline.
  if (
    signal.baseline !== null &&
    signal.delta !== null &&
    signal.delta !== 0 &&
    Number.isFinite(signal.baseline)
  ) {
    const baseline = fmtValue(signal.baseline, copy, locale);
    sentences.push(
      pick(locale, VALUE_VS_BASELINE)(
        label,
        current,
        baseline,
        signal.delta > 0,
      ),
    );
  } else if (signal.baseline !== null && Number.isFinite(signal.baseline)) {
    sentences.push(pick(locale, VALUE_AT_BASELINE)(label, current));
  } else {
    // No baseline yet — name the value honestly without inventing a comparison.
    sentences.push(pick(locale, VALUE_ALONE)(label, current));
  }

  // 2) One grounded pointer when outside the usual swing; otherwise affirm.
  if (signal.outsideNormalSwing === true) {
    sentences.push(pick(locale, copy.pointer));
  } else if (signal.outsideNormalSwing === false) {
    sentences.push(pick(locale, CLOSER_IN_RANGE));
  } else {
    // Unknown swing (no baseline): keep one steady, non-alarming pointer.
    sentences.push(pick(locale, CLOSER_UNKNOWN_SWING));
  }

  return sentences.join(" ");
}

// ── per-metric copy ─────────────────────────────────────────────────────────

const BLOOD_PRESSURE_COPY: FallbackCopy = {
  label: {
    de: "dein Blutdruck",
    en: "your blood pressure",
    fr: "ta tension artérielle",
    es: "tu presión arterial",
    it: "la tua pressione sanguigna",
    pl: "twoje ciśnienie krwi",
    nl: "je bloeddruk",
    ru: "ваше давление",
    "pt-BR": "sua pressão arterial",
  },
  unit: "",
  digits: 0,
  pointer: {
    de: "Ein paar ruhige Messungen unter gleichen Bedingungen zeigen, ob das die Tendenz ist oder ein Ausreißer.",
    en: "A few calm readings under the same conditions will show whether this is the trend or a single outlier.",
    fr: "Quelques mesures au calme dans les mêmes conditions montreront si c’est la tendance ou une valeur isolée.",
    es: "Unas cuantas mediciones en calma y en las mismas condiciones mostrarán si es la tendencia o un valor aislado.",
    it: "Qualche misurazione a riposo nelle stesse condizioni mostrerà se è la tendenza o un valore isolato.",
    pl: "Kilka spokojnych pomiarów w tych samych warunkach pokaże, czy to tendencja, czy pojedynczy wyskok.",
    nl: "Een paar rustige metingen onder dezelfde omstandigheden laten zien of dit de trend is of een losse uitschieter.",
    ru: "Несколько спокойных измерений в одинаковых условиях покажут, это тенденция или разовый выброс.",
    "pt-BR":
      "Algumas medições tranquilas nas mesmas condições vão mostrar se isso é a tendência ou um valor isolado.",
  },
};

const WEIGHT_COPY: FallbackCopy = {
  label: {
    de: "dein Gewicht",
    en: "your weight",
    fr: "ton poids",
    es: "tu peso",
    it: "il tuo peso",
    pl: "twoja waga",
    nl: "je gewicht",
    ru: "ваш вес",
    "pt-BR": "seu peso",
  },
  unit: "",
  digits: 1,
  pointer: {
    de: "Wäge dich ein paar Tage zur gleichen Zeit, dann ordnet sich die normale Schwankung von selbst ein.",
    en: "Weigh in at the same time for a few days and the normal day-to-day swing sorts itself out.",
    fr: "Pèse-toi à la même heure pendant quelques jours et la fluctuation quotidienne normale se lisse d’elle-même.",
    es: "Pésate a la misma hora durante unos días y la fluctuación diaria normal se compensa sola.",
    it: "Pesati alla stessa ora per qualche giorno e la normale oscillazione quotidiana si compensa da sé.",
    pl: "Waż się przez kilka dni o tej samej porze, a normalne dobowe wahania same się wyrównają.",
    nl: "Weeg je een paar dagen op hetzelfde tijdstip, dan middelt de normale schommeling van dag tot dag zich vanzelf uit.",
    ru: "Взвешивайтесь несколько дней в одно и то же время — обычные суточные колебания сгладятся сами.",
    "pt-BR":
      "Pese-se no mesmo horário por alguns dias, e a oscilação normal do dia a dia se acerta sozinha.",
  },
};

const PULSE_COPY: FallbackCopy = {
  label: {
    de: "dein Ruhepuls",
    en: "your resting pulse",
    fr: "ton pouls au repos",
    es: "tu pulso en reposo",
    it: "il tuo battito a riposo",
    pl: "twoje tętno spoczynkowe",
    nl: "je rusthartslag",
    ru: "ваш пульс в покое",
    "pt-BR": "seu pulso em repouso",
  },
  unit: " bpm",
  digits: 0,
  pointer: {
    de: "Miss ihn entspannt und zur gleichen Tageszeit, dann siehst du, ob die Richtung anhält.",
    en: "Take it relaxed and at the same time of day to see whether the direction holds.",
    fr: "Prends-le détendu et à la même heure de la journée pour voir si la direction se maintient.",
    es: "Tómatelo relajado y a la misma hora del día para ver si la dirección se mantiene.",
    it: "Misuralo da rilassato e alla stessa ora del giorno per vedere se la direzione tiene.",
    pl: "Mierz je na spokojnie i o tej samej porze dnia, żeby zobaczyć, czy kierunek się utrzyma.",
    nl: "Meet hem ontspannen en op hetzelfde moment van de dag, dan zie je of de richting aanhoudt.",
    ru: "Измеряйте его спокойно и в одно и то же время дня, чтобы понять, держится ли направление.",
    "pt-BR":
      "Meça com calma e no mesmo horário do dia para ver se a direção se mantém.",
  },
};

const BMI_COPY: FallbackCopy = {
  label: {
    de: "dein BMI",
    en: "your BMI",
    fr: "ton IMC",
    es: "tu IMC",
    it: "il tuo IMC",
    pl: "twoje BMI",
    nl: "je BMI",
    ru: "ваш ИМТ",
    "pt-BR": "seu IMC",
  },
  unit: "",
  digits: 1,
  pointer: {
    de: "Schau ihn dir zusammen mit Gewichtstrend und Körperfett über ein paar Wochen an.",
    en: "Read it alongside your weight trend and body-fat over a few weeks rather than day by day.",
    fr: "Lis-le avec la tendance de ton poids et ta masse grasse sur quelques semaines plutôt qu’au jour le jour.",
    es: "Léelo junto con la tendencia de tu peso y tu grasa corporal a lo largo de unas semanas, no día a día.",
    it: "Leggilo insieme all’andamento del tuo peso e alla massa grassa nell’arco di qualche settimana, non giorno per giorno.",
    pl: "Czytaj je razem z tendencją wagi i poziomem tkanki tłuszczowej w skali kilku tygodni, a nie dzień po dniu.",
    nl: "Bekijk hem samen met je gewichtstrend en vetpercentage over een paar weken, niet dag voor dag.",
    ru: "Смотрите на него вместе с динамикой веса и процентом жира за несколько недель, а не день ко дню.",
    "pt-BR":
      "Leia junto com a tendência do seu peso e o percentual de gordura ao longo de algumas semanas, não dia a dia.",
  },
};

const MOOD_COPY: FallbackCopy = {
  label: {
    de: "deine Stimmung",
    en: "your mood",
    fr: "ton humeur",
    es: "tu estado de ánimo",
    it: "il tuo umore",
    pl: "twój nastrój",
    nl: "je stemming",
    ru: "ваше настроение",
    "pt-BR": "seu humor",
  },
  unit: "",
  digits: 1,
  pointer: {
    de: "Halte sie ein paar Tage fest — wiederkehrende Muster sagen mehr als ein einzelner Tag.",
    en: "Log it for a few days — a recurring pattern says more than any single day.",
    fr: "Note-la pendant quelques jours — un motif qui revient en dit plus qu’une journée isolée.",
    es: "Regístralo unos días — un patrón que se repite dice más que un día suelto.",
    it: "Registralo per qualche giorno — uno schema che si ripete dice più di un singolo giorno.",
    pl: "Zapisuj go przez kilka dni — powtarzający się wzorzec mówi więcej niż pojedynczy dzień.",
    nl: "Houd hem een paar dagen bij. Een terugkerend patroon zegt meer dan één losse dag.",
    ru: "Записывайте его несколько дней — повторяющаяся картина говорит больше, чем один отдельный день.",
    "pt-BR":
      "Registre por alguns dias. Um padrão que se repete diz mais do que um dia isolado.",
  },
};

const ADHERENCE_COPY: FallbackCopy = {
  label: {
    de: "deine Einnahmetreue",
    en: "your medication adherence",
    fr: "ton observance du traitement",
    es: "tu adherencia a la medicación",
    it: "la tua aderenza alla terapia",
    pl: "twoja regularność przyjmowania leków",
    nl: "je medicijntrouw",
    ru: "ваша приверженность лечению",
    "pt-BR": "sua adesão à medicação",
  },
  unit: "%",
  digits: 0,
  pointer: {
    de: "Eine feste Zeit oder ein kurzer Reminder fängt die wiederkehrenden Auslassungen am ehesten ab.",
    en: "A fixed time or a quick reminder is the most reliable way to catch the repeat misses.",
    fr: "Une heure fixe ou un rappel court est ce qui rattrape le mieux les oublis répétés.",
    es: "Una hora fija o un recordatorio breve es lo que mejor recupera los olvidos repetidos.",
    it: "Un orario fisso o un promemoria breve è ciò che intercetta meglio le dimenticanze ripetute.",
    pl: "Stała pora albo krótkie przypomnienie najlepiej wyłapuje powtarzające się pominięcia.",
    nl: "Een vast tijdstip of een korte herinnering vangt herhaalde vergeten innames het best op.",
    ru: "Фиксированное время или короткое напоминание лучше всего ловят повторяющиеся пропуски.",
    "pt-BR":
      "Um horário fixo ou um lembrete rápido é a forma mais confiável de evitar as tomadas esquecidas que se repetem.",
  },
};

/** The generic pointer for the dynamic per-metric card, which has no copy table. */
const GENERIC_METRIC_POINTER: Localized<string> = {
  de: "Ein paar konsistente Messungen zeigen, ob das die Richtung ist oder ein einzelner Tag.",
  en: "A few consistent readings will show whether this is the direction or a single day.",
  fr: "Quelques mesures régulières montreront si c’est la direction prise ou une seule journée.",
  es: "Unas cuantas mediciones constantes mostrarán si es la dirección o un solo día.",
  it: "Qualche misurazione costante mostrerà se è la direzione o un singolo giorno.",
  pl: "Kilka konsekwentnych pomiarów pokaże, czy to kierunek, czy pojedynczy dzień.",
  nl: "Een paar consistente metingen laten zien of dit de richting is of één enkele dag.",
  ru: "Несколько последовательных измерений покажут, это направление или один отдельный день.",
  "pt-BR":
    "Algumas medições consistentes vão mostrar se essa é a direção ou só um dia isolado.",
};

// ── public fallbacks ────────────────────────────────────────────────────────

/**
 * Generic single-metric fallback for the dynamic per-metric card
 * (`metric-status.ts`), which carries a fully-formed signal but no
 * per-metric copy table. Grounds against the signal's OWN natural-language
 * label + unit; on a missing signal it degrades to the general tip.
 */
export function getNoKeyMetricStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
  /**
   * Decimals the signal's unit is read at (0 for mg/dL, 1 for mmol/L or
   * pounds). Defaults to one, which was the only precision before the
   * signal could arrive in the reader's unit.
   */
  digits = 1,
): string {
  const grounded =
    signal && Number.isFinite(signal.current)
      ? composeGroundedFallback(
          signal,
          {
            // The signal's own label is already natural language and is not
            // localised upstream, so it stands for every locale.
            label: { en: signal.metric },
            ...(signal.unit ? { unit: ` ${signal.unit}` } : {}),
            digits,
            pointer: GENERIC_METRIC_POINTER,
          },
          locale,
        )
      : null;
  return grounded ?? getNoKeyGeneralStatusText(locale);
}

/**
 * The no-signal floor's opening move.
 *
 * Every floor below runs when there is no usable signal to ground against —
 * so the honest thing to lead with is not a clinical instruction ("Measure
 * blood pressure at rest…") but the situation itself: no assessment is
 * available right now. That IS the meaning-first opening for this case. It
 * claims nothing about the person's numbers, which is exactly the point — the
 * floor must never imply a read the data does not support, and a warm-sounding
 * verdict here would be manufactured.
 *
 * What follows the lead is what makes the metric readable, phrased as how the
 * measure behaves rather than as an order to the reader.
 */
const NO_READ_LEAD: Localized<string> = {
  de: "Für diese Karte liegt gerade keine Einschätzung vor.",
  en: "No assessment on this one right now.",
  fr: "Aucune évaluation disponible pour le moment.",
  es: "Ahora mismo no hay ninguna valoración disponible.",
  it: "Al momento non è disponibile alcuna valutazione.",
  pl: "Na razie nie ma tu żadnej oceny.",
  nl: "Voor deze kaart is er nu geen beoordeling.",
  ko: "지금은 이 카드에 대한 평가가 없어요.",
  ru: "Сейчас по этой карточке оценки нет.",
  "pt-BR": "Não há avaliação disponível para este cartão no momento.",
};

function noReadLead(locale: InsightLocale): string {
  return pick(locale, NO_READ_LEAD);
}

function floor(locale: InsightLocale, body: Localized<string>): string {
  return `${noReadLead(locale)} ${getLocalizedText(locale, body)}`;
}

export function getNoKeyGeneralStatusText(locale: InsightLocale): string {
  // The overview spans many metrics with no single headline value to ground
  // against, so it keeps the honest, generic multi-metric pointer.
  return floor(locale, {
    de: "Aussagekräftig werden diese Zahlen über mehrere Wochen, nicht über einzelne Tage — und zu konstanten Zeitpunkten erfasst, damit sie vergleichbar bleiben. Das Signal, das zählt, ist mehrere Kennzahlen, die sich gleichzeitig in dieselbe ungünstige Richtung bewegen, nicht ein Wert an einem Tag.",
    en: "These numbers become readable across several weeks rather than single days, and taken at consistent times so they stay comparable. The signal that counts is several metrics drifting the same unfavourable way at once, not one value on one day.",
    fr: "Ces chiffres deviennent lisibles sur plusieurs semaines plutôt que sur des journées isolées, et relevés à des moments constants pour rester comparables. Le signal qui compte, c’est plusieurs indicateurs qui dérivent en même temps dans le même sens défavorable, pas une valeur un jour donné.",
    es: "Estos números se vuelven legibles a lo largo de varias semanas y no en días sueltos, y tomados a horas constantes para que sigan siendo comparables. La señal que cuenta son varios indicadores derivando a la vez en la misma dirección desfavorable, no un valor en un día.",
    it: "Questi numeri diventano leggibili nell’arco di più settimane anziché di singoli giorni, e rilevati a orari costanti per restare confrontabili. Il segnale che conta è più indicatori che scivolano insieme nella stessa direzione sfavorevole, non un valore in un giorno.",
    pl: "Te liczby stają się czytelne w skali kilku tygodni, a nie pojedynczych dni, i tylko wtedy, gdy są zbierane o stałych porach, żeby pozostały porównywalne. Sygnałem, który się liczy, jest kilka wskaźników dryfujących jednocześnie w tę samą niekorzystną stronę, a nie jedna wartość jednego dnia.",
    nl: "Deze cijfers worden leesbaar over meerdere weken, niet over losse dagen, en gemeten op vaste momenten zodat ze vergelijkbaar blijven. Het signaal dat telt is dat meerdere waarden tegelijk dezelfde ongunstige kant op schuiven, niet één waarde op één dag.",
    ru: "Эти цифры становятся понятными на дистанции нескольких недель, а не по отдельным дням, и только если снимать их в одно и то же время, чтобы они оставались сопоставимыми. Значимый сигнал — это несколько показателей, которые одновременно уходят в одну и ту же неблагоприятную сторону, а не одно значение за один день.",
    "pt-BR":
      "Estes números ficam legíveis ao longo de várias semanas, não em dias isolados, e medidos em horários consistentes para continuarem comparáveis. O sinal que conta são várias métricas se movendo ao mesmo tempo na mesma direção desfavorável, não um valor em um único dia.",
  });
}

/**
 * Single lab-marker floor. The biomarker card used to fall back to the
 * multi-metric overview tip — text about watching several metrics at once, on
 * a card showing exactly one lab value. This says something true about a lab
 * marker instead.
 *
 * The named lead is built per locale rather than by splicing a shared clause:
 * the quoting convention differs (German low-high quotes, French and Italian
 * guillemets, Polish low-high) and so does where the marker name attaches to
 * the sentence.
 */
const BIOMARKER_NAMED_LEAD: Localized<(named: string) => string> = {
  de: (n) => `Für diesen Laborwert${n} liegt gerade keine Einschätzung vor.`,
  en: (n) => `No assessment${n} right now.`,
  fr: (n) => `Aucune évaluation${n} pour le moment.`,
  es: (n) => `Ahora mismo no hay ninguna valoración${n}.`,
  it: (n) => `Al momento non è disponibile alcuna valutazione${n}.`,
  pl: (n) => `Na razie nie ma żadnej oceny${n}.`,
  nl: (n) => `Er is nu geen beoordeling${n}.`,
  ko: (n) => `지금은${n} 평가가 없어요.`,
  ru: (n) => `Сейчас нет оценки${n}.`,
  "pt-BR": (n) => `Não há avaliação${n} no momento.`,
};

const BIOMARKER_NAMED_CLAUSE: Localized<(marker: string) => string> = {
  de: (m) => ` zu „${m}“`,
  en: (m) => ` for "${m}"`,
  fr: (m) => ` pour « ${m} »`,
  es: (m) => ` de «${m}»`,
  it: (m) => ` per «${m}»`,
  pl: (m) => ` dla „${m}”`,
  nl: (m) => ` voor "${m}"`,
  ko: (m) => ` '${m}'에 대한`,
  ru: (m) => ` по показателю «${m}»`,
  "pt-BR": (m) => ` para "${m}"`,
};

export function getNoKeyBiomarkerStatusText(
  locale: InsightLocale,
  markerName?: string | null,
): string {
  const trimmed = markerName?.trim() ?? "";
  const named =
    trimmed.length > 0 ? pick(locale, BIOMARKER_NAMED_CLAUSE)(trimmed) : "";
  const lead = pick(locale, BIOMARKER_NAMED_LEAD)(named);
  return `${lead} ${getLocalizedText(locale, {
    de: "Ein Laborwert liest sich zuerst gegen die eigenen vorherigen Abnahmen — ein Referenzbereich ist ein grober Anker, kein Urteil. Ein Wert, der sich über mehrere Abnahmen kaum bewegt, erzählt etwas anderes als einer, der gerade gesprungen ist. Die nächste ärztliche Kontrolle ist der richtige Ort, ihn einzuordnen.",
    en: "A lab value reads first against your own previous draws — a reference range is a coarse anchor, not a verdict. One that has barely moved across several draws tells a different story from one that has just stepped. Your next check-up is the right place to put it in context.",
    fr: "Une valeur de laboratoire se lit d’abord contre tes propres prélèvements précédents — un intervalle de référence est un repère grossier, pas un verdict. Une valeur qui a à peine bougé sur plusieurs prélèvements raconte autre chose qu’une valeur qui vient de faire un saut. Ton prochain contrôle médical est le bon endroit pour la remettre en contexte.",
    es: "Un valor de laboratorio se lee primero frente a tus propias extracciones anteriores — un intervalo de referencia es un ancla aproximada, no un veredicto. Uno que apenas se ha movido a lo largo de varias extracciones cuenta algo distinto de uno que acaba de dar un salto. Tu próxima revisión médica es el lugar adecuado para ponerlo en contexto.",
    it: "Un valore di laboratorio si legge prima di tutto rispetto ai tuoi prelievi precedenti — un intervallo di riferimento è un ancoraggio grossolano, non un verdetto. Uno che si è mosso appena nell’arco di più prelievi racconta una storia diversa da uno che ha appena fatto un salto. Il tuo prossimo controllo medico è il posto giusto per contestualizzarlo.",
    pl: "Wynik laboratoryjny czyta się najpierw na tle twoich wcześniejszych oznaczeń — zakres referencyjny to zgrubna kotwica, a nie wyrok. Wynik, który przez kilka oznaczeń niemal się nie ruszył, mówi co innego niż taki, który właśnie podskoczył. Najbliższa kontrola lekarska to właściwe miejsce, żeby go osadzić w kontekście.",
    nl: "Een labwaarde lees je eerst tegen je eigen eerdere metingen. Een referentiebereik is een ruw ankerpunt, geen oordeel. Een waarde die over meerdere metingen nauwelijks beweegt, vertelt iets anders dan een waarde die net een sprong heeft gemaakt. Je volgende controle bij de arts is de juiste plek om hem in context te plaatsen.",
    ru: "Лабораторный показатель читается прежде всего относительно ваших собственных прошлых сдач: референсный интервал — грубый ориентир, а не приговор. Значение, которое почти не меняется от сдачи к сдаче, рассказывает не то же самое, что значение, которое только что скакнуло. Следующий приём у врача — правильное место, чтобы это истолковать.",
    "pt-BR":
      "Um valor de exame se lê primeiro em relação às suas coletas anteriores. Uma faixa de referência é um ponto de apoio aproximado, não um veredito. Um valor que mal se moveu ao longo de várias coletas conta uma história diferente de um que acabou de dar um salto. Sua próxima consulta é o lugar certo para colocá-lo em contexto.",
  })}`;
}

export function getNoKeyBloodPressureStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, BLOOD_PRESSURE_COPY, locale) ??
    floor(locale, {
      de: "Blutdruck wird lesbar über eine Reihe ruhiger Messungen unter vergleichbaren Bedingungen — die Richtung über mehrere Tage sagt weit mehr als ein einzelner Ausreißer, und systolisch und diastolisch gehören dabei zusammen gelesen.",
      en: "Blood pressure becomes readable over a run of calm readings under similar conditions — the direction across several days says far more than any single outlier, and systolic and diastolic are read together rather than one at a time.",
      fr: "La tension se lit sur une série de mesures au calme dans des conditions comparables — la direction sur plusieurs jours dit bien plus qu’une valeur isolée, et la systolique et la diastolique se lisent ensemble plutôt que l’une après l’autre.",
      es: "La tensión se lee a lo largo de una serie de mediciones en calma y en condiciones comparables — la dirección a lo largo de varios días dice mucho más que cualquier valor aislado, y la sistólica y la diastólica se leen juntas y no una por una.",
      it: "La pressione si legge su una serie di misurazioni a riposo in condizioni confrontabili — la direzione nell’arco di più giorni dice molto più di un singolo valore isolato, e sistolica e diastolica si leggono insieme anziché una alla volta.",
      pl: "Ciśnienie staje się czytelne dopiero w serii spokojnych pomiarów w porównywalnych warunkach — kierunek z kilku dni mówi znacznie więcej niż pojedynczy wyskok, a wartość skurczowa i rozkurczowa czyta się razem, a nie osobno.",
      nl: "Bloeddruk wordt leesbaar over een reeks rustige metingen onder vergelijkbare omstandigheden. De richting over meerdere dagen zegt veel meer dan één uitschieter, en de boven- en onderdruk lees je samen in plaats van los van elkaar.",
      ru: "Давление становится понятным по серии спокойных измерений в сопоставимых условиях: направление за несколько дней говорит гораздо больше, чем один выброс, а систолическое с диастолическим читают вместе, а не по отдельности.",
      "pt-BR":
        "A pressão arterial fica legível ao longo de uma série de medições tranquilas em condições parecidas. A direção ao longo de vários dias diz muito mais do que um valor fora da curva, e a sistólica e a diastólica são lidas juntas, não separadamente.",
    })
  );
}

export function getNoKeyWeightStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, WEIGHT_COPY, locale) ??
    floor(locale, {
      de: "Gewicht liest sich als Verlauf, nicht als Tageszahl — unter konstanten Bedingungen gewogen, pendelt sich die normale Tagesschwankung von selbst ein. Die Richtung über Wochen, zusammen mit Blutdruck und BMI gelesen, ist das, was trägt.",
      en: "Weight reads as a trend rather than a daily number — weighed under consistent conditions, the normal day-to-day swing settles out on its own. The direction over weeks, read alongside blood pressure and BMI, is what carries.",
      fr: "Le poids se lit comme une tendance et non comme un chiffre du jour — pesé dans des conditions constantes, la fluctuation quotidienne normale se lisse d’elle-même. C’est la direction sur des semaines, lue avec la tension et l’IMC, qui porte.",
      es: "El peso se lee como una tendencia y no como una cifra diaria — pesado en condiciones constantes, la fluctuación normal del día a día se compensa sola. Lo que sostiene es la dirección a lo largo de semanas, leída junto a la tensión y el IMC.",
      it: "Il peso si legge come andamento e non come numero del giorno — pesato in condizioni costanti, la normale oscillazione quotidiana si compensa da sé. Quello che regge è la direzione nell’arco di settimane, letta insieme alla pressione e all’IMC.",
      pl: "Wagę czyta się jako przebieg, a nie jako liczbę z jednego dnia — przy ważeniu w stałych warunkach normalne dobowe wahania same się wyrównają. Nośny jest kierunek z kilku tygodni, czytany razem z ciśnieniem i BMI.",
      nl: "Gewicht lees je als trend, niet als getal van de dag. Weeg je onder vaste omstandigheden, dan middelt de normale schommeling van dag tot dag zich vanzelf uit. Wat telt is de richting over weken, samen gelezen met bloeddruk en BMI.",
      ru: "Вес читается как тенденция, а не как цифра за день: если взвешиваться в одинаковых условиях, обычные суточные колебания сглаживаются сами. Значимо направление за недели — вместе с давлением и ИМТ.",
      "pt-BR":
        "O peso se lê como tendência, não como número do dia. Pesando-se em condições consistentes, a oscilação normal do dia a dia se acerta sozinha. O que conta é a direção ao longo das semanas, lida junto com a pressão arterial e o IMC.",
    })
  );
}

export function getNoKeyPulseStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, PULSE_COPY, locale) ??
    floor(locale, {
      de: "Der Ruhepuls liest sich am besten entspannt und zur gleichen Tageszeit gemessen. Kurze Ausschläge sind gewöhnlich; was auffällt, ist ein Muster, das über mehrere Tage hält, oder wiederholtes Abdriften vom eigenen üblichen Bereich.",
      en: "Resting pulse reads best taken relaxed and at the same time of day. Short spikes are ordinary; what stands out is a pattern holding across several days, or repeated drift away from your usual range.",
      fr: "Le pouls au repos se lit au mieux pris détendu et à la même heure de la journée. Les à-coups brefs sont ordinaires ; ce qui ressort, c’est un motif qui tient sur plusieurs jours, ou une dérive répétée hors de tes repères habituels.",
      es: "El pulso en reposo se lee mejor tomado relajado y a la misma hora del día. Los picos breves son corrientes; lo que destaca es un patrón que se mantiene varios días, o una deriva repetida fuera de tu rango habitual.",
      it: "Il battito a riposo si legge meglio se misurato da rilassato e alla stessa ora del giorno. I picchi brevi sono ordinari; quello che spicca è uno schema che tiene per più giorni, o uno scostamento ripetuto dal tuo intervallo abituale.",
      pl: "Tętno spoczynkowe najlepiej czytać zmierzone na spokojnie i o tej samej porze dnia. Krótkie skoki są czymś zwyczajnym; uwagę zwraca wzorzec utrzymujący się przez kilka dni albo powtarzające się oddalanie od twojego zwykłego zakresu.",
      nl: "De rusthartslag lees je het best als je hem ontspannen en op hetzelfde moment van de dag meet. Korte pieken zijn gewoon; wat opvalt is een patroon dat meerdere dagen aanhoudt, of steeds weer afwijken van je gebruikelijke bereik.",
      ru: "Пульс в покое лучше читать, если мерить его спокойно и в одно и то же время дня. Короткие всплески обычны; внимание привлекает картина, которая держится несколько дней, или повторяющийся уход от вашего обычного диапазона.",
      "pt-BR":
        "O pulso em repouso se lê melhor quando medido com calma e no mesmo horário do dia. Picos curtos são normais; o que chama atenção é um padrão que se mantém por vários dias, ou um afastamento repetido da sua faixa habitual.",
    })
  );
}

export function getNoKeyBmiStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, BMI_COPY, locale) ??
    floor(locale, {
      de: "Der BMI ist eine grobe Orientierung, kein Urteil, und bedeutet am meisten zusammen mit Gewichtstrend und Körperzusammensetzung gelesen. Eine anhaltende Bewegung über Wochen trägt, wo ein Einzelwert es nicht tut.",
      en: "BMI is a rough orientation rather than a verdict, and it means most read alongside your weight trend and body composition. Sustained movement over weeks carries where a single value does not.",
      fr: "L’IMC est une orientation grossière plutôt qu’un verdict, et il prend son sens lu avec la tendance de ton poids et ta composition corporelle. Un mouvement soutenu sur des semaines porte là où une valeur isolée ne porte pas.",
      es: "El IMC es una orientación aproximada más que un veredicto, y cobra sentido leído junto a la tendencia de tu peso y tu composición corporal. Un movimiento sostenido a lo largo de semanas sostiene donde un valor aislado no lo hace.",
      it: "L’IMC è un orientamento grossolano più che un verdetto, e assume senso letto insieme all’andamento del tuo peso e alla composizione corporea. Un movimento sostenuto nell’arco di settimane regge dove un valore singolo non regge.",
      pl: "BMI to zgrubna orientacja, a nie wyrok, i nabiera sensu dopiero czytane razem z tendencją wagi i składem ciała. Utrzymujący się ruch w skali tygodni jest nośny tam, gdzie pojedyncza wartość nie jest.",
      nl: "BMI is een ruwe oriëntatie, geen oordeel, en zegt het meest samen met je gewichtstrend en lichaamssamenstelling. Een aanhoudende beweging over weken zegt iets waar één losse waarde dat niet doet.",
      ru: "ИМТ — грубый ориентир, а не приговор, и больше всего говорит вместе с динамикой веса и составом тела. Устойчивое движение за недели значит то, чего не значит одно отдельное значение.",
      "pt-BR":
        "O IMC é uma orientação aproximada, não um veredito, e diz mais quando lido junto com a tendência do seu peso e a sua composição corporal. Um movimento sustentado ao longo de semanas diz algo que um valor isolado não diz.",
    })
  );
}

export function getNoKeyMedicationComplianceStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, ADHERENCE_COPY, locale) ??
    floor(locale, {
      de: "Einnahmetreue liest sich als Konstanz über Wochen, nicht als eine Reihe perfekter Tage — je Medikament und im Gesamtbild. Wiederkehrende Auslassungen zur selben Tageszeit sind das Muster, auf das es ankommt, und eine feste Routine fängt sie am ehesten ab.",
      en: "Adherence reads as consistency over weeks rather than a run of perfect days — per medication and in the overall picture. Repeated misses at the same time of day are the pattern that counts, and a fixed routine is what usually catches them.",
      fr: "L’observance se lit comme une régularité sur des semaines plutôt que comme une série de journées parfaites — par médicament et dans l’ensemble. Les oublis répétés à la même heure sont le motif qui compte, et c’est une routine fixe qui les rattrape d’ordinaire.",
      es: "La adherencia se lee como constancia a lo largo de semanas y no como una racha de días perfectos — por medicamento y en el conjunto. Los olvidos repetidos a la misma hora son el patrón que cuenta, y lo que suele recuperarlos es una rutina fija.",
      it: "L’aderenza si legge come costanza nell’arco di settimane più che come una serie di giornate perfette — per singolo farmaco e nel quadro complessivo. Le dimenticanze ripetute alla stessa ora sono lo schema che conta, ed è una routine fissa a intercettarle di solito.",
      pl: "Regularność przyjmowania leków czyta się jako stałość w skali tygodni, a nie jako serię idealnych dni — osobno dla każdego leku i w całym obrazie. Powtarzające się pominięcia o tej samej porze to wzorzec, który się liczy, a wyłapuje je zwykle stały rytm dnia.",
      nl: "Medicijntrouw lees je als regelmaat over weken, niet als een reeks perfecte dagen, per medicijn en in het geheel. Herhaald vergeten op hetzelfde moment van de dag is het patroon dat telt, en een vaste routine vangt dat meestal op.",
      ru: "Приверженность лечению читается как постоянство за недели, а не как череда идеальных дней — по каждому препарату и в целом. Повторяющиеся пропуски в одно и то же время суток и есть та картина, которая важна, и лучше всего её ловит заведённый распорядок.",
      "pt-BR":
        "A adesão se lê como regularidade ao longo de semanas, não como uma sequência de dias perfeitos, por medicamento e no conjunto. Esquecimentos repetidos no mesmo horário do dia são o padrão que conta, e uma rotina fixa costuma resolvê-los.",
    })
  );
}

export function getNoKeyMoodStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, MOOD_COPY, locale) ??
    floor(locale, {
      de: "Stimmung liest sich über Wochen, nicht über einzelne Tage — wiederkehrende Muster und wie sie zu den anderen Werten passen, sind das, was trägt. Eine anhaltende Phase niedriger Stimmung ist die, die Aufmerksamkeit verdient.",
      en: "Mood reads over weeks rather than single days — recurring patterns, and how they line up with your other metrics, are what carry. A sustained low stretch is the one that deserves attention.",
      fr: "L’humeur se lit sur des semaines plutôt que sur des journées isolées — ce qui porte, ce sont les motifs qui reviennent et la façon dont ils s’alignent avec tes autres valeurs. C’est une phase basse qui dure qui mérite l’attention.",
      es: "El estado de ánimo se lee a lo largo de semanas y no en días sueltos — lo que sostiene son los patrones que se repiten y cómo encajan con tus otros valores. La que merece atención es una fase baja que se prolonga.",
      it: "L’umore si legge nell’arco di settimane più che nei singoli giorni — quello che regge sono gli schemi ricorrenti e come si allineano con gli altri tuoi valori. È una fase bassa che si protrae quella che merita attenzione.",
      pl: "Nastrój czyta się w skali tygodni, a nie pojedynczych dni — nośne są powtarzające się wzorce i to, jak układają się względem twoich pozostałych wartości. Uwagi wymaga przede wszystkim dłużej utrzymujący się spadek.",
      nl: "Stemming lees je over weken, niet over losse dagen. Wat telt zijn terugkerende patronen en hoe die samenhangen met je andere waarden. Een aanhoudende periode van lage stemming is wat aandacht verdient.",
      ru: "Настроение читается на дистанции недель, а не отдельных дней: значимы повторяющиеся картины и то, как они совпадают с другими вашими показателями. Внимания заслуживает затянувшийся период сниженного настроения.",
      "pt-BR":
        "O humor se lê ao longo de semanas, não em dias isolados. O que conta são os padrões que se repetem e como eles se relacionam com as suas outras métricas. Um período prolongado de humor baixo é o que merece atenção.",
    })
  );
}
