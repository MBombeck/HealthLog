import type { Metadata } from "next";
import Link from "next/link";

/**
 * v1.4.40 W-PRIVACY (SB-3) — Bilingual public privacy policy.
 *
 * Requirements driving this page:
 *
 *   1. **Apple App Store Connect** requires a publicly reachable Privacy-
 *      Policy URL before the iOS native app's first submission. The URL
 *      registered with ASC is this route on the maintainer's instance.
 *   2. **GDPR / DSGVO Art. 13 / 14 + Art. 15-22** — data-subject rights
 *      enumerated with concrete in-app routes the user can hit.
 *   3. **EU MDR 2017/745 + MDCG 2021-24** — the boundary "HealthLog is
 *      not a medical device" is stated next to the AI-Coach explanation,
 *      because that boundary is what keeps the Coach legally outside
 *      MDR scope. Mirrors GROUND RULES 9 + 15 in the Coach system prompt.
 *   4. **DACH-Recht** — German content paired with English on the same
 *      page so the document is reviewable by both a German DPA and an
 *      Apple US reviewer without locale switching. Standard bilingual
 *      Datenschutzerklärung layout: each section opens with the German
 *      text and is followed by the English translation under a labelled
 *      `<details>` so the German body reaches the fold first while the
 *      English version stays inline-reachable.
 *
 * Public route — listed in `src/proxy.ts` PUBLIC_PATHS and the
 * `<AuthShell>` PUBLIC_PATHS so an unauthenticated visitor (or App-Store
 * reviewer) lands directly on the content without an auth redirect.
 *
 * The bilingual body is inlined verbatim instead of routed through the i18n
 * provider, so the legal text itself never depends on client-side locale
 * state. The route is request-rendered because the edge CSP carries a fresh
 * nonce: a static document would freeze Next's inline streaming scripts
 * without that request nonce and strand visitors on the Suspense fallback.
 */

export const dynamic = "force-dynamic";

const POLICY_VERSION = "1.37.12";
const LAST_UPDATED = "2026-08-11";
const LAST_UPDATED_DATE = new Date(`${LAST_UPDATED}T12:00:00Z`);
// The date as each language writes it, on the line that language reads.
const LAST_UPDATED_DE = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "long",
  timeZone: "UTC",
}).format(LAST_UPDATED_DATE);
const LAST_UPDATED_EN = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeZone: "UTC",
}).format(LAST_UPDATED_DATE);

export const metadata: Metadata = {
  title: "Datenschutzerklärung / Privacy Policy | HealthLog",
  description:
    "Wie HealthLog personenbezogene Gesundheitsdaten verarbeitet, Auftragsverarbeiter, DSGVO-Rechte und die EU-MDR-Medizinprodukte-Grenze. Bilingual DE/EN.",
  robots: { index: true, follow: true },
};

interface SectionProps {
  id: string;
  numberLabel: string;
  titleDe: string;
  titleEn: string;
  /** German body (rendered first, visible by default). */
  bodyDe: React.ReactNode;
  /** English translation (rendered inside a labelled `<details>`). */
  bodyEn: React.ReactNode;
}

function Section({
  id,
  numberLabel,
  titleDe,
  titleEn,
  bodyDe,
  bodyEn,
}: SectionProps) {
  return (
    <section id={id} className="scroll-mt-28 space-y-4">
      {/* German first, like the body under it; the English title rides
          along so the scan spine still matches the English table of
          contents and the in-app link target. */}
      <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
        <span lang="de">{`${numberLabel}. ${titleDe}`}</span>
        <span className="text-muted-foreground" lang="en">
          {` / ${titleEn}`}
        </span>
      </h2>
      <div
        className="text-foreground space-y-3 text-sm leading-relaxed md:text-base"
        data-slot="privacy-section-de"
        lang="de"
      >
        <p className="text-foreground/80 text-xs font-medium tracking-wider uppercase">
          Deutsch
        </p>
        {bodyDe}
      </div>
      <details
        className="border-border/60 group bg-card/40 rounded-md border"
        data-slot="privacy-section-en"
      >
        <summary className="text-foreground hover:bg-muted/50 cursor-pointer list-none rounded-md px-3 py-2 text-xs font-medium tracking-wider uppercase select-none">
          English translation
          <span
            aria-hidden="true"
            className="text-muted-foreground ml-2 inline-block transition-transform group-open:rotate-90"
          >
            ›
          </span>
        </summary>
        <div
          className="text-foreground space-y-3 px-3 pb-3 text-sm leading-relaxed md:text-base"
          lang="en"
        >
          {bodyEn}
        </div>
      </details>
    </section>
  );
}

interface SubProcessorProps {
  name: string;
  roleDe: string;
  roleEn: string;
  dataDe: string;
  dataEn: string;
  locationDe: string;
  locationEn: string;
  policyUrl: string;
}

function SubProcessor({
  name,
  roleDe,
  roleEn,
  dataDe,
  dataEn,
  locationDe,
  locationEn,
  policyUrl,
}: SubProcessorProps) {
  return (
    <li className="border-border bg-card/40 space-y-2 rounded-md border p-3">
      <p className="text-foreground font-medium">{name}</p>
      <div className="space-y-1 text-sm" lang="de">
        <p>
          <span className="text-foreground font-medium">Rolle.</span> {roleDe}
        </p>
        <p>
          <span className="text-foreground font-medium">
            Übermittelte Daten.
          </span>{" "}
          {dataDe}
        </p>
        <p>
          <span className="text-foreground font-medium">Speicherort.</span>{" "}
          {locationDe}
        </p>
      </div>
      <div
        className="border-border/40 space-y-1 border-t pt-2 text-sm"
        lang="en"
      >
        <p>
          <span className="text-foreground font-medium">Role.</span> {roleEn}
        </p>
        <p>
          <span className="text-foreground font-medium">Data transferred.</span>{" "}
          {dataEn}
        </p>
        <p>
          <span className="text-foreground font-medium">Storage.</span>{" "}
          {locationEn}
        </p>
      </div>
      <p className="text-sm">
        <a
          href={policyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        >
          Datenschutzerklärung / Privacy policy
        </a>
      </p>
    </li>
  );
}

export default function PrivacyPage() {
  return (
    <div className="bg-background text-foreground min-h-dvh">
      {/* Top bar — visible home-link so an App-Store reviewer can confirm
          the policy belongs to the same brand as the iOS app. Public; no
          nav menu (this page is reachable without a session). */}
      <header className="border-border/60 bg-background/80 sticky top-0 z-10 border-b pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3 md:px-6">
          <Link
            href="/"
            className="text-foreground hover:text-primary inline-flex min-h-11 items-center text-sm font-semibold tracking-tight"
          >
            HealthLog
          </Link>
          <Link
            href="/auth/login"
            className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center text-sm"
          >
            <span lang="de">Anmelden</span>
          </Link>
        </div>
      </header>

      {/*
        v1.4.33 IW9 — `max-w-3xl` (768 px) is intentional. The legal /
        long-form column reads better at 70-80 chars per line; widening
        to the app shell's `max-w-screen-xl` would push line lengths to
        ~120 chars on a 1440 px laptop and degrade legibility. The same
        exception applies to `/about`.
      */}
      <main
        id="main-content"
        className="mx-auto max-w-3xl space-y-10 px-4 py-8 md:px-6 md:py-12"
      >
        <div className="space-y-3">
          <p className="text-muted-foreground text-xs tracking-wider uppercase">
            Policy version {POLICY_VERSION}
          </p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            <span lang="de">Datenschutzerklärung</span>{" "}
            <span className="text-muted-foreground" lang="en">
              / Privacy Policy
            </span>
          </h1>
          <p
            className="text-muted-foreground text-sm"
            data-slot="privacy-last-updated"
          >
            <time dateTime={LAST_UPDATED}>
              <span lang="de">Stand: {LAST_UPDATED_DE}</span>
              {" · "}
              <span lang="en">Last updated: {LAST_UPDATED_EN}</span>
            </time>
          </p>
          <p className="text-muted-foreground text-sm" lang="de">
            Diese Erklärung ist deutsch-englisch geführt. Jeder Abschnitt
            beginnt mit dem deutschen Text; die englische Übersetzung steht
            eingeklappt direkt darunter.
          </p>
        </div>

        {/* Collapsible TOC — default-closed so the policy's first
            paragraphs reach the fold on `<sm`; opens with one tap for
            skim navigation. */}
        <details
          className="border-border/60 bg-card/40 group rounded-md border"
          data-slot="privacy-toc"
        >
          <summary className="text-foreground hover:bg-muted/50 cursor-pointer list-none rounded-md px-4 py-3 text-sm font-medium select-none">
            Inhalt / Contents
            <span
              aria-hidden="true"
              className="text-muted-foreground ml-2 inline-block transition-transform group-open:rotate-90"
            >
              ›
            </span>
          </summary>
          <nav
            aria-label="Privacy policy contents"
            className="border-border/60 border-t px-4 py-3"
          >
            <ol className="text-muted-foreground space-y-1.5 text-sm leading-relaxed">
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#intro"
                >
                  1. Überblick / Overview
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#data-we-collect"
                >
                  2. Erhobene Daten / Data we collect
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#purpose"
                >
                  3. Zwecke der Verarbeitung / Why we collect each category
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#sub-processors"
                >
                  4. Auftragsverarbeiter / Third-party sub-processors
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#storage"
                >
                  5. Speicherung &amp; Speicherdauer / Data storage and
                  retention
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#rights"
                >
                  6. Ihre Rechte / Your rights (GDPR Art. 15-22, DSGVO)
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#medical-boundary"
                >
                  7. Medizinprodukte-Grenze / Medical-device boundary (EU MDR
                  2017/745, MDCG 2021-24)
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#apple-categories"
                >
                  8. Apple-App-Store- Datenschutzkategorien / Apple App Store
                  privacy categories
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#children"
                >
                  9. Kinder / Children
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#changes"
                >
                  10. Änderungen / Changes to this policy
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#contact"
                >
                  11. Kontakt / Contact
                </a>
              </li>
            </ol>
          </nav>
        </details>

        <Section
          id="intro"
          numberLabel="1"
          titleDe="Überblick"
          titleEn="Overview"
          bodyDe={
            <>
              <p>
                HealthLog ist eine quelloffene, selbst-hostbare Anwendung zur
                persönlichen Gesundheitsprotokollierung. Der Quellcode wird
                unter der PolyForm Noncommercial License 1.0.0 auf{" "}
                <a
                  href="https://github.com/MBombeck/HealthLog"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  github.com/MBombeck/HealthLog
                </a>{" "}
                veröffentlicht. Diese Erklärung beschreibt, wie die Instanz,
                über die Sie diese Seite abrufen, und die zugehörige
                iOS-Anwendung <em>HealthLog for iOS</em> (Bundle-ID{" "}
                <code className="bg-muted rounded px-1 py-0.5 text-xs">
                  dev.healthlog.app
                </code>
                ) personenbezogene Daten verarbeiten.
              </p>
              <p>
                Verantwortlicher im Sinne von Art. 4 Nr. 7 DSGVO ist der
                Betreiber dieser Instanz (Privatperson mit Sitz in Deutschland).
                Eigenständig betriebene, selbst-gehostete Instanzen unterliegen
                der Datenschutzerklärung ihres jeweiligen Betreibers; dieses
                Dokument gilt ausschließlich für diese Instanz.
              </p>
              <p>
                Für Fragen oder Datenschutz-Anfragen siehe Abschnitt 11
                (Kontakt).
              </p>
            </>
          }
          bodyEn={
            <>
              <p>
                HealthLog is an open-source, self-hostable
                personal-health-tracking application. Source code is published
                at{" "}
                <a
                  href="https://github.com/MBombeck/HealthLog"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  github.com/MBombeck/HealthLog
                </a>{" "}
                under the PolyForm Noncommercial License 1.0.0. This policy
                describes how the instance serving this page and the companion
                iOS application <em>HealthLog for iOS</em> (bundle identifier{" "}
                <code className="bg-muted rounded px-1 py-0.5 text-xs">
                  dev.healthlog.app
                </code>
                ) handle personal data.
              </p>
              <p>
                The controller under Art. 4 (7) GDPR is the operator of this
                instance (an individual based in Germany). Self-hosted
                deployments controlled by a different operator are governed by
                that operator&apos;s own privacy policy; this document applies
                only to this instance.
              </p>
              <p>
                For questions or data-subject requests, see section 11
                (Contact).
              </p>
            </>
          }
        />

        <Section
          id="data-we-collect"
          numberLabel="2"
          titleDe="Erhobene Daten"
          titleEn="Data we collect"
          bodyDe={
            <>
              <p>
                HealthLog speichert Beobachtungen, die der Nutzer selbst
                erfasst, sowie Gesundheitssignale, die der Nutzer ausdrücklich
                über eine Integration verbunden hat. Die folgenden Kategorien
                sind für den veröffentlichten Funktionsumfang abschließend.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.1 Konto und Authentifizierung
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Anzeigename und E-Mail-Adresse; optional ein vom Nutzer
                  ausgewähltes Profilbild.
                </li>
                <li>
                  Passwort-Hash (Argon2id; das Klartext-Passwort wird zu keinem
                  Zeitpunkt gespeichert oder protokolliert).
                </li>
                <li>
                  Optional: WebAuthn- / Passkey-Anmeldedaten (öffentlicher
                  Schlüssel, Credential-ID, Signaturzähler).
                </li>
                <li>
                  Sitzungskennungen (HTTP-only-Cookie im Web; opake API- Token
                  unter iOS, gespeichert im Geräte-Keychain).
                </li>
                <li>
                  Profil-Metadaten: Sprache, Zeitzone, Geburtsdatum (optional),
                  biologisches Geschlecht (optional), Körpergröße (optional) —
                  zur Berechnung altersgerechter Zielbereiche und des BMI.
                </li>
              </ul>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.2 Manuell erfasste Gesundheitsdaten
              </h3>
              <p>
                Jeder in den App-Formularen eingegebene Wert, einschließlich
                Zeitstempel, optionaler Notiz und Metrik-Typ. Die vollständige
                Aufzählung der unterstützten Metriken steht im OpenAPI-Schema;
                die nutzerrelevante Teilmenge umfasst Körpergewicht, Körperfett,
                Körpertemperatur, BMI (abgeleitet), Blutdruck (systolisch /
                diastolisch) und Puls (gepaarte Messung), Blutzucker mit Kontext
                (nüchtern / postprandial / zufällig / vor dem Schlafengehen) und
                wählbarer Einheit (mg/dL oder mmol/L), Ruhepuls, HRV (SDNN),
                VO₂max, Sauerstoffsättigung, Schlafdauer inkl. Pro-
                Stadien-Aufschlüsselung (Wach / REM / Core / Tief), Schritte,
                gelaufene oder gerannte Distanz, Aktive-Energie, gestiegene
                Stockwerke, Lärmpegel (Umgebung und Kopfhörer), Tageslicht-Zeit,
                Stimmung (Skala 1–5) mit optionaler Freitext-Notiz sowie
                Workouts (Sportart, Dauer, Distanz und optional GPS-Route,
                ausschließlich wenn der Nutzer eine Route anhängt).
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.3 Apple Health (iOS-Anwendung) — Datenfluss
              </h3>
              <p>
                Wenn der Nutzer der iOS-Anwendung Lesezugriff auf Apple
                HealthKit erteilt, liest HealthLog Stichproben der unten
                aufgeführten Identifier. Apple Health verwaltet HealthKit-Daten
                auf dem Gerät und kann sie nach den Apple-Einstellungen des
                Nutzers über dessen Apple-Konto synchronisieren. Das ist
                Apple-seitiges HealthKit-Verhalten und keine iCloud- oder
                CloudKit-Speicherung durch HealthLog. Die iOS-Anwendung
                überträgt relevante Stichproben über HTTPS (TLS 1.3,
                Zertifikat-Pinning) an den HealthLog-Server (Endpunkt{" "}
                <code className="bg-muted rounded px-1 py-0.5 text-xs">
                  POST /api/measurements
                </code>
                ), damit die Web-Oberfläche dieselben Verläufe darstellen kann
                wie das iPhone. HealthLog synchronisiert dabei die unterstützte
                Standarddarstellung der Herzfrequenz für Trends und
                Workout-Kontext. Das interne Experiment für einen ungefilterten
                Roh-Herzfrequenzstrom ist in dieser öffentlichen Version nicht
                verfügbar und wird nicht beworben oder erhoben. Eine Weitergabe
                an einen KI-Anbieter erfolgt nur über die separat aktivierten
                und eingewilligten Pfade in Abschnitt 2.7.
              </p>
              <p className="font-medium">HKQuantityTypeIdentifier:</p>
              <ul
                className="grid list-disc grid-cols-1 gap-x-6 gap-y-1 pl-5 sm:grid-cols-2"
                data-slot="privacy-hk-quantity"
              >
                <li>
                  <code className="text-xs break-all">bodyMass</code>
                </li>
                <li>
                  <code className="text-xs break-all">bodyFatPercentage</code>
                </li>
                <li>
                  <code className="text-xs break-all">bodyTemperature</code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    bloodPressureSystolic
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    bloodPressureDiastolic
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">bloodGlucose</code>
                </li>
                <li>
                  <code className="text-xs break-all">oxygenSaturation</code>
                </li>
                <li>
                  <code className="text-xs break-all">heartRate</code>
                </li>
                <li>
                  <code className="text-xs break-all">restingHeartRate</code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    heartRateVariabilitySDNN
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">vo2Max</code>
                </li>
                <li>
                  <code className="text-xs break-all">stepCount</code>
                </li>
                <li>
                  <code className="text-xs break-all">activeEnergyBurned</code>
                </li>
                <li>
                  <code className="text-xs break-all">flightsClimbed</code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    distanceWalkingRunning
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    environmentalAudioExposure
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    headphoneAudioExposure
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">timeInDaylight</code> (iOS
                  17+)
                </li>
              </ul>
              <p className="font-medium">HKCategoryTypeIdentifier:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <code className="text-xs break-all">sleepAnalysis</code> — mit
                  voller Pro-Stadien-Granularität (Awake, REM, Core, Deep). Die
                  Stadien werden serverseitig als separate Zeilen abgelegt,
                  damit das Diagramm sie stapeln kann.
                </li>
              </ul>
              <p>
                Schreibzugriff wird für eine Teilmenge angefordert (Körpermasse,
                Blutdruck systolisch / diastolisch, Blutzucker), damit manuelle
                Einträge in der iOS-App zurück nach HealthKit fließen können.
                Der Nutzer steuert beide Richtungen über die
                Berechtigungsoberfläche der iOS- Health-App und kann jederzeit
                widerrufen.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.4 Withings-Synchronisation (optional)
              </h3>
              <p>
                Verbindet der Nutzer ein Withings-Konto, speichert HealthLog die
                OAuth-Refresh- und -Access-Token (spaltenweise verschlüsselt)
                sowie die Withings-Nutzerkennung. Webhook-getriebene
                Folgesynchronisierungen ziehen Körpergewicht, Fettanteil,
                fettfreie Masse, Muskelmasse, Knochenmasse, Wassergehalt,
                Magermasse, Hydration, Blutdruck (systolisch / diastolisch) und
                Puls, Blutzucker, Körpertemperatur (Basal- und Hauttemperatur),
                Aktivitätssummen (Schritte, Distanz, aktive Kalorien),
                Schlafsitzungen mit Pro-Stadien-Segmenten (Awake / Light / Deep
                / REM) sowie SpO₂ und Herzfrequenzvariabilität, soweit
                vorhanden.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.5 Medikamente
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Aktive Verordnungen: Wirkstoffname, Stärke, Verabreichungsweg,
                  Einnahmeplan, Behandlungsklasse (Standard oder GLP-1).
                </li>
                <li>
                  Einnahme-Ereignisse: geplante Zeit, tatsächliche Zeit, Status
                  (eingenommen, ausgelassen, verpasst).
                </li>
                <li>
                  Bei GLP-1-Therapien: Dosis-Änderungs-Historie, Injektions-
                  Ereignisse mit optionaler Injektionsstelle und Pen- Kennung,
                  Nebenwirkungs-Protokolle entlang einer fixen Taxonomie,
                  Pen-und-Ampullen-Inventar mit 30-Tage-In- Use-Uhr.
                </li>
              </ul>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.6 Dokumente, Scans und lokale Texterkennung
              </h3>
              <p>
                Ein Profilbild sowie für den Dokumententresor ausdrücklich
                ausgewählte Fotos, Scans und PDFs werden zum HealthLog-Server
                hochgeladen und dem Konto zugeordnet. Beim Schnell-Erfassen von
                Medikamenten oder Laborwerten bleibt das Quellbild dagegen auf
                dem Gerät: Apple Vision erkennt Text lokal, und nur die vom
                Nutzer geprüften, bearbeiteten und bestätigten Zeilen werden an
                den Server gesendet. Das gilt nicht automatisch als Upload in
                den Dokumententresor.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.7 KI-Pfade, Ziele und Einwilligung
              </h3>
              <p>
                Externe KI ist standardmäßig deaktiviert. Vor der ersten
                Übertragung nennt die App das konkrete Ziel und die Kategorien:
                die Frage oder Anweisung des Nutzers, Gesundheitskontext,
                jüngste Beobachtungen oder Aggregate, Zielbereiche und optional
                Medikamenten-, Labor- oder Dokumentkontext. Der Server
                normalisiert HealthKit-Daten; rohe HealthKit-Identifier und rohe
                Sample-IDs gehören nicht zum Coach-Snapshot.
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong>Server-verwaltet:</strong> Die Daten gehen zuerst an
                  den konfigurierten HealthLog-Server und von dort an dessen
                  eingerichtetes Anthropic-, OpenAI-, lokales, ChatGPT-OAuth-
                  oder generisch OpenAI-kompatibles Ziel. Ein lokales oder
                  generisches Ziel wird vom Betreiber festgelegt und kann einer
                  eigenen Datenschutz- und Speicherrichtlinie unterliegen.
                </li>
                <li>
                  <strong>Eigener Schlüssel (BYO):</strong> Das iPhone sendet
                  direkt an OpenAI, Anthropic, Google Gemini oder einen vom
                  Nutzer angegebenen HTTPS-Endpunkt mit OpenAI-kompatibler API.
                  Der API-Schlüssel bleibt im iOS-Keychain und wird nicht an den
                  HealthLog-Server gesendet.
                </li>
                <li>
                  <strong>Auf dem Gerät:</strong> Apple Foundation Models und
                  die lokale Texterkennung senden Bild, Prompt und Ergebnis an
                  keinen Drittanbieter in der Cloud. Ein ausdrücklich gewählter
                  Netzwerk-Endpunkt ist dagegen kein reiner On-Device-Pfad und
                  wird vor Verwendung als Ziel angezeigt.
                </li>
              </ul>
              <p>
                Bei Dokumenten können Vorschlag, Zusammenfassung und Index nach
                Einwilligung das gespeicherte Originalbild bzw. PDF oder den
                erkannten Text verarbeiten. Der Dokument-Chat sendet die Frage
                des Nutzers zusammen mit dem indexierten Kontext des gewählten
                Dokuments und streamt eine darauf gestützte Antwort zurück. Die
                Freigabe gilt nicht für andere Ziele. Unter{" "}
                <em>Einstellungen → Assistent</em> kann der Nutzer externe KI
                ausschalten oder den Anbieter wechseln; damit werden weitere
                Server-Anfragen blockiert. Beim BYO-Pfad entfernt der Widerruf
                zusätzlich Schlüssel und Freigabe für diesen Anbieter.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.8 Einwilligungsnachweis (Consent Receipt)
              </h3>
              <p>
                Der Server hält für server-verwaltete KI einen kontogebundenen
                Einwilligungsnachweis mit Art, signiertem Zeitpunkt und
                Artefakt. Der aktuelle Status ist über{" "}
                <code className="bg-muted rounded px-1 py-0.5 text-xs">
                  GET /api/consent/ai/latest
                </code>{" "}
                abrufbar. Ein Widerruf wird mit Zeitstempel festgehalten und
                blockiert zukünftige externe Verarbeitung. Diese Nachweise
                werden als Teil des Konto-Auditverlaufs aufbewahrt und bei der
                Konto-Löschung kaskadiert gelöscht; es gibt keinen belegten
                separaten festen Fünf-Jahres-Löschjob.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.9 Geräte- und Integrations-Metadaten, Push
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Geräte-Kennung (zufällige UUID, clientseitig erzeugt und im
                  iOS-Keychain gespeichert), übermittelt als{" "}
                  <code className="bg-muted rounded px-1 py-0.5 text-xs">
                    X-Device-Id
                  </code>{" "}
                  -Header — für Mehrgeräte-Synchronisation und
                  Missbrauchsschutz.
                </li>
                <li>
                  Apple-Push-Notification-Service-(APNs)-Geräte-Token und
                  Umgebung (sandbox / production), ausschließlich bei
                  aktivierten Push-Benachrichtigungen.
                </li>
                <li>
                  Telegram-Chat-Kennung — nur, wenn der Nutzer die optionale
                  Telegram-Bot-Benachrichtigung verbunden hat.
                </li>
              </ul>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.10 Sicherheits- und Audit-Logs
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Authentifizierungs- und Konto-Ereignisse für Sicherheit,
                  Missbrauchsschutz und Nachvollziehbarkeit. Die Instanz löscht
                  Audit-Zeilen täglich nach ihrem konfigurierten Fenster; der
                  Server-Standard beträgt 365 Tage und kann vom Betreiber
                  geändert werden.
                </li>
                <li>
                  Server- und Reverse-Proxy-Zugriffsprotokolle werden nur für
                  Betrieb, Missbrauchsschutz und Fehlersuche benötigt und nach
                  der aktiven Log-Rotation des Betreibers gelöscht. Diese
                  Codebasis belegt kein festes 14-Tage-Fenster für die
                  Produktions-Infrastruktur.
                </li>
                <li>
                  Push-Zustellversuche aller aktivierten Kanäle enthalten Kanal,
                  Ereignistyp, Ergebnis und Fehlerklasse, aber keinen
                  Roh-Gesundheitswert. Ein täglicher Job löscht sie nach 90
                  Tagen.
                </li>
              </ul>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.11 Nicht erhobene Daten
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Keine Werbe-Identifier, Fingerprints oder
                  anwendungsübergreifenden Tracker.
                </li>
                <li>Keine Zahlungsdaten (es gibt keinen Bezahltarif).</li>
                <li>
                  Keine fortlaufende Hintergrund-Standortermittlung — GPS-Routen
                  nur, wenn der Nutzer sie einem Workout ausdrücklich beifügt.
                </li>
                <li>
                  Keine Social-Network-Kennungen und kein Kontaktlisten-
                  Abgleich.
                </li>
                <li>
                  Keine clientseitigen Produkt-Analytics; die Instanz liefert
                  kein Analytics-SDK aus.
                </li>
              </ul>
            </>
          }
          bodyEn={
            <>
              <p>
                HealthLog is designed to record observations the user enters
                themselves and to consume health signals the user has explicitly
                connected through a third-party integration. The categories
                below are exhaustive for the released feature set.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.1 Account and authentication
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Display name and email address; optionally, a profile image
                  selected by the user.
                </li>
                <li>
                  Password hash (Argon2id; the plain-text password is never
                  stored or logged).
                </li>
                <li>
                  Optional WebAuthn / passkey credentials (public key,
                  credential ID, sign counter).
                </li>
                <li>
                  Session identifiers (HTTP-only cookie on the web; opaque API
                  tokens on iOS, stored in the device Keychain).
                </li>
                <li>
                  Profile metadata: locale, timezone, date of birth (optional),
                  gender (optional, one of male, female or other), height
                  (optional) — used to compute age-adjusted target ranges and
                  BMI.
                </li>
              </ul>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.2 Manually entered health data
              </h3>
              <p>
                Any value entered through the in-app forms, including timestamp,
                optional note, and metric type: body weight, body-fat
                percentage, body temperature, BMI (derived), blood pressure
                (systolic / diastolic) and pulse rate as paired readings, blood
                glucose with context (fasting, postprandial, random, bedtime)
                and configurable unit (mg/dL or mmol/L), resting heart rate,
                heart-rate variability (SDNN), VO₂ max, oxygen saturation, sleep
                duration with per-stage breakdown (Awake / REM / Core / Deep),
                step count, distance walked or run, active-energy burned,
                flights climbed, environmental and headphone audio-exposure
                levels, time in daylight, mood (1-5 scale) with optional
                free-text note, and workout sessions (activity type, duration,
                distance, and an optional GPS route attached manually by the
                user).
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.3 Apple Health (iOS application) — data flow
              </h3>
              <p>
                When the user grants the iOS application read access to Apple
                HealthKit, HealthLog reads samples for the identifiers listed
                below. Apple Health manages HealthKit data on the device and may
                sync it through the user&apos;s Apple account according to Apple
                platform settings. That is Apple-managed HealthKit behaviour,
                not iCloud or CloudKit storage by HealthLog. The iOS application
                copies relevant samples to the HealthLog server over HTTPS (TLS
                1.3, certificate pinning) via{" "}
                <code className="bg-muted rounded px-1 py-0.5 text-xs">
                  POST /api/measurements
                </code>{" "}
                so the web surface can render the same trends as the iPhone.
                HealthLog syncs the supported default heart-rate representation
                used for trends and workout context. The internal unfiltered
                raw-heart-rate experiment is unavailable in this public build;
                it is neither advertised nor collected. Transit to an AI
                provider occurs only through the separately enabled and
                consented paths in section 2.7.
              </p>
              <p className="font-medium">HKQuantityTypeIdentifier:</p>
              <ul
                className="grid list-disc grid-cols-1 gap-x-6 gap-y-1 pl-5 sm:grid-cols-2"
                data-slot="privacy-hk-quantity-en"
              >
                <li>
                  <code className="text-xs break-all">bodyMass</code>
                </li>
                <li>
                  <code className="text-xs break-all">bodyFatPercentage</code>
                </li>
                <li>
                  <code className="text-xs break-all">bodyTemperature</code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    bloodPressureSystolic
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    bloodPressureDiastolic
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">bloodGlucose</code>
                </li>
                <li>
                  <code className="text-xs break-all">oxygenSaturation</code>
                </li>
                <li>
                  <code className="text-xs break-all">heartRate</code>
                </li>
                <li>
                  <code className="text-xs break-all">restingHeartRate</code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    heartRateVariabilitySDNN
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">vo2Max</code>
                </li>
                <li>
                  <code className="text-xs break-all">stepCount</code>
                </li>
                <li>
                  <code className="text-xs break-all">activeEnergyBurned</code>
                </li>
                <li>
                  <code className="text-xs break-all">flightsClimbed</code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    distanceWalkingRunning
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    environmentalAudioExposure
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">
                    headphoneAudioExposure
                  </code>
                </li>
                <li>
                  <code className="text-xs break-all">timeInDaylight</code> (iOS
                  17+)
                </li>
              </ul>
              <p className="font-medium">HKCategoryTypeIdentifier:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <code className="text-xs break-all">sleepAnalysis</code> —
                  with full per-stage granularity (Awake, REM, Core, Deep).
                  Stages are stored server-side as separate rows so the chart
                  can stack them.
                </li>
              </ul>
              <p>
                Write access is requested for a subset (body mass,
                blood-pressure systolic / diastolic, blood glucose) so that
                manual entries made inside the iOS app can flow back into
                HealthKit. The user controls both directions in the iOS Health
                app&apos;s permission surface and may revoke at any time.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.4 Withings sync (optional)
              </h3>
              <p>
                When the user connects a Withings account, HealthLog stores the
                OAuth refresh and access tokens (encrypted at the column level)
                and the user&apos;s Withings identifier. Subsequent
                webhook-driven syncs pull body weight, fat ratio, fat-free mass,
                muscle mass, bone mass, water mass, lean mass, hydration, blood
                pressure (systolic / diastolic) and pulse, blood glucose
                readings, body temperature (basal and skin), activity totals
                (steps, distance, active calories), sleep sessions with
                per-stage segments (Awake / Light / Deep / REM), and SpO₂ + HRV
                where available.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.5 Medications
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Active prescriptions: drug name, strength, route, schedule,
                  treatment-class flag (standard or GLP-1).
                </li>
                <li>
                  Intake events: scheduled time, actual time, status (taken,
                  skipped, missed).
                </li>
                <li>
                  For GLP-1 treatments: dose-change history, injection events
                  with optional injection site and pen identifier, side-effect
                  logs against a fixed taxonomy, pen-and-vial inventory with a
                  30-day in-use clock.
                </li>
              </ul>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.6 Documents, scans, and local text recognition
              </h3>
              <p>
                A profile image and photos, scans, or PDFs explicitly selected
                for the document vault are uploaded to the HealthLog server and
                linked to the account. Medication and lab quick-entry work
                differently: Apple Vision recognises text on the device, the
                source image is not uploaded, and only rows the user reviews,
                edits, and confirms are sent to the server. Quick entry does not
                automatically save the source image in the document vault.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.7 AI paths, destinations, and consent
              </h3>
              <p>
                External AI is off by default. Before the first transmission,
                the app identifies the destination and categories: the
                user&apos;s question or instruction, health context, recent
                observations or aggregates, target ranges, and optional
                medication, lab, or document context. The server normalises
                HealthKit data; raw HealthKit identifiers and raw sample IDs are
                not part of a Coach snapshot.
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong>Server-managed:</strong> data first reaches the
                  configured HealthLog server and is then sent to that
                  server&apos;s configured Anthropic, OpenAI, local, ChatGPT
                  OAuth, or generic OpenAI-compatible destination. A local or
                  generic destination is chosen by the operator and may have its
                  own privacy and retention policy.
                </li>
                <li>
                  <strong>Bring your own key (BYO):</strong> the iPhone sends
                  directly to OpenAI, Anthropic, Google Gemini, or a
                  user-specified HTTPS OpenAI-compatible endpoint. The API key
                  remains in the iOS Keychain and is not sent to the HealthLog
                  server.
                </li>
                <li>
                  <strong>On device:</strong> Apple Foundation Models and local
                  text recognition do not send the image, prompt, or result to a
                  third-party cloud provider. An explicitly selected network
                  endpoint is not an on-device path and is identified before
                  use.
                </li>
              </ul>
              <p>
                For documents, suggest, summary, and index operations may
                process the stored original image or PDF, or recognised text,
                after consent. Per-document chat sends the user&apos;s question
                with indexed context from the selected document and streams a
                grounded answer back. Consent does not transfer to a different
                destination. The user can disable external AI or change the
                provider under <em>Settings → Assistant</em>; this blocks future
                server requests. For BYO, revocation also removes that
                provider&apos;s key and grant.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.8 Consent receipt persistence
              </h3>
              <p>
                For server-managed AI, the server keeps an account-bound consent
                receipt with its kind, signed time, and artefact. The current
                state is available through{" "}
                <code className="bg-muted rounded px-1 py-0.5 text-xs">
                  GET /api/consent/ai/latest
                </code>
                . Withdrawal is timestamped and blocks future external
                processing. Receipts remain part of the account audit trail and
                are cascade-deleted with the account; no separate fixed
                five-year cleanup job is evidenced by the server source.
              </p>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.9 Device and integration metadata, push
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  A device identifier (random UUID generated client-side, stored
                  in the iOS Keychain) sent as the{" "}
                  <code className="bg-muted rounded px-1 py-0.5 text-xs">
                    X-Device-Id
                  </code>{" "}
                  request header — used for multi-device sync and abuse
                  prevention.
                </li>
                <li>
                  Apple Push Notification service (APNs) device token and
                  environment flag (sandbox / production), recorded only when
                  the user enables push notifications.
                </li>
                <li>
                  Telegram chat identifier — only when the user has explicitly
                  connected the optional Telegram-bot notifier.
                </li>
              </ul>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.10 Security and audit
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Authentication and account events used for security, abuse
                  prevention, and accountability. The instance removes audit
                  rows daily according to its configured window; the server
                  default is 365 days and the operator may change it.
                </li>
                <li>
                  Server and reverse-proxy access logs are needed only for
                  operations, abuse prevention, and debugging, and are removed
                  under the operator&apos;s active log-rotation policy. This
                  source tree does not evidence a fixed 14-day production
                  window.
                </li>
                <li>
                  Push-delivery attempts for every enabled channel store the
                  channel, event type, result, and error class, but no raw
                  health value. A daily job removes them after 90 days.
                </li>
              </ul>
              <h3 className="text-foreground pt-2 text-base font-semibold">
                2.11 Data we do not collect
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  No third-party advertising identifiers, fingerprints, or
                  cross-app tracking.
                </li>
                <li>
                  No payment information (the application has no paid tier).
                </li>
                <li>
                  No precise background location (workouts only carry GPS when
                  the user attaches a route).
                </li>
                <li>No social-network identifiers or contact-list scrapes.</li>
                <li>
                  No third-party product analytics. The instance does not ship a
                  client-side analytics SDK.
                </li>
              </ul>
            </>
          }
        />

        <Section
          id="purpose"
          numberLabel="3"
          titleDe="Zwecke der Verarbeitung"
          titleEn="Why we collect each category"
          bodyDe={
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <span className="text-foreground font-medium">
                  Authentifizierungsdaten
                </span>{" "}
                — Identifikation des Nutzers und Sicherung der Sitzung.
                Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung).
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Gesundheitsdaten
                </span>{" "}
                — Darstellung von Verläufen, Berechnung der Zielwerte- Treue,
                Erzeugung des Coach-Snapshots auf Abruf. Rechtsgrundlage: Art. 9
                Abs. 2 lit. a DSGVO (ausdrückliche Einwilligung für Daten
                besonderer Kategorien).
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Coach-Snapshots
                </span>{" "}
                — Erzeugung personalisierter schriftlicher Rückmeldungen. Das
                Bündel wird nur für die Dauer der Anfrage an den konfigurierten
                KI-Anbieter übertragen.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Geräte-Daten
                </span>{" "}
                — Push-Benachrichtigungen, Missbrauchsschutz, Mehrgeräte-
                Sitzungshygiene.
              </li>
              <li>
                <span className="text-foreground font-medium">Audit-Logs</span>{" "}
                — Sicherheits-Forensik und Rate-Limit. Rechtsgrundlage: Art. 6
                Abs. 1 lit. f DSGVO (berechtigtes Interesse am sicheren
                Betrieb).
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Produkt-Analytics
                </span>{" "}
                — werden nicht erhoben.
              </li>
            </ul>
          }
          bodyEn={
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <span className="text-foreground font-medium">
                  Authentication data
                </span>{" "}
                — identifying the user and securing the session. Legal basis:
                GDPR Art. 6 (1) (b) performance of contract.
              </li>
              <li>
                <span className="text-foreground font-medium">Health data</span>{" "}
                — displaying trends, computing target adherence, generating the
                Coach context bundle when the user invokes it. Legal basis: GDPR
                Art. 9 (2) (a) explicit consent for special-category data.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Coach context bundles
                </span>{" "}
                — generating personalised written feedback. The bundle is
                transmitted to the configured AI provider for the duration of
                the request only.
              </li>
              <li>
                <span className="text-foreground font-medium">Device data</span>{" "}
                — push notifications, abuse prevention, multi-device session
                hygiene.
              </li>
              <li>
                <span className="text-foreground font-medium">Audit logs</span>{" "}
                — security-event tracing and rate-limiting. Legal basis: GDPR
                Art. 6 (1) (f) legitimate interest in operating the service
                securely.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Product analytics
                </span>{" "}
                — none collected.
              </li>
            </ul>
          }
        />

        <Section
          id="sub-processors"
          numberLabel="4"
          titleDe="Auftragsverarbeiter und Drittanbieter"
          titleEn="Third-party sub-processors"
          bodyDe={
            <>
              <p>
                Folgende benannte Anbieter können personenbezogene Daten für
                aktivierte Funktionen verarbeiten. Zusätzlich kann ein Betreiber
                oder BYO-Nutzer einen lokalen oder generischen HTTPS-Endpunkt
                mit OpenAI-kompatibler API festlegen. Für ein solches nutzer-
                oder betreiberdefiniertes Ziel gelten dessen eigene Angaben zu
                Verantwortlichkeit, Ort und Speicherdauer; deshalb ist die Liste
                nicht als abschließend für frei konfigurierbare Ziele zu
                verstehen.
              </p>
              <p className="text-xs">
                Die englische Übersetzung enthält die detaillierte Auflistung
                pro Anbieter mit Rolle, übermittelten Daten, Speicherort und
                Link zur Datenschutzerklärung.
              </p>
            </>
          }
          bodyEn={
            <>
              <p>
                The named providers below may process personal data for enabled
                features. An operator or BYO user may also configure a local or
                generic HTTPS endpoint with an OpenAI-compatible API. That user-
                or operator-specified destination is governed by its own
                controller, location, and retention terms, so this list is not
                exhaustive for freely configurable destinations.
              </p>
              <ul className="grid gap-3">
                <SubProcessor
                  name="Anthropic, PBC"
                  roleDe="KI-Coach- und Insights-Anbieter, wenn der Nutzer Anthropic Claude in den Einstellungen wählt."
                  roleEn="AI Coach and Insights provider when the user selects Anthropic Claude in settings."
                  dataDe="Coach-Snapshot-Bündel (Gesundheits-Kontext) für die Dauer der Anfrage."
                  dataEn="Coach snapshot bundle (health-data context) for the duration of the request."
                  locationDe="USA. Die Speicherdauer richtet sich nach dem für den verwendeten Anthropic-Zugang geltenden Vertrag und der verlinkten aktuellen Richtlinie."
                  locationEn="United States. Retention follows the contract and current linked policy applicable to the Anthropic access in use."
                  policyUrl="https://www.anthropic.com/legal/privacy"
                />
                <SubProcessor
                  name="OpenAI, L.L.C."
                  roleDe="Alternativer KI-Coach- und Insights-Anbieter, wenn der Nutzer ein OpenAI-Modell wählt."
                  roleEn="Alternative AI Coach and Insights provider when the user selects an OpenAI model in settings."
                  dataDe="Coach-Snapshot-Bündel, gleiche Struktur wie bei Anthropic."
                  dataEn="Coach snapshot bundle, same shape as the Anthropic variant."
                  locationDe="USA. Die Speicherdauer richtet sich nach dem für den verwendeten OpenAI- oder ChatGPT-OAuth-Zugang geltenden Vertrag und der verlinkten aktuellen Richtlinie."
                  locationEn="United States. Retention follows the contract and current linked policy applicable to the OpenAI or ChatGPT OAuth access in use."
                  policyUrl="https://openai.com/policies/privacy-policy"
                />
                <SubProcessor
                  name="Google LLC"
                  roleDe="Optionales direktes BYO-Ziel, wenn der Nutzer Google Gemini mit eigenem Schlüssel auswählt."
                  roleEn="Optional direct BYO destination when the user selects Google Gemini with their own key."
                  dataDe="Nutzerfrage sowie der vor der Übertragung angezeigte Gesundheits-, Medikamenten-, Labor- oder Dokumentkontext."
                  dataEn="User prompt and the health, medication, lab, or document context disclosed before transmission."
                  locationDe="Vom gewählten Google-Dienst abhängig. Speicherdauer und Region richten sich nach dem Gemini-Zugang des Nutzers und der verlinkten aktuellen Richtlinie."
                  locationEn="Depends on the selected Google service. Retention and region follow the user's Gemini access and the current linked policy."
                  policyUrl="https://policies.google.com/privacy"
                />
                <SubProcessor
                  name="Withings SAS"
                  roleDe="Wearable-Synchronisation, wenn der Nutzer ein Withings-Konto verbindet."
                  roleEn="Wearable-device data sync when the user connects a Withings account."
                  dataDe="OAuth-Refresh- und -Access-Token, Withings-Nutzerkennung, Webhook-Benachrichtigungen über neue Messungen."
                  dataEn="OAuth refresh and access tokens, Withings user identifier, webhook notifications about new measurements."
                  locationDe="Frankreich (Europäische Union)."
                  locationEn="France (European Union)."
                  policyUrl="https://www.withings.com/de/de/legal/privacy-policy"
                />
                <SubProcessor
                  name="Apple, Inc."
                  roleDe="HealthKit (lokal auf dem Gerät) und Apple Push Notification service (APNs, bei aktivierten Benachrichtigungen)."
                  roleEn="Apple-managed HealthKit on the device and Apple Push Notification service (APNs) when notifications are enabled."
                  dataDe="HealthKit-Zugriff bleibt lokal. APNs empfängt Geräte-Token, Bundle-ID und Notification-Payload."
                  dataEn="HealthKit access is local to the device. APNs receives a device token, the application bundle identifier, and the notification payload."
                  locationDe="Apple verwaltet HealthKit-Daten nach den Apple-Konto- und Health-Einstellungen des Nutzers. Das ist keine iCloud- oder CloudKit-Speicherung durch HealthLog."
                  locationEn="Apple manages HealthKit data under the user's Apple-account and Health settings. This is not iCloud or CloudKit storage by HealthLog."
                  policyUrl="https://www.apple.com/legal/privacy/"
                />
                <SubProcessor
                  name="Telegram FZ-LLC"
                  roleDe="Optionaler Benachrichtigungskanal, wenn der Nutzer die Telegram-Bot-Integration verbindet."
                  roleEn="Optional notification channel when the user enables the Telegram-bot integration."
                  dataDe="Telegram-Chat-Kennung und Notification-Payload."
                  dataEn="Telegram chat identifier and the notification payload."
                  locationDe="Vereinigte Arabische Emirate / globale Telegram-Infrastruktur."
                  locationEn="United Arab Emirates / Telegram global infrastructure."
                  policyUrl="https://telegram.org/privacy"
                />
                <SubProcessor
                  name="GitHub, Inc."
                  roleDe="Hosting des Open-Source-Repositories und Issue-Tracker als Support-Kanal."
                  roleEn="Hosting of the open-source repository and the issue tracker used as the support channel."
                  dataDe="Issue-Inhalte und freiwillige Anhänge. Bitte keine personenbezogenen Daten in öffentlichen Issues posten; nach der ersten Antwort wird ein privater Kanal angeboten."
                  dataEn="Issue contents and any voluntary attachments. Avoid posting personal data in public issues; the operator offers a private channel after the first response."
                  locationDe="USA."
                  locationEn="United States."
                  policyUrl="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"
                />
                <SubProcessor
                  name="Cloudflare, Inc."
                  roleDe="Autoritative DNS-Auflösung für die Domain dieser Instanz. Die Anwendung selbst steht nicht hinter dem Cloudflare-Proxy."
                  roleEn="Authoritative DNS for this instance's domain. The application itself is not behind the Cloudflare proxy; only the DNS resolution path is."
                  dataDe="Quell-IP und User-Agent zum Zeitpunkt der Auflösung."
                  dataEn="Source IP address and user-agent at resolution time."
                  locationDe="USA; globales Anycast-Netz von Cloudflare."
                  locationEn="United States; Cloudflare's standard global anycast network."
                  policyUrl="https://www.cloudflare.com/privacypolicy/"
                />
                <SubProcessor
                  name="Hetzner Online GmbH"
                  roleDe="Hardware-Hoster für Anwendungsserver und PostgreSQL-Datenbank."
                  roleEn="Hardware host for the application server and the PostgreSQL database."
                  dataDe="Festplatten- und Netzwerkverkehr zwischen den vom Betreiber kontrollierten virtuellen Maschinen und dem öffentlichen Internet."
                  dataEn="Disk and network traffic between the operator-controlled virtual machines and the public internet."
                  locationDe="Deutschland (Europäische Union). Sämtliche HealthLog-Anwendungsdaten liegen auf Hetzner-Infrastruktur unter deutscher Gerichtsbarkeit."
                  locationEn="Germany (European Union). All HealthLog application data lives on Hetzner-hosted infrastructure under German jurisdiction."
                  policyUrl="https://www.hetzner.com/legal/privacy-policy"
                />
              </ul>
            </>
          }
        />

        <Section
          id="storage"
          numberLabel="5"
          titleDe="Speicherung, Speicherdauer und Verschlüsselung"
          titleEn="Data storage and retention"
          bodyDe={
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <span className="text-foreground font-medium">
                  Serverstandort
                </span>{" "}
                — primäre Datenhaltung in einer PostgreSQL-Datenbank auf
                Hetzner-Infrastruktur in Deutschland; die Anwendung wird vom
                Betreiber als Privatperson in Deutschland verant- wortet. Außer
                den unter Abschnitt 4 genannten Anbietern ist keine weitere
                Drittspeicherung beteiligt.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Verschlüsselung im Transit
                </span>{" "}
                — TLS 1.3 mit HSTS auf allen öffentlichen Endpunkten; die
                iOS-Anwendung pinnt zusätzlich das TLS-Zertifikat.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Verschlüsselung im Ruhezustand
                </span>{" "}
                — verschlüsselte Festplatten; sensible Spalten (Auth- Token,
                Integrations-Secrets) zusätzlich auf Spaltenebene mit einem
                separaten Schlüssel verschlüsselt.
              </li>
              <li>
                <span className="text-foreground font-medium">Backups</span> —
                sofern der Betreiber die optionale Off-Host-Sicherung aktiviert,
                werden tägliche Konto-Exporte mit einem separaten
                AES-256-GCM-Schlüssel in einen S3-kompatiblen Objektspeicher
                geschrieben. Die Aufbewahrung wird vom Betreiber und der
                kanonischen Bucket-Lifecycle-Regel festgelegt; die Codebasis
                kann die aktuell eingesetzte Produktionsregel nicht belegen.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Gesundheitsdaten
                </span>{" "}
                — kontobezogene Messungen bleiben bis zur Nutzerlöschung oder
                Konto-Löschung erhalten, soweit kein typbezogener
                Verdichtungsjob greift. Rohe dichte Herzfrequenz-, HRV- und
                Sauerstoffsättigungs-Stichproben werden nach 90 Tagen zu
                stündlichen Mittelwerten verdichtet; Tages-Rollups bewahren
                Mittelwert und Extremwerte. Es gibt keinen belegten globalen
                Fünf-Jahres-Löschjob für alle Messungen.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Betriebs- und Einwilligungsdaten
                </span>{" "}
                — Audit-Logs werden täglich nach dem konfigurierten Fenster
                gelöscht (Server-Standard: 365 Tage). Push-Zustellversuche
                werden täglich nach 90 Tagen gelöscht. Server- und
                Reverse-Proxy-Logs folgen der aktiven Log-Rotation des
                Betreibers. Einwilligungsnachweise bleiben im Konto-Auditverlauf
                bis zur Konto-Löschung. Für externe KI-Anfragen gilt die
                Richtlinie des vor der Übertragung genannten Anbieters oder
                Endpunktbetreibers.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Kein HealthLog-iCloud-Speicher
                </span>{" "}
                — HealthLog speichert Server-Datenbank, lokale
                Gesundheits-Caches, Offline-Outbox, ECG- und Workout-Payloads,
                KI-Transkript-Cache, Medikamentenplaner-Datenbank sowie Widget-
                und Watch-Snapshots weder in iCloud noch in CloudKit. Lokale
                gesundheitsbezogene Speicher liegen in geschütztem App- oder
                App-Group-Speicher, deaktivieren CloudKit soweit anwendbar und
                sind ausdrücklich vom Geräte-Backup ausgeschlossen. Eine
                mögliche Apple-Health-Synchronisation ist davon getrennt und
                wird allein von Apple verwaltet.
              </li>
              <li>
                <span className="text-foreground font-medium">Löschung</span> —
                der Endpunkt zur Konto-Löschung läuft kaskadiert durch jede
                nutzer-skopierte Tabelle: Gesundheitsmessungen, Sitzungen,
                Audit-Log, Integrations-Token, Push- Abonnements, Erfolge,
                hochgeladene Dateien. Die Löschung erfolgt sofort im aktiven
                Serverbestand; neue Backups enthalten das Konto danach nicht
                mehr, ältere Sicherungskopien laufen nach der aktiven
                Bucket-Lifecycle-Regel des Betreibers aus.
              </li>
            </ul>
          }
          bodyEn={
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <span className="text-foreground font-medium">
                  Server location
                </span>{" "}
                — primary store is PostgreSQL on Hetzner-hosted hardware in
                Germany; the application is operated by the controller as an
                individual based in Germany. No third- party hosting beyond the
                providers listed in section 4.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Encryption in transit
                </span>{" "}
                — TLS 1.3 with HSTS on every public endpoint; the iOS
                application additionally pins the TLS certificate.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Encryption at rest
                </span>{" "}
                — disk-level encryption plus column-level encryption with a
                separate key for sensitive columns (auth tokens, integration
                secrets).
              </li>
              <li>
                <span className="text-foreground font-medium">Backups</span> —
                when the operator enables optional off-host backup, daily
                account exports are encrypted under a separate AES-256-GCM key
                and written to an S3-compatible object store. Retention is set
                by the operator and the canonical bucket lifecycle rule; the
                source tree cannot prove the currently deployed production rule.
              </li>
              <li>
                <span className="text-foreground font-medium">Health data</span>{" "}
                — account-linked measurements remain until the user deletes them
                or the account, unless a type-specific consolidation job
                applies. Raw dense heart-rate, HRV, and oxygen-saturation
                samples consolidate into hourly means after 90 days; daily
                rollups preserve the mean and extremes. No global five-year
                deletion job for all measurements is evidenced by the server.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Operational and consent data
                </span>{" "}
                — audit logs are pruned daily under the configured window
                (server default: 365 days). Push-delivery attempts are pruned
                daily after 90 days. Server and reverse-proxy logs follow the
                operator&apos;s active log rotation. Consent receipts remain in
                the account audit trail until account deletion. External-AI
                requests follow the policy of the provider or endpoint operator
                identified before transmission.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  No HealthLog iCloud storage
                </span>{" "}
                — HealthLog does not store its server database, local health
                caches, offline outbox, ECG or workout payloads, AI transcript
                cache, medication-reminder scheduler database, or widget and
                Watch health snapshots in iCloud or CloudKit. Local
                health-bearing stores use protected app or application-group
                storage, disable CloudKit where applicable, and are explicitly
                excluded from device backup. Apple Health may separately sync
                HealthKit data under Apple&apos;s platform controls; that is
                Apple-managed behaviour, not HealthLog cloud storage.
              </li>
              <li>
                <span className="text-foreground font-medium">Deletion</span> —
                the account-deletion endpoint cascades through every user-scoped
                table: health observations, sessions, audit log, integration
                tokens, push subscriptions, achievements, uploaded files.
                Deletion is immediate in the active server store. New backups
                then omit the account; older backup copies age out under the
                operator&apos;s active bucket lifecycle rule.
              </li>
            </ul>
          }
        />

        <Section
          id="rights"
          numberLabel="6"
          titleDe="Ihre Rechte (DSGVO Art. 15–22)"
          titleEn="Your rights (GDPR Art. 15-22, DSGVO)"
          bodyDe={
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <span className="text-foreground font-medium">
                  Auskunftsrecht (Art. 15)
                </span>{" "}
                — jeder gespeicherte Wert ist über die Historie in der App
                erreichbar. Ein konsolidierter JSON-Export liegt unter{" "}
                <em>Einstellungen → Daten &amp; Export</em>.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Recht auf Berichtigung (Art. 16)
                </span>{" "}
                — jeder Eintrag bietet eine Bearbeiten- und Löschen- Aktion in
                der App.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Recht auf Löschung (Art. 17)
                </span>{" "}
                — <em>Einstellungen → Konto → Konto löschen</em>. Nach
                erfolgreicher Server-Löschung entfernt die App sofort alle
                kontogebundenen lokalen Daten. Bei einem Konto mit MFA kann die
                App zur authentifizierten Web-Kontoseite weiterleiten, damit der
                Nutzer den erforderlichen frischen Identitätsnachweis erbringt;
                nach Rückkehr erkennt die App die bestätigte Löschung und führt
                dieselbe lokale Bereinigung aus. Die Server-Aktion kaskadiert
                über alle nutzer-skopierten Tabellen via{" "}
                <code className="bg-muted rounded px-1 py-0.5 text-xs">
                  User.delete
                </code>{" "}
                +{" "}
                <code className="bg-muted rounded px-1 py-0.5 text-xs">
                  onDelete: Cascade
                </code>
                . Neue Sicherungen enthalten das gelöschte Konto nicht; ältere
                Kopien laufen nach der aktiven Bucket-Lifecycle-Regel aus.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Recht auf Einschränkung (Art. 18)
                </span>{" "}
                — administrative Sperre per Datenschutz-Anfrage (siehe Abschnitt
                11).
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Recht auf Datenübertragbarkeit (Art. 20)
                </span>{" "}
                — der JSON-Export unter{" "}
                <em>Einstellungen → Daten &amp; Export</em> liefert den
                vollständigen Datensatz in maschinenlesbarem Format.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Widerspruch und automatisierte Entscheidungen (Art. 21–22)
                </span>{" "}
                — der KI-Coach trifft keine automatisierten Entscheidungen im
                Sinne von Art. 22 DSGVO. Er erzeugt Texte zum Nachlesen; ohne
                ausdrückliche Bestätigung wird keine Aktion ausgeführt. Siehe
                Abschnitt 7 zur Medizinprodukte-Grenze.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Beschwerderecht
                </span>{" "}
                — beim Bundesbeauftragten für den Datenschutz und die
                Informationsfreiheit (BfDI) oder bei der für den gewöhnlichen
                Aufenthaltsort der betroffenen Person zuständigen
                Aufsichtsbehörde.
              </li>
            </ul>
          }
          bodyEn={
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <span className="text-foreground font-medium">
                  Right of access (Art. 15)
                </span>{" "}
                — every stored value is reachable through the in-app history
                surfaces. A consolidated JSON export is offered under{" "}
                <em>Settings → Data &amp; export</em>.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Right to rectification (Art. 16)
                </span>{" "}
                — every record carries an in-app edit and delete action.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Right to erasure (Art. 17)
                </span>{" "}
                — <em>Settings → Account → Delete account</em>. After successful
                server deletion, the app immediately removes all local
                account-bound data. For an MFA-enrolled account, the app may
                hand off to the authenticated web account page for the required
                fresh identity check; on return it detects confirmed deletion
                and performs the same local cleanup. The server action cascades
                through every user-scoped table via{" "}
                <code className="bg-muted rounded px-1 py-0.5 text-xs">
                  User.delete
                </code>{" "}
                +{" "}
                <code className="bg-muted rounded px-1 py-0.5 text-xs">
                  onDelete: Cascade
                </code>
                . New backups omit the deleted account; older copies age out
                under the active bucket lifecycle rule.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Right to restriction of processing (Art. 18)
                </span>{" "}
                — request an administrative suspension via the contact channel
                in section 11.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Right to data portability (Art. 20)
                </span>{" "}
                — the JSON export under <em>Settings → Data &amp; export</em>{" "}
                returns the full record set in a structured, machine-readable
                format.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Right to object / automated decision-making (Art. 21- 22)
                </span>{" "}
                — the AI Coach does not make automated decisions in the Art. 22
                sense. It generates written suggestions for the user to read; no
                action is taken without explicit confirmation. See section 7 for
                the medical-device boundary.
              </li>
              <li>
                <span className="text-foreground font-medium">
                  Right to lodge a complaint
                </span>{" "}
                — with the Federal Commissioner for Data Protection and Freedom
                of Information (BfDI) for the German federal level, or with the
                data-protection authority of the user&apos;s habitual residence.
              </li>
            </ul>
          }
        />

        <Section
          id="medical-boundary"
          numberLabel="7"
          titleDe="Medizinprodukte-Grenze (EU-MDR 2017/745, MDCG 2021-24)"
          titleEn="Medical-device boundary (EU MDR 2017/745, MDCG 2021-24)"
          bodyDe={
            <>
              <p>
                HealthLog ist <strong>kein Medizinprodukt</strong> im Sinne der
                EU-Verordnung 2017/745 (MDR). Die Anwendung erfasst und
                visualisiert Beobachtungen, die der Nutzer selbst eingegeben
                hat; sie diagnostiziert, behandelt, verordnet oder überwacht
                keine spezifische medizinische Erkrankung.
              </p>
              <p>
                Die KI-Coach-Oberfläche ist durch zwei ausdrückliche Grundregeln
                im System-Prompt eingegrenzt: sie empfiehlt keine GLP-1-Dosen
                (GROUND RULE 9) und erzeugt keine wirkstoff-bezogenen
                Schätzungen (GROUND RULE 15). Der GLP-1-Research-Mode ist eine
                reine Visualisierung, die erst nach einer versionierten
                Bestätigung freigeschaltet wird, die dem Nutzer die MDR-Grenze
                ausdrücklich nennt. Keine dieser Oberflächen gibt klinische
                Empfehlungen aus.
              </p>
              <p>
                Für medizinische Beratung muss eine approbierte ärztliche
                Fachkraft konsultiert werden. HealthLog soll diese Beratung
                unterstützen, indem es selbst erfasste Daten aufbereitet — nicht
                ersetzen.
              </p>
            </>
          }
          bodyEn={
            <>
              <p>
                HealthLog is <strong>not a medical device</strong> within the
                meaning of EU Regulation 2017/745 (MDR). The application records
                and displays observations the user has entered; it does not
                diagnose, treat, prescribe, or monitor a specific medical
                condition.
              </p>
              <p>
                The AI Coach surface is constrained by two explicit ground rules
                in its system prompt: it does not recommend GLP-1 doses (GROUND
                RULE 9), and it does not produce drug-level estimates (GROUND
                RULE 15). The GLP-1 Research Mode chart is a display-only
                visualisation gated behind a versioned acknowledgment that cites
                the MDR boundary to the user before unlocking. None of these
                surfaces issue clinical recommendations.
              </p>
              <p>
                For medical advice the user must consult a licensed clinician.
                HealthLog is intended to support that conversation by surfacing
                self-tracked data — not to replace it.
              </p>
            </>
          }
        />

        <Section
          id="apple-categories"
          numberLabel="8"
          titleDe="Apple-App-Store-Datenschutzkategorien"
          titleEn="Apple App Store privacy categories"
          bodyDe={
            <>
              <p>
                Die Privacy-Nutrition-Labels der iOS-Anwendung in App Store
                Connect ordnen sich folgenden Kategorien zu (jeweils{" "}
                <em>linked to the user</em>, zur App-Funktion und, soweit
                angegeben, Konto-Verwaltung):
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <span className="text-foreground font-medium">
                    Gesundheit &amp; Fitness
                  </span>
                  .
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    Sensible Informationen
                  </span>{" "}
                  (Blutdruck, Blutzucker, Medikamente).
                </li>
                <li>
                  <span className="text-foreground font-medium">Name</span> —
                  Anzeigename für Profil und Berichte; App-Funktion und
                  Konto-Verwaltung.
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    Kontakt-Informationen
                  </span>{" "}
                  (E-Mail-Adresse) — Konto-Verwaltung.
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    Nutzer-Inhalte
                  </span>{" "}
                  (Notizen, Prompts und Fragen, geprüfter OCR- und
                  Dokumenttext).
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    Fotos oder Videos
                  </span>{" "}
                  (Profilbild sowie ausdrücklich hochgeladene
                  Dokumentfotos/-scans; Schnell-Erfassungsbilder bleiben auf dem
                  Gerät).
                </li>
                <li>
                  <span className="text-foreground font-medium">Kennungen</span>{" "}
                  (Geräte- und Nutzer-Kennung).
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    Diagnose, Nutzung, Browsing, Suche, Andere
                  </span>{" "}
                  — nicht erhoben.
                </li>
                <li>
                  <span className="text-foreground font-medium">Standort</span>{" "}
                  — nicht erhoben, außer bei einer optional vom Nutzer
                  angehängten GPS-Workout-Route.
                </li>
              </ul>
              <p>
                <strong>Tracking: Nein.</strong> HealthLog verwendet keine
                Werbung, kein anwendungsübergreifendes Tracking, keine
                Werbemessung und kein Drittanbieter-Analytics-SDK. Optionale
                KI-Anbieter erhalten Daten nur für die vom Nutzer ausgelöste
                App-Funktion, nicht für Werbung oder Tracking.
              </p>
            </>
          }
          bodyEn={
            <>
              <p>
                The iOS application&apos;s Privacy Nutrition Labels in App Store
                Connect map to the following categories (each
                <em> linked to the user</em>, used for app functionality and,
                where stated, account management):
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <span className="text-foreground font-medium">
                    Health &amp; Fitness
                  </span>
                  .
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    Sensitive Info
                  </span>{" "}
                  (blood pressure, glucose, medications).
                </li>
                <li>
                  <span className="text-foreground font-medium">Name</span> —
                  display name for the profile and reports; app functionality
                  and account management.
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    Contact Info
                  </span>{" "}
                  (email address) — account management.
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    User Content
                  </span>{" "}
                  (notes, prompts and questions, reviewed OCR and document
                  text).
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    Photos or Videos
                  </span>{" "}
                  (profile image and explicitly uploaded document photos or
                  scans; quick-entry images stay on the device).
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    Identifiers
                  </span>{" "}
                  (device identifier, user identifier).
                </li>
                <li>
                  <span className="text-foreground font-medium">
                    Diagnostics, Usage Data, Browsing History, Search History,
                    Other Data
                  </span>{" "}
                  — not collected.
                </li>
                <li>
                  <span className="text-foreground font-medium">Location</span>{" "}
                  — not collected, except for an optional GPS route the user
                  attaches manually to a workout.
                </li>
              </ul>
              <p>
                <strong>Tracking: No.</strong> HealthLog uses no advertising,
                cross-app tracking, advertising measurement, or third-party
                analytics SDK. Optional AI providers receive data only for the
                app function the user invokes, not for advertising or tracking.
              </p>
            </>
          }
        />

        <Section
          id="children"
          numberLabel="9"
          titleDe="Kinder"
          titleEn="Children"
          bodyDe={
            <p>
              HealthLog richtet sich nicht an Kinder unter 16 Jahren. Die
              Anwendung sollte nicht ohne nachweisbare elterliche Aufsicht von
              Personen unter 16 Jahren verwendet werden. Der Betreiber erhebt
              wissentlich keine personenbezogenen Daten von Kindern unter 16
              Jahren; sollte dies auffallen, werden die Daten umgehend gelöscht.
            </p>
          }
          bodyEn={
            <p>
              HealthLog is not directed at children under the age of 16. The
              application should not be used by anyone under 16 without
              verifiable parental supervision. The operator does not knowingly
              collect personal data from children under 16; if such data is
              discovered, it will be deleted on detection.
            </p>
          }
        />

        <Section
          id="changes"
          numberLabel="10"
          titleDe="Änderungen dieser Erklärung"
          titleEn="Changes to this policy"
          bodyDe={
            <p>
              Diese Erklärung trägt oben einen Versionsstempel. Materielle
              Änderungen werden in den In-App-Versionshinweisen und im
              Open-Source-Changelog zusammengefasst. Die veröffentlichte
              Policy-Version ist an die Anwendungsversion gebunden, mit der sie
              eingeführt wurde.
            </p>
          }
          bodyEn={
            <p>
              This document is version-stamped at the top. Material changes will
              be summarised in the in-app release notes and on the open-source
              changelog. The published policy version is bound to the
              application release version that introduced it.
            </p>
          }
        />

        <Section
          id="contact"
          numberLabel="11"
          titleDe="Kontakt"
          titleEn="Contact"
          bodyDe={
            <>
              <p>
                Verantwortlicher und Ansprechpartner für DSGVO-Anfragen ist der
                Betreiber dieser Instanz, eine Privatperson mit Sitz in
                Deutschland (vollständige Postanschrift wird Antragstellern auf
                Anfrage über den unten genannten Kanal mitgeteilt; sie ist nicht
                öffentlich aufgeführt, um gezielte Belästigung zu verhindern —
                eine Klarstellung, die die deutschen DPAs in ihren Hinweisen zu
                Impressums- Pflichten ausdrücklich zulassen, sofern eine
                elektronische Erreichbarkeit besteht).
              </p>
              <p>
                <span className="text-foreground font-medium">
                  E-Mail (Betreiber):
                </span>{" "}
                <a
                  href="mailto:mbombeck@gmail.com"
                  className="text-primary underline underline-offset-2"
                >
                  mbombeck@gmail.com
                </a>
                . Bitte das E-Mail-Betreff mit{" "}
                <em>
                  &quot;HealthLog DSGVO — &lt;Auskunft | Löschung |
                  Übertragbarkeit&gt;&quot;
                </em>{" "}
                kennzeichnen. Erste Antwort innerhalb von 30 Tagen gemäß Art. 12
                Abs. 3 DSGVO.
              </p>
              <p>
                <span className="text-foreground font-medium">
                  Alternativ via GitHub:
                </span>{" "}
                öffentliches Issue unter{" "}
                <a
                  href="https://github.com/MBombeck/HealthLog/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  github.com/MBombeck/HealthLog/issues
                </a>{" "}
                mit Titel{" "}
                <em>GDPR — &lt;Access | Erasure | Portability&gt; request</em> —
                bitte keine personenbezogenen Daten im öffentlichen Issue
                posten; ein privater Kanal wird in der ersten Antwort angeboten.
              </p>
            </>
          }
          bodyEn={
            <>
              <p>
                The controller and point of contact for GDPR enquiries is the
                operator of this instance, an individual based in Germany (the
                full postal address is disclosed to requesters via the channel
                below upon request; it is not publicly listed to prevent
                targeted harassment — a practice explicitly tolerated by German
                data-protection authorities provided an electronic contact route
                is available).
              </p>
              <p>
                <span className="text-foreground font-medium">
                  Email (operator):
                </span>{" "}
                <a
                  href="mailto:mbombeck@gmail.com"
                  className="text-primary underline underline-offset-2"
                >
                  mbombeck@gmail.com
                </a>
                . Subject line:{" "}
                <em>
                  &quot;HealthLog GDPR — &lt;Access | Erasure |
                  Portability&gt;&quot;
                </em>
                . First reply within 30 days per Art. 12 (3) GDPR.
              </p>
              <p>
                <span className="text-foreground font-medium">
                  Alternative via GitHub:
                </span>{" "}
                public issue at{" "}
                <a
                  href="https://github.com/MBombeck/HealthLog/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  github.com/MBombeck/HealthLog/issues
                </a>{" "}
                titled{" "}
                <em>GDPR — &lt;Access | Erasure | Portability&gt; request</em> —
                please do not include personal data in the public issue; a
                private channel will be offered in the first response.
              </p>
            </>
          }
        />

        <footer
          className="border-border/60 text-muted-foreground mt-12 border-t pt-6 text-xs"
          data-slot="privacy-footer"
        >
          <p>
            HealthLog — source-available under the{" "}
            <a
              href="https://github.com/MBombeck/HealthLog/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline"
            >
              PolyForm Noncommercial License 1.0.0
            </a>
            . Policy version {POLICY_VERSION}. Last updated {LAST_UPDATED}.
          </p>
          {/* The GeoLite2 EULA wants the attribution page reachable from the
              running app — this and the Settings→About row are the two
              inbound links to /about. */}
          <p className="mt-2">
            <Link
              href="/about"
              className="hover:text-foreground hover:underline"
              data-slot="privacy-about-link"
            >
              About HealthLog — credits &amp; data attributions
            </Link>
          </p>
        </footer>
      </main>
    </div>
  );
}
