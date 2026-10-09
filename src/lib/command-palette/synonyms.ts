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
    "nav:/checkups": ["preventive", "vorsorge", "screening", "reminders"],
    "nav:/coach": ["chat", "ai", "ki", "assistant", "assistent"],
    "nav:/documents": ["pdf", "scan", "befunde", "arztbrief", "letters"],
    "nav:/timeline": ["history", "verlauf", "lebenslauf", "chronik"],
    "nav:/illness": ["sick", "krank", "krankheit", "symptoms"],
    "nav:/vaccinations": ["vaccine", "impfung", "impfpass", "shots"],
    "nav:/mood": ["stimmung", "feelings", "gefühle", "journal"],
    "nav:/cycle": ["period", "menstruation", "periode", "zyklus"],
    "nav:/notifications": ["alerts", "benachrichtigungen", "inbox"],

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
    "settings:account": ["profil", "profile", "name", "email"],

    // ── Actions ──
    "action:capture": ["add", "new", "log", "neu", "eintragen", "erfassen"],
    "action:today": ["today", "heute", "day", "tag"],
    "action:backup": ["backup", "sicherung", "export"],
    "action:coach": ["chat", "ai", "ki", "ask", "fragen"],
    "action:shortcuts": ["keyboard", "tastatur", "hotkeys", "shortcuts"],
  };
