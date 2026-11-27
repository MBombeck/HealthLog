/**
 * Extra words people search with, per palette entry id, for the cases where
 * the title in the reader's language is not the word they type: an English
 * term in a German interface, an abbreviation, the device rather than the
 * metric. Matched one tier below the title (`rank.ts`).
 *
 * Kept small on purpose. Every title is already searchable in its own
 * language; an entry here earns its place by a word that title cannot carry.
 * Only pages that exist are listed: there is no calf or other limb
 * circumference page, so no synonym points at one.
 */
export const PALETTE_SYNONYMS: Readonly<Record<string, ReadonlyArray<string>>> =
  {
    // ── Pages ──
    "nav:/": ["home", "start", "overview", "übersicht", "today", "heute"],
    "nav:/measurements": ["values", "werte", "readings", "messwerte"],
    "nav:/medications": [
      "meds",
      "pills",
      "tablets",
      "drugs",
      "medikamente",
      "tabletten",
      "arzneimittel",
    ],
    "nav:/labs": ["blood test", "bloodwork", "blutwerte", "labor", "labwerte"],
    "nav:/care": ["preventive", "vorsorge", "screening", "reminders"],
    "nav:/coach": ["chat", "ai", "ki", "assistant", "assistent"],
    "nav:/documents": ["pdf", "scan", "befunde", "arztbrief", "letters"],
    "nav:/timeline": ["history", "verlauf", "lebenslauf", "chronik"],
    "nav:/illness": ["sick", "krank", "krankheit", "symptoms"],
    "nav:/vaccinations": ["vaccine", "impfung", "impfpass", "shots"],
    "nav:/mood": ["stimmung", "feelings", "gefühle", "journal"],
    "nav:/cycle": ["period", "menstruation", "periode", "zyklus"],
    "settings:notifications": ["alerts", "benachrichtigungen", "inbox"],

    // ── Insights ──
    "insights:weight": ["weight", "gewicht", "kg", "scale", "waage"],
    "insights:blood-pressure": [
      "bp",
      "rr",
      "blood pressure",
      "blutdruck",
      "hypertension",
      "systolic",
      "diastolic",
    ],
    "insights:pulse": ["heart rate", "herzfrequenz", "hr", "puls", "bpm"],
    "insights:resting-pulse": ["resting heart rate", "ruhepuls", "rhr"],
    "insights:hrv": ["heart rate variability", "herzfrequenzvariabilität"],
    "insights:sleep": ["sleep", "schlaf", "nacht", "night"],
    "insights:steps": ["steps", "schritte", "walking", "gehen"],
    "insights:blood-glucose": [
      "glucose",
      "sugar",
      "blutzucker",
      "zucker",
      "cgm",
      "diabetes",
    ],
    "insights:body-fat": ["fat", "körperfett", "kfa"],
    "insights:oxygen": ["spo2", "sauerstoff", "oxygen", "o2"],
    "insights:body-temperature": ["fever", "fieber", "temperatur"],
    "insights:cardio-fitness": ["vo2", "vo2max", "fitness"],
    "insights:workouts": ["training", "sport", "exercise", "workouts"],
    "insights:mood": ["stimmung", "mood"],
    "insights:waist": ["waist", "taille", "bauchumfang", "umfang"],
    "insights:daylight": ["sun", "sonne", "tageslicht", "outdoors"],

    // ── Settings ──
    "settings:security#passkeys": [
      "passkey",
      "webauthn",
      "face id",
      "touch id",
    ],
    "settings:security#two-factor": ["2fa", "totp", "mfa", "authenticator"],
    "settings:security#password": ["passwort", "kennwort"],
    "settings:export#full-backup": ["backup", "sicherung", "datensicherung"],
    "settings:export#import-apple-health": ["healthkit", "iphone", "import"],
    "settings:integrations#apple-health": ["healthkit", "iphone"],
    "settings:integrations#withings": ["scale", "waage"],
    "settings:integrations#channels": ["telegram", "ntfy", "push", "email"],
    "settings:privacy#delete-data": ["delete", "löschen", "gdpr", "dsgvo"],
    "settings:advanced#delete-account": ["delete account", "konto löschen"],
    "settings:ai#ai-provider": ["openai", "anthropic", "ollama", "llm", "key"],
    "settings:api#api-tokens": ["token", "api key", "bearer"],
    "settings:modules": ["features", "funktionen", "module"],
    // The page that generates the doctor report. The words are the task,
    // in every interface language, so a search for the task finds the page
    // that does it rather than the module switch that turns it off.
    "settings:health-record": [
      "doctor report",
      "doctor",
      "report",
      "pdf",
      "arztbericht",
      "arzt",
      "bericht",
      "informe médico",
      "informe",
      "rapport médical",
      "rapport",
      "referto medico",
      "rapporto",
      "의사 보고서",
      "보고서",
      "artsrapport",
      "verslag",
      "raport lekarski",
      "raport",
      "relatório médico",
      "relatório",
      "отчёт для врача",
      "отчёт",
      "врач",
    ],
    "settings:account": ["profil", "profile", "name", "email"],

    // ── Actions ──
    "action:capture": ["add", "new", "log", "neu", "eintragen", "erfassen"],
    "action:today": ["today", "heute", "day", "tag"],
    "action:backup": ["backup", "sicherung", "export"],
    "action:coach": ["chat", "ai", "ki", "ask", "fragen"],
    "action:shortcuts": ["keyboard", "tastatur", "hotkeys", "shortcuts"],
  };

/**
 * Entries a task word should reach first. The doctor-report page shares
 * "pdf" with Documents and "doctor report" with the module switch; the boost
 * puts the page that does the job above both whenever it matches at all.
 */
export const PALETTE_TASK_BOOST: Readonly<Record<string, number>> = {
  "settings:health-record": 100,
};

/**
 * Search words in the reader's own language, per entry id: an i18n key under
 * `palette.keywords.*` holding a comma-separated list, present in every
 * locale (`surface-registry-guard.test.ts`). Where `PALETTE_SYNONYMS` carries
 * a few cross-language words, these carry the words a person types in their
 * interface language for a concept the title names differently ("snooze" for
 * "Remind me later", "dark mode" for "Theme", "Nextcloud" for the folder).
 */
export const PALETTE_KEYWORD_KEYS: Readonly<Record<string, string>> = {
  "nav:/emergency-card": "palette.keywords.emergencyCard",
  "settings:notifications": "palette.keywords.notificationsPerChannel",
  "settings:modules/medications#medicine-registry":
    "palette.keywords.medicineRegistry",
  "settings:notifications#dose-snooze": "palette.keywords.snooze",
  "settings:notifications#security-alerts": "palette.keywords.securityAlerts",
  "settings:notifications#lasting-change": "palette.keywords.lastingChange",
  "settings:notifications#sync-stalled": "palette.keywords.syncStalled",
  "settings:account#theme": "palette.keywords.theme",
  "settings:export#import-gadgetbridge": "palette.keywords.gadgetbridge",
  "settings:export#import-fhir-bundle": "palette.keywords.fhirBundle",
  "settings:integrations#import-health-connect-remote":
    "palette.keywords.healthConnectFolder",
  "settings:health-record#report-schedule": "palette.keywords.reportSchedule",
  "settings:health-record#calendar": "palette.keywords.careCalendar",
  "settings:privacy#who-has-access": "palette.keywords.whoHasAccess",
  "admin:services": "palette.keywords.adminPush",
  "admin:system-status": "palette.keywords.adminSystemStatus",
};
