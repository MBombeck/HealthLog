#!/usr/bin/env node
// v1.4.27 B6 — commit 3.
// Add the new keys referenced by B1/B3/B4/B5 across all six bundles.
// Also drop the now-dead `charts.moodLabel1..5` keys, retired by the
// mood-chart shared-label-source refactor in the same commit.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const MESSAGES = join(ROOT, "messages");

// === New keys ===
// Key shape: dotted path → per-locale string.
// Inputs verified against B1/B3/B4/B5 call-sites:
//   - src/components/dashboard/glp1-tile.tsx (B1)
//   - src/components/admin/login-overview-section.tsx (B3)
//   - src/app/insights/{bmi,blutdruck,gewicht,medikamente,puls,schlaf,stimmung}/page.tsx (B4)
//   - src/app/api/admin/notifications/{reminder-check,test}/route.ts (B5)
//   - src/app/api/internal/deploy-webhook/route.ts (B5)
//   - src/app/api/settings/telegram/test/route.ts (B5)

const NEW_KEYS = {
  // ---- B1 GLP-1 dashboard tile ----
  "dashboard.glp1.tabLevel": {
    de: "Spiegel",
    en: "Level",
    fr: "Taux",
    es: "Nivel",
    it: "Livello",
    pl: "Poziom",
  },
  "dashboard.glp1.tabWeight": {
    de: "Gewicht",
    en: "Weight",
    fr: "Poids",
    es: "Peso",
    it: "Peso",
    pl: "Waga",
  },
  "dashboard.glp1.tabsAria": {
    de: "Wirkstoffspiegel oder Gewichtsverlauf anzeigen",
    en: "Switch between drug-level and weight views",
    fr: "Basculer entre la vue taux et la vue poids",
    es: "Cambiar entre vista de nivel y vista de peso",
    it: "Passa tra vista del livello e vista del peso",
    pl: "Przełącz między widokiem poziomu i widokiem wagi",
  },
  "dashboard.glp1.rangeStripLabel": {
    de: "Zeitraum auswählen",
    en: "Select range",
    fr: "Sélectionner la période",
    es: "Seleccionar rango",
    it: "Seleziona intervallo",
    pl: "Wybierz zakres",
  },
  "dashboard.glp1.levelUnavailable": {
    de: "Spiegel noch nicht verfügbar — Dosis loggen, dann erscheint die Kurve.",
    en: "Drug level not yet available — log a dose and the curve will appear.",
    fr: "Taux indisponible — enregistrez une dose pour afficher la courbe.",
    es: "Nivel no disponible aún — registra una dosis y la curva aparecerá.",
    it: "Livello non ancora disponibile — registra una dose e la curva apparirà.",
    pl: "Poziom jeszcze niedostępny — zarejestruj dawkę, a krzywa się pojawi.",
  },
  "dashboard.glp1.weightUnavailable": {
    de: "Gewichtsverlauf noch nicht verfügbar — Messung erfassen, um den Verlauf zu sehen.",
    en: "Weight trend not yet available — log a measurement to see the trend.",
    fr: "Tendance de poids indisponible — enregistrez une mesure pour la voir.",
    es: "Tendencia de peso no disponible aún — registra una medición para verla.",
    it: "Andamento del peso non ancora disponibile — registra una misurazione per vederlo.",
    pl: "Trend wagi jeszcze niedostępny — zarejestruj pomiar, aby go zobaczyć.",
  },

  // ---- B3 admin carrier chip ----
  "admin.carrier": {
    de: "Anbieter",
    en: "Carrier",
    fr: "Opérateur",
    es: "Operador",
    it: "Operatore",
    pl: "Operator",
  },
  "admin.carrierUnknown": {
    de: "Unbekannter Anbieter",
    en: "Unknown carrier",
    fr: "Opérateur inconnu",
    es: "Operador desconocido",
    it: "Operatore sconosciuto",
    pl: "Nieznany operator",
  },

  // ---- B4 insights empty states ----
  "insights.emptyState.bloodPressure.title": {
    de: "Noch keine Blutdruckwerte",
    en: "No blood pressure entries yet",
    fr: "Aucune mesure de tension artérielle",
    es: "Aún no hay registros de presión arterial",
    it: "Nessuna misurazione della pressione",
    pl: "Brak pomiarów ciśnienia krwi",
  },
  "insights.emptyState.bloodPressure.description": {
    de: "Sobald du Blutdruck loggst, erscheinen hier Trend, Zielbereichs-Anteil und WHO-Klassifizierung.",
    en: "Log a blood pressure reading and the trend chart, in-range share, and WHO classification will appear here.",
    fr: "Enregistrez une mesure de tension : la tendance, la part dans la cible et la classification OMS s'afficheront ici.",
    es: "Registra una medición de presión y aquí aparecerán la tendencia, el porcentaje en rango y la clasificación de la OMS.",
    it: "Registra una misurazione e qui appariranno l'andamento, la percentuale in target e la classificazione OMS.",
    pl: "Zarejestruj pomiar ciśnienia, a pojawi się tu trend, udział w zakresie docelowym i klasyfikacja WHO.",
  },
  "insights.emptyState.bloodPressure.cta": {
    de: "Blutdruck loggen",
    en: "Log blood pressure",
    fr: "Enregistrer une tension",
    es: "Registrar presión",
    it: "Registra pressione",
    pl: "Zarejestruj ciśnienie",
  },
  "insights.emptyState.weight.title": {
    de: "Noch keine Gewichtswerte",
    en: "No weight entries yet",
    fr: "Aucune mesure de poids",
    es: "Aún no hay registros de peso",
    it: "Nessuna misurazione del peso",
    pl: "Brak pomiarów wagi",
  },
  "insights.emptyState.weight.description": {
    de: "Logge ein Gewicht, und Verlauf, gleitender Durchschnitt und Zielbereich erscheinen automatisch.",
    en: "Log a weight and the trend, moving average, and target band will appear automatically.",
    fr: "Enregistrez un poids : la tendance, la moyenne glissante et la zone cible apparaîtront automatiquement.",
    es: "Registra un peso y aparecerán automáticamente la tendencia, la media móvil y la zona objetivo.",
    it: "Registra un peso: andamento, media mobile e fascia obiettivo appariranno automaticamente.",
    pl: "Zarejestruj wagę, a trend, średnia krocząca i zakres docelowy pojawią się automatycznie.",
  },
  "insights.emptyState.weight.cta": {
    de: "Gewicht loggen",
    en: "Log weight",
    fr: "Enregistrer un poids",
    es: "Registrar peso",
    it: "Registra peso",
    pl: "Zarejestruj wagę",
  },
  "insights.emptyState.pulse.title": {
    de: "Noch keine Pulswerte",
    en: "No pulse entries yet",
    fr: "Aucune mesure de pouls",
    es: "Aún no hay registros de pulso",
    it: "Nessuna misurazione del polso",
    pl: "Brak pomiarów tętna",
  },
  "insights.emptyState.pulse.description": {
    de: "Logge einen Puls, dann erscheinen Ruhepuls, HRV und VO₂ max in dieser Ansicht.",
    en: "Log a pulse reading and resting pulse, HRV and VO₂ max will appear in this view.",
    fr: "Enregistrez un pouls : pouls au repos, VFC et VO₂ max apparaîtront dans cette vue.",
    es: "Registra un pulso y aquí aparecerán pulso en reposo, VFC y VO₂ máx.",
    it: "Registra una misurazione: polso a riposo, HRV e VO₂ max appariranno in questa vista.",
    pl: "Zarejestruj tętno, a w tym widoku pojawi się tętno spoczynkowe, HRV i VO₂ max.",
  },
  "insights.emptyState.pulse.cta": {
    de: "Puls loggen",
    en: "Log pulse",
    fr: "Enregistrer un pouls",
    es: "Registrar pulso",
    it: "Registra polso",
    pl: "Zarejestruj tętno",
  },
  "insights.emptyState.bmi.title": {
    de: "BMI noch nicht berechnet",
    en: "BMI not yet computed",
    fr: "IMC pas encore calculé",
    es: "IMC aún no calculado",
    it: "BMI non ancora calcolato",
    pl: "BMI jeszcze nie obliczone",
  },
  "insights.emptyState.bmi.description": {
    de: "Sobald Größe und mindestens ein Gewichtswert vorliegen, erscheint hier der BMI-Verlauf samt WHO-Zonen.",
    en: "Once height and at least one weight entry are present, the BMI trend with WHO zones will appear here.",
    fr: "Dès qu'une taille et au moins un poids sont enregistrés, la tendance IMC avec les zones OMS s'affichera ici.",
    es: "Cuando haya altura y al menos un registro de peso, aquí aparecerá la tendencia del IMC con las zonas de la OMS.",
    it: "Una volta inseriti altezza e almeno un peso, qui apparirà l'andamento del BMI con le zone OMS.",
    pl: "Po wpisaniu wzrostu i co najmniej jednej wagi pojawi się tu trend BMI z zakresami WHO.",
  },
  "insights.emptyState.bmi.cta": {
    de: "Gewicht loggen",
    en: "Log weight",
    fr: "Enregistrer un poids",
    es: "Registrar peso",
    it: "Registra peso",
    pl: "Zarejestruj wagę",
  },
  "insights.emptyState.mood.title": {
    de: "Noch keine Stimmungseinträge",
    en: "No mood entries yet",
    fr: "Aucune entrée d'humeur",
    es: "Aún no hay entradas de estado de ánimo",
    it: "Nessuna voce d'umore",
    pl: "Brak wpisów nastroju",
  },
  "insights.emptyState.mood.description": {
    de: "Logge eine Stimmung, dann erscheinen Verlauf, Stabilitätsband und Korrelationen.",
    en: "Log a mood entry and the trend, stability band and correlations will appear.",
    fr: "Enregistrez une humeur : la tendance, la bande de stabilité et les corrélations s'afficheront.",
    es: "Registra un estado de ánimo y aparecerán la tendencia, la banda de estabilidad y las correlaciones.",
    it: "Registra un umore: appariranno andamento, fascia di stabilità e correlazioni.",
    pl: "Zarejestruj nastrój, a pojawi się trend, pasmo stabilności i korelacje.",
  },
  "insights.emptyState.mood.cta": {
    de: "Stimmung loggen",
    en: "Log mood",
    fr: "Enregistrer une humeur",
    es: "Registrar ánimo",
    it: "Registra umore",
    pl: "Zarejestruj nastrój",
  },
  "insights.emptyState.medication.title": {
    de: "Noch keine Medikamente angelegt",
    en: "No medications set up yet",
    fr: "Aucun médicament configuré",
    es: "Aún no hay medicamentos configurados",
    it: "Nessun farmaco configurato",
    pl: "Brak skonfigurowanych leków",
  },
  "insights.emptyState.medication.description": {
    de: "Lege ein Medikament an, dann erscheinen Einnahme-Compliance, Wirkstoffspiegel und Eskalations-Verlauf.",
    en: "Set up a medication and intake compliance, drug level and titration timeline will appear here.",
    fr: "Configurez un médicament : observance, taux plasmatique et titration apparaîtront ici.",
    es: "Configura un medicamento y aquí aparecerán la adherencia, el nivel plasmático y la titulación.",
    it: "Configura un farmaco: aderenza, livello plasmatico e titolazione appariranno qui.",
    pl: "Skonfiguruj lek, a pojawi się adherencja, poziom we krwi i schemat titracji.",
  },
  "insights.emptyState.medication.cta": {
    de: "Medikament hinzufügen",
    en: "Add medication",
    fr: "Ajouter un médicament",
    es: "Añadir medicamento",
    it: "Aggiungi farmaco",
    pl: "Dodaj lek",
  },
  "insights.emptyState.sleep.title": {
    de: "Noch keine Schlafwerte",
    en: "No sleep entries yet",
    fr: "Aucune donnée de sommeil",
    es: "Aún no hay registros de sueño",
    it: "Nessuna voce di sonno",
    pl: "Brak danych o śnie",
  },
  "insights.emptyState.sleep.description": {
    de: "Sobald Schlafdaten vorliegen (manuell oder via Withings / Apple Health), erscheint hier der nächtliche Stadien-Verlauf.",
    en: "Once sleep data lands (manual or via Withings / Apple Health), the per-night stage breakdown will appear here.",
    fr: "Dès que des données de sommeil sont disponibles (manuel ou via Withings / Apple Health), la répartition par phase apparaîtra ici.",
    es: "Una vez disponibles los datos de sueño (manual o vía Withings / Apple Health), aquí aparecerá el desglose por fases.",
    it: "Quando saranno disponibili dati sul sonno (manuale o tramite Withings / Apple Health), qui apparirà la suddivisione per fase.",
    pl: "Gdy pojawią się dane o śnie (ręcznie lub przez Withings / Apple Health), wyświetli się tu rozkład faz na noc.",
  },
  "insights.emptyState.sleep.cta": {
    de: "Withings verbinden",
    en: "Connect Withings",
    fr: "Connecter Withings",
    es: "Conectar Withings",
    it: "Collega Withings",
    pl: "Połącz Withings",
  },

  // ---- B5 notifications ----
  "notifications.admin.deployFailedTitle": {
    de: "Bereitstellung fehlgeschlagen: {application}",
    en: "Deployment failed: {application}",
    fr: "Échec du déploiement : {application}",
    es: "Despliegue fallido: {application}",
    it: "Distribuzione fallita: {application}",
    pl: "Wdrożenie nie powiodło się: {application}",
  },
  "notifications.admin.deployFailedBody": {
    de: "Bei der Bereitstellung von {application} (#{deployment}) ist ein Fehler aufgetreten: {error}. Logs ansehen: {logsUrl}",
    en: "An error occurred while deploying {application} (#{deployment}): {error}. View logs: {logsUrl}",
    fr: "Une erreur est survenue lors du déploiement de {application} (#{deployment}) : {error}. Voir les journaux : {logsUrl}",
    es: "Se produjo un error al desplegar {application} (#{deployment}): {error}. Ver registros: {logsUrl}",
    it: "Si è verificato un errore durante la distribuzione di {application} (#{deployment}): {error}. Vedi log: {logsUrl}",
    pl: "Wystąpił błąd podczas wdrażania {application} (#{deployment}): {error}. Zobacz logi: {logsUrl}",
  },
  "notifications.admin.testNotificationTitle": {
    de: "HealthLog Test-Benachrichtigung",
    en: "HealthLog test notification",
    fr: "HealthLog notification de test",
    es: "HealthLog notificación de prueba",
    it: "HealthLog notifica di prova",
    pl: "HealthLog powiadomienie testowe",
  },
  "notifications.admin.testNotificationBody": {
    de: "Diese Test-Benachrichtigung wurde vom Admin-Panel ausgelöst. Wenn du sie siehst, funktioniert der Kanal.",
    en: "This test notification was triggered from the admin panel. If you can see it, the channel is working.",
    fr: "Cette notification de test a été déclenchée depuis le panneau d'administration. Si vous la voyez, le canal fonctionne.",
    es: "Esta notificación de prueba se activó desde el panel de administración. Si la ves, el canal funciona.",
    it: "Questa notifica di prova è stata attivata dal pannello di amministrazione. Se la vedi, il canale funziona.",
    pl: "To powiadomienie testowe zostało wywołane z panelu administracyjnego. Jeśli je widzisz, kanał działa.",
  },
  "notifications.admin.reminderCheckMissedTitle": {
    de: "Erinnerung verpasst: {medication}",
    en: "Reminder missed: {medication}",
    fr: "Rappel manqué : {medication}",
    es: "Recordatorio perdido: {medication}",
    it: "Promemoria perso: {medication}",
    pl: "Pominięte przypomnienie: {medication}",
  },
  "notifications.admin.reminderCheckMissedBody": {
    de: "{medication} ({dose}) im Zeitfenster {window} wurde nicht geloggt.",
    en: "{medication} ({dose}) was not logged in the {window} window.",
    fr: "{medication} ({dose}) n'a pas été enregistré dans la fenêtre {window}.",
    es: "{medication} ({dose}) no se registró en la ventana {window}.",
    it: "{medication} ({dose}) non è stato registrato nella finestra {window}.",
    pl: "{medication} ({dose}) nie zostało zarejestrowane w przedziale {window}.",
  },
  "notifications.admin.reminderCheckOverdueTitle": {
    de: "Einnahme überfällig: {medication}",
    en: "Dose overdue: {medication}",
    fr: "Prise en retard : {medication}",
    es: "Dosis atrasada: {medication}",
    it: "Dose in ritardo: {medication}",
    pl: "Dawka opóźniona: {medication}",
  },
  "notifications.admin.reminderCheckOverdueBody": {
    de: "{medication} ({dose}) im Zeitfenster {window} ist seit {minutes} Minuten überfällig.",
    en: "{medication} ({dose}) in the {window} window is {minutes} minutes overdue.",
    fr: "{medication} ({dose}) dans la fenêtre {window} est en retard de {minutes} minutes.",
    es: "{medication} ({dose}) en la ventana {window} lleva {minutes} minutos de retraso.",
    it: "{medication} ({dose}) nella finestra {window} è in ritardo di {minutes} minuti.",
    pl: "{medication} ({dose}) w przedziale {window} jest opóźnione o {minutes} minut.",
  },
  "notifications.user.telegramTestBody": {
    de: "HealthLog: Verbindung hergestellt. Telegram-Benachrichtigungen sind aktiv.",
    en: "HealthLog: connection successful. Telegram notifications are active.",
    fr: "HealthLog: connexion réussie. Les notifications Telegram sont actives.",
    es: "HealthLog: conexión correcta. Las notificaciones de Telegram están activas.",
    it: "HealthLog: connessione riuscita. Le notifiche Telegram sono attive.",
    pl: "HealthLog: połączenie udane. Powiadomienia Telegram są aktywne.",
  },
};

// Helper to insert a dotted-path key into a nested object, creating
// missing parents along the way.
function setKey(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in cur) || cur[part] == null || typeof cur[part] !== "object") {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function removeKey(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return false;
    cur = cur[parts[i]];
  }
  if (cur == null || typeof cur !== "object") return false;
  delete cur[parts[parts.length - 1]];
  return true;
}

function pruneEmptyContainers(obj) {
  if (obj == null || typeof obj !== "object") return false;
  let pruned = false;
  for (const k of Object.keys(obj)) {
    if (obj[k] != null && typeof obj[k] === "object" && !Array.isArray(obj[k])) {
      pruneEmptyContainers(obj[k]);
      if (Object.keys(obj[k]).length === 0) {
        delete obj[k];
        pruned = true;
      }
    }
  }
  return pruned;
}

const NOW_DEAD = [
  "charts.moodLabel1",
  "charts.moodLabel2",
  "charts.moodLabel3",
  "charts.moodLabel4",
  "charts.moodLabel5",
];

const locales = ["de", "en", "fr", "es", "it", "pl"];
for (const locale of locales) {
  const path = join(MESSAGES, `${locale}.json`);
  const data = JSON.parse(readFileSync(path, "utf8"));
  for (const [key, perLocale] of Object.entries(NEW_KEYS)) {
    setKey(data, key, perLocale[locale]);
  }
  for (const key of NOW_DEAD) {
    removeKey(data, key);
  }
  while (pruneEmptyContainers(data)) {
    // intentionally empty
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

console.log(`Added ${Object.keys(NEW_KEYS).length} keys × ${locales.length} locales.`);
console.log(`Retired ${NOW_DEAD.length} now-dead chart label keys.`);
