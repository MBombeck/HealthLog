import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { locales } from "@/lib/i18n/config";
import {
  DOSE_ACTION_TERM,
  DOSE_STATE_TERM,
} from "@/lib/medications/dose-state/terms";

/**
 * One word per dose state and action, in every sentence that names one.
 *
 * `medications/dose-state/terms.ts` holds the words the card, the table and
 * the forms render through. Push, Telegram, the doctor report, the share
 * texts and the export help write their own sentences around a state, and in
 * each language those sentences drifted to a second verb: German said a dose
 * was "ausgelassen" while the card said "Übersprungen", French pushed
 * "ignorée" next to a card reading "Sautée". This guard pins every such
 * sentence to the table, per locale:
 *
 * 1. no locale's known wrong verb for "skip" appears anywhere under the dose
 *    namespaces;
 * 2. each sentence that reports a taken or skipped dose carries the
 *    participle of `dose.state.taken` / `dose.state.skipped` (its stem, so
 *    grammatical endings may differ, at the start of a word, so a different
 *    verb that merely contains it does not pass);
 * 3. the reminder buttons and the daily briefing use the action words;
 * 4. the four reminder phases are the dose states they announce, and "still
 *    due" is the due state with a qualifier, not a fifth state;
 * 5. "Log intake" is one phrase wherever it opens the intake form;
 * 6. one word per window: course, on-time window, reminder duration.
 */

const MESSAGES_DIR = join(__dirname, "../../messages");

function flatten(
  obj: unknown,
  prefix: string,
  out: Map<string, string>,
): Map<string, string> {
  if (obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else if (typeof v === "object") flatten(v, key, out);
  }
  return out;
}

const bundles = new Map(
  locales.map((locale) => [
    locale,
    flatten(
      JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf8")),
      "",
      new Map(),
    ),
  ]),
);

function value(locale: string, key: string): string {
  const found = bundles.get(locale as (typeof locales)[number])?.get(key);
  if (found === undefined) throw new Error(`${locale}: ${key} is missing`);
  return found;
}

/**
 * The dose namespaces: everything a dose state or action can be named in.
 * Imports of other data (`medications.import.*`) and the optional injection
 * site step skip rows or steps, not doses, and stay out.
 */
const DOSE_NAMESPACE =
  /^(medications\.(?!import\.|logInjectionSite)|medicationReminders\.|notifications\.(intakeRecorded|sharedRecordIntake|eventMedication|eventSharedRecordIntake)|telegram\.|doctorReport\.(col|medicationEffect)|seizures\.report\.|recordSharing\.invite\.|daily\.|dashboard\.medication|nav\.capture\.medication|settings\.sections\.export\.import\.doseHistory\.)/;

/** Per locale, the verbs for "skip" that are not the locale's term. */
const FORBIDDEN_SKIP: Record<string, RegExp> = {
  de: /ausl[aä]ss|ausgelass|auszulass/i,
  en: /\bomit|\bignored\b/i,
  fr: /\bignorée?s?\b|\bomise?s?\b/i,
  es: /\bsaltad[ao]s?\b|\bsaltas\b|\bignorad/i,
  it: /\bomess|\bignorat|\btralasci/i,
  pl: /\bopuszcz|\bzignorow/i,
  ko: /무시|생략/,
  nl: /\bgenegeerd\b/i,
  "pt-BR": /\bomitid|\bignorad|\bsaltad/i,
  ru: /игнорир/i,
};

const TAKEN_KEYS = [
  "notifications.intakeRecorded.bodyTaken",
  "notifications.sharedRecordIntake.bodyTaken",
  "telegram.recordedAsTaken",
  "medications.detail.verlauf.markAsTaken",
  "medications.intakeToastTaken",
  "medications.intakeAlreadyTaken",
  "doctorReport.colTaken",
] as const;

const SKIPPED_KEYS = [
  "notifications.intakeRecorded.bodySkipped",
  "notifications.sharedRecordIntake.bodySkipped",
  "telegram.skipped",
  "medications.detail.verlauf.markAsSkipped",
  "medications.intakeToastSkipped",
  "medications.detail.intake.edit.skippedLabel",
  "doctorReport.colSkipped",
] as const;

/**
 * One word per window. A course (start to end) is the course or period; the
 * span in which a dose counts as on time is the window; how long reminders
 * keep coming is a duration. "Reminder window" and "course window" said
 * window for all three.
 */
const FORBIDDEN_WINDOW: Record<string, RegExp> = {
  de: /Erinnerungsfenster|Kursfenster/i,
  en: /reminder windows?|course window/i,
  fr: /fenêtre de (rappel|cure)|plage de rappel/i,
  es: /ventana (de recordatorio|del curso)/i,
  it: /finestra (di promemoria|del ciclo)/i,
  pl: /okn[ao] (przypomnie|kuracji)/i,
  ko: /알림 시간이 끝/,
  nl: /herinneringsvenster/i,
  "pt-BR": /janelas? (de lembrete|do curso)/i,
  ru: /окн[ао] (напоминани|курса)/i,
};

const WINDOW_NAMESPACE =
  /^(medications|medicationReminders|notifications|onboarding|gettingStarted|dashboard)\./;

/** The phrase that opens the intake form, wherever it is offered. */
const LOG_INTAKE_KEYS = [
  "dashboard.quickAddMedicationIntake",
  "medications.addChoice.logIntake",
  "medications.detail.verlauf.add",
  "medications.intakeForm.title",
] as const;

/**
 * The participle's stem: the word without its last two letters (one for a
 * short word), so "Übersprungen" matches "übersprungene" and "Przyjęte"
 * matches "przyjętą".
 */
function stem(word: string): string {
  const lower = word.toLocaleLowerCase();
  const cut = [...lower].length <= 4 ? 1 : 2;
  return [...lower].slice(0, -cut).join("");
}

function hasWordStartingWith(text: string, prefix: string): boolean {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}])${escaped}`, "u").test(
    text.toLocaleLowerCase(),
  );
}

const includesFold = (text: string, part: string) =>
  text.toLocaleLowerCase().includes(part.toLocaleLowerCase());

describe("dose vocabulary is the term table's, in every locale", () => {
  it.each(locales)("%s: no second verb for skipping a dose", (locale) => {
    const forbidden = FORBIDDEN_SKIP[locale];
    expect(forbidden, `no forbidden list for ${locale}`).toBeDefined();
    const offenders = [...bundles.get(locale)!.entries()]
      .filter(([key, text]) => DOSE_NAMESPACE.test(key) && forbidden.test(text))
      .map(([key, text]) => `${key} = ${text}`);
    expect(offenders).toEqual([]);
  });

  it.each(locales)("%s: one word per window", (locale) => {
    const forbidden = FORBIDDEN_WINDOW[locale];
    expect(forbidden, `no window list for ${locale}`).toBeDefined();
    const offenders = [...bundles.get(locale)!.entries()]
      .filter(
        ([key, text]) => WINDOW_NAMESPACE.test(key) && forbidden.test(text),
      )
      .map(([key, text]) => `${key} = ${text}`);
    expect(offenders).toEqual([]);
  });

  it.each(locales)(
    "%s: sentences about a taken or skipped dose use the state's participle",
    (locale) => {
      const taken = stem(value(locale, DOSE_STATE_TERM.taken));
      const skipped = stem(value(locale, DOSE_STATE_TERM.skipped));
      const offenders = [
        ...TAKEN_KEYS.filter(
          (key) => !hasWordStartingWith(value(locale, key), taken),
        ).map((key) => `${key} lacks "${taken}…": ${value(locale, key)}`),
        ...SKIPPED_KEYS.filter(
          (key) => !hasWordStartingWith(value(locale, key), skipped),
        ).map((key) => `${key} lacks "${skipped}…": ${value(locale, key)}`),
      ];
      expect(offenders).toEqual([]);
    },
  );

  it.each(locales)("%s: buttons and prompts use the action words", (locale) => {
    const take = value(locale, DOSE_ACTION_TERM.take);
    const skip = value(locale, DOSE_ACTION_TERM.skip);
    expect(value(locale, "medicationReminders.buttonTaken")).toContain(take);
    expect(value(locale, "medicationReminders.buttonTakenLate")).toContain(
      take,
    );
    expect(value(locale, "medicationReminders.buttonSkip")).toContain(skip);
    // The briefing's dose row leads to the dose and names what is done there.
    expect(value(locale, "daily.action.logDose")).toBe(take);
    // The rolling cadence restarts on the Take button, by its name.
    expect(
      includesFold(
        value(locale, "medications.wizard.cadence.rolling.description"),
        take,
      ),
    ).toBe(true);
  });

  it.each(locales)(
    "%s: the reminder phases are the dose states they announce",
    (locale) => {
      expect(value(locale, "medications.phaseGreen")).toBe(
        value(locale, DOSE_STATE_TERM.due),
      );
      expect(value(locale, "medications.phaseOrange")).toBe(
        value(locale, DOSE_STATE_TERM.overdue),
      );
      expect(value(locale, "medications.phaseRed")).toBe(
        value(locale, DOSE_STATE_TERM.missed),
      );
      // "Still due" is the due state, said a second time: not a state of its own.
      expect(
        includesFold(
          value(locale, "medications.phaseYellow"),
          value(locale, DOSE_STATE_TERM.due),
        ),
      ).toBe(true);
      for (const phase of ["Green", "Yellow", "Orange", "Red"] as const) {
        expect(
          value(locale, `medicationReminders.phase${phase}Title`),
        ).toContain(value(locale, `medications.phase${phase}`));
      }
    },
  );

  it.each(locales)("%s: one phrase opens the intake form", (locale) => {
    const phrases = new Set(LOG_INTAKE_KEYS.map((key) => value(locale, key)));
    expect([...phrases]).toHaveLength(1);
  });
});
