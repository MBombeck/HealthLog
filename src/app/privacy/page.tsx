import type { Metadata } from "next";
import Link from "next/link";

/**
 * v1.4.26 — Public privacy policy.
 *
 * Requirements driving this page:
 *
 *   1. **Apple App Store Connect** requires a publicly reachable Privacy-
 *      Policy URL before the iOS native app's first submission. The URL
 *      registered with ASC is `https://healthlog.bombeck.io/privacy`.
 *   2. **GDPR Art. 13 / 14 + Art. 15-22** — data-subject rights need to
 *      be enumerated with concrete endpoints / routes the user can hit.
 *   3. **EU MDR 2017/745 + MDCG 2021-24** — the boundary "HealthLog is
 *      not a medical device" is stated next to the AI-Coach explanation,
 *      because that boundary is what keeps the Coach legally outside
 *      MDR scope. Mirrors GROUND RULES 9 + 15 in the Coach system prompt.
 *
 * Public route — listed in `src/proxy.ts` PUBLIC_PATHS and the
 * `<AuthShell>` PUBLIC_PATHS so an unauthenticated visitor (or App-Store
 * reviewer) lands directly on the content without an auth redirect.
 *
 * English-only body copy for this release. German + the four remaining
 * locales follow in a subsequent patch — pattern matches the W14c
 * native-Coach-prompts release where EN + DE shipped first. The
 * `auth.privacyPolicy` label in `<LoginPage>` IS translated into all
 * six locales already so the discoverable link reads natively.
 */

export const dynamic = "force-static";
export const revalidate = false;

const POLICY_VERSION = "1.4.26";
const LAST_UPDATED = "2026-05-15";

export const metadata: Metadata = {
  title: "Privacy Policy — HealthLog",
  description:
    "How HealthLog handles personal-health data, sub-processors, GDPR rights, and the EU MDR medical-device boundary.",
  robots: { index: true, follow: true },
};

interface SectionProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

function Section({ id, title, children }: SectionProps) {
  return (
    <section id={id} className="space-y-3 scroll-mt-28">
      <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
        {title}
      </h2>
      <div className="text-muted-foreground space-y-3 text-sm leading-relaxed md:text-base">
        {children}
      </div>
    </section>
  );
}

interface SubProcessorProps {
  name: string;
  role: string;
  data: string;
  location: string;
  policyUrl: string;
}

function SubProcessor({
  name,
  role,
  data,
  location,
  policyUrl,
}: SubProcessorProps) {
  return (
    <li className="border-border bg-card/40 space-y-1 rounded-md border p-3">
      <p className="text-foreground font-medium">{name}</p>
      <p className="text-sm">
        <span className="text-foreground font-medium">Role.</span> {role}
      </p>
      <p className="text-sm">
        <span className="text-foreground font-medium">Data transferred.</span>{" "}
        {data}
      </p>
      <p className="text-sm">
        <span className="text-foreground font-medium">Storage.</span> {location}
      </p>
      <p className="text-sm">
        <a
          href={policyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          Privacy policy
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
      <header className="border-border/60 bg-background/80 sticky top-0 z-10 border-b backdrop-blur pt-[env(safe-area-inset-top)]">
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
            Sign in
          </Link>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto max-w-3xl space-y-10 px-4 py-8 md:px-6 md:py-12"
      >
        <div className="space-y-3">
          <p className="text-muted-foreground text-xs tracking-wider uppercase">
            Policy version {POLICY_VERSION}
          </p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            Privacy Policy
          </h1>
          <p
            className="text-muted-foreground text-sm"
            data-slot="privacy-last-updated"
          >
            Last updated: {LAST_UPDATED}
          </p>
        </div>

        {/* v1.4.27 MB6 — collapsible TOC. Default-closed on every
            viewport so the policy's first paragraphs reach the fold
            on `<sm`; an open summary on a wide screen costs nothing,
            and the reader can flip it open to skim the section list. */}
        <details
          className="border-border/60 bg-card/40 group rounded-md border"
          data-slot="privacy-toc"
        >
          <summary className="text-foreground hover:bg-muted/50 cursor-pointer list-none rounded-md px-4 py-3 text-sm font-medium select-none">
            Contents
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
                <a className="hover:text-foreground hover:underline" href="#intro">
                  1. Overview
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#data-we-collect"
                >
                  2. Data we collect
                </a>
              </li>
              <li>
                <a className="hover:text-foreground hover:underline" href="#purpose">
                  3. Why we collect each category
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#sub-processors"
                >
                  4. Third-party sub-processors
                </a>
              </li>
              <li>
                <a className="hover:text-foreground hover:underline" href="#storage">
                  5. Data storage and retention
                </a>
              </li>
              <li>
                <a className="hover:text-foreground hover:underline" href="#rights">
                  6. Your rights (GDPR Art. 15-22, DSGVO)
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#medical-boundary"
                >
                  7. Medical-device boundary (EU MDR 2017/745, MDCG 2021-24)
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#apple-categories"
                >
                  8. Apple App Store privacy categories
                </a>
              </li>
              <li>
                <a
                  className="hover:text-foreground hover:underline"
                  href="#children"
                >
                  9. Children
                </a>
              </li>
              <li>
                <a className="hover:text-foreground hover:underline" href="#changes">
                  10. Changes to this policy
                </a>
              </li>
              <li>
                <a className="hover:text-foreground hover:underline" href="#contact">
                  11. Contact
                </a>
              </li>
            </ol>
          </nav>
        </details>

        <Section id="intro" title="1. Overview">
          <p>
            HealthLog is an open-source, self-hostable personal-health-tracking
            application. Source code is published at{" "}
            <a
              href="https://github.com/MBombeck/HealthLog"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              github.com/MBombeck/HealthLog
            </a>{" "}
            under the GNU Affero General Public License v3.0. This policy
            describes how the hosted instance at{" "}
            <code className="bg-muted rounded px-1 py-0.5 text-xs">
              healthlog.bombeck.io
            </code>{" "}
            and the companion iOS application{" "}
            <em>HealthLog for iOS</em> (bundle identifier{" "}
            <code className="bg-muted rounded px-1 py-0.5 text-xs">
              io.bombeck.healthlog
            </code>
            ) handle personal data.
          </p>
          <p>
            This document covers the web application version {POLICY_VERSION}{" "}
            and the iOS application version 0.3 and later. Self-hosted
            deployments controlled by a different operator are governed by the
            operator&apos;s own privacy policy; this document applies only to
            the instance reachable at the hostname above.
          </p>
          <p>
            For questions or data-subject requests, open a public issue at{" "}
            <a
              href="https://github.com/MBombeck/HealthLog/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              github.com/MBombeck/HealthLog/issues
            </a>{" "}
            titled &quot;GDPR — &lt;Access | Erasure | Portability&gt;
            request&quot; without personal information in the title; a private
            channel for the actual exchange will be provided in the first
            response.
          </p>
        </Section>

        <Section id="data-we-collect" title="2. Data we collect">
          <p>
            HealthLog is designed to record observations the user enters
            themselves and to consume health signals the user has explicitly
            connected through a third-party integration. The categories below
            are exhaustive for the released feature set.
          </p>

          <h3 className="text-foreground pt-2 text-base font-semibold">
            2.1 Account and authentication
          </h3>
          <ul className="list-disc space-y-1 pl-5">
            <li>Email address and chosen username.</li>
            <li>
              Password hash (Argon2id; the plain-text password is never stored
              or logged).
            </li>
            <li>
              Optional WebAuthn / passkey credentials (public key, credential
              ID, sign counter).
            </li>
            <li>
              Session identifiers (HTTP-only cookie on the web; opaque API
              tokens on iOS, stored in the device Keychain).
            </li>
            <li>
              Profile metadata: locale, timezone, date of birth (optional),
              biological sex (optional), height (optional). Used to compute
              age-adjusted target ranges and BMI.
            </li>
          </ul>

          <h3 className="text-foreground pt-2 text-base font-semibold">
            2.2 Manually entered health data
          </h3>
          <p>
            Any value entered through the in-app forms, including timestamp,
            optional note, and the metric type. The full enumeration of
            supported metrics is published in the OpenAPI schema; the
            user-relevant subset includes:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Body weight, body-fat percentage, body temperature, BMI (derived).
            </li>
            <li>
              Blood pressure (systolic, diastolic) and pulse rate, recorded as
              paired readings.
            </li>
            <li>
              Blood glucose with measurement context (fasting, postprandial,
              random, bedtime) and a configurable unit (mg/dL or mmol/L).
            </li>
            <li>
              Resting heart rate, heart-rate variability (SDNN), VO₂ max,
              oxygen saturation.
            </li>
            <li>
              Sleep duration including per-stage breakdown (Awake / REM / Core
              / Deep).
            </li>
            <li>
              Step count, distance walked or run, active-energy burned, flights
              climbed.
            </li>
            <li>Environmental and headphone audio-exposure levels.</li>
            <li>Time in daylight.</li>
            <li>Mood (1-5 scale) with optional free-text note.</li>
            <li>
              Workout sessions: activity type, duration, distance, and an
              optional GPS route (only uploaded when the user attaches a route
              explicitly; HealthLog does not run continuous location services).
            </li>
            <li>
              Personal records derived automatically from the data above
              (metric type, value, achievement timestamp, optional workout
              link).
            </li>
          </ul>

          <h3 className="text-foreground pt-2 text-base font-semibold">
            2.3 Apple Health (iOS application)
          </h3>
          <p>
            When the user grants the iOS application read access to Apple
            HealthKit, HealthLog reads samples for the identifiers listed
            below. HealthKit data remains on the user&apos;s device and the
            user&apos;s iCloud-backed Health store; the iOS application copies
            relevant samples to the user&apos;s HealthLog account so that the
            web surface can render the same trends as the iPhone.
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
              <code className="text-xs break-all">bloodPressureSystolic</code>
            </li>
            <li>
              <code className="text-xs break-all">bloodPressureDiastolic</code>
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
              <code className="text-xs break-all">heartRateVariabilitySDNN</code>
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
              <code className="text-xs break-all">distanceWalkingRunning</code>
            </li>
            <li>
              <code className="text-xs break-all">environmentalAudioExposure</code>
            </li>
            <li>
              <code className="text-xs break-all">headphoneAudioExposure</code>
            </li>
            <li>
              <code className="text-xs break-all">timeInDaylight</code> (iOS 17 and later)
            </li>
          </ul>
          <p className="font-medium">HKCategoryTypeIdentifier:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <code className="text-xs break-all">sleepAnalysis</code> — read with full
              per-stage granularity (Awake, REM, Core, Deep). Stages are stored
              server-side as separate rows so the chart can stack them.
            </li>
          </ul>
          <p>
            Write access is requested for a subset (body mass, blood-pressure
            systolic / diastolic, blood glucose) so that manual entries made
            inside the iOS app can flow back into HealthKit. The user controls
            both directions in the iOS Health app&apos;s permission surface and
            may revoke at any time.
          </p>

          <h3 className="text-foreground pt-2 text-base font-semibold">
            2.4 Withings sync (optional)
          </h3>
          <p>
            When the user connects a Withings account, HealthLog stores the
            OAuth refresh and access tokens (encrypted at the column level) and
            the user&apos;s Withings identifier. Subsequent webhook-driven
            syncs pull the following measurement families:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Body weight, fat ratio, fat-free mass, muscle mass.</li>
            <li>Bone mass, water mass, lean mass, hydration.</li>
            <li>Blood pressure (systolic, diastolic) and pulse.</li>
            <li>Blood glucose readings.</li>
            <li>Body temperature, basal temperature, skin temperature.</li>
            <li>Activity totals: steps, distance, active calories.</li>
            <li>
              Sleep sessions with per-stage segments (Awake / Light / Deep /
              REM).
            </li>
            <li>SpO₂ and heart-rate variability where available.</li>
          </ul>

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
              For GLP-1 treatments: dose-change history, injection events with
              optional injection site and pen identifier, side-effect logs
              against a fixed taxonomy, pen-and-vial inventory with a 30-day
              in-use clock.
            </li>
          </ul>

          <h3 className="text-foreground pt-2 text-base font-semibold">
            2.6 AI Coach and Insights
          </h3>
          <p>
            When the user enables the AI Coach surface and configures a
            language-model provider, HealthLog sends a snapshot bundle to that
            provider on demand. The bundle contains health context derived
            from the data above (aggregates, recent observations, target
            ranges, optional medication context). The bundle is generated per
            request; HealthLog does not retain long-term conversation state
            beyond the most recent thread. See section 4 for what each
            provider does with the data.
          </p>

          <h3 className="text-foreground pt-2 text-base font-semibold">
            2.7 Device and integration metadata
          </h3>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              A device identifier (random UUID generated client-side, stored
              in the iOS Keychain) sent as the{" "}
              <code className="bg-muted rounded px-1 py-0.5 text-xs">
                X-Device-Id
              </code>{" "}
              request header. Used for multi-device sync and abuse prevention.
            </li>
            <li>
              Apple Push Notification service (APNs) device token and
              environment flag (sandbox / production), recorded only when the
              user enables push notifications.
            </li>
            <li>
              Telegram chat identifier — only when the user has explicitly
              connected the optional Telegram-bot notifier.
            </li>
          </ul>

          <h3 className="text-foreground pt-2 text-base font-semibold">
            2.8 Security and audit
          </h3>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Authentication events: login success / failure, passkey
              registration, password change, session revocation. Retained for
              security forensics.
            </li>
            <li>
              Server access logs: timestamp, request path, status code, user-
              agent, IP address. Retained for 14 days for abuse-rate-limiting
              and debugging.
            </li>
          </ul>

          <h3 className="text-foreground pt-2 text-base font-semibold">
            2.9 Data we do not collect
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
              No precise background location (workouts only carry GPS when the
              user attaches a route).
            </li>
            <li>No social-network identifiers or contact-list scrapes.</li>
            <li>
              No third-party product analytics. The instance does not ship a
              client-side analytics SDK.
            </li>
          </ul>
        </Section>

        <Section id="purpose" title="3. Why we collect each category">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-foreground font-medium">
                Authentication data
              </span>{" "}
              — identifying the user and securing the session. Legal basis: GDPR
              Art. 6 (1) (b) performance of contract.
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
              transmitted to the configured AI provider for the duration of the
              request only.
            </li>
            <li>
              <span className="text-foreground font-medium">Device data</span>{" "}
              — push notifications, abuse prevention, and multi-device session
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
        </Section>

        <Section id="sub-processors" title="4. Third-party sub-processors">
          <p>
            The following providers may process personal data on behalf of the
            HealthLog operator. The list is exhaustive for the released
            feature set; sub-processors are only engaged for the features the
            user has explicitly enabled.
          </p>
          <ul className="grid gap-3">
            <SubProcessor
              name="Anthropic, PBC"
              role="AI Coach and Insights provider when the user selects Anthropic Claude in settings."
              data="Coach snapshot bundle (health-data context) for the duration of the request."
              location="United States. Anthropic states a 30-day retention window for abuse-monitoring."
              policyUrl="https://www.anthropic.com/legal/privacy"
            />
            <SubProcessor
              name="OpenAI, L.L.C."
              role="Alternative AI Coach and Insights provider when the user selects an OpenAI model in settings."
              data="Coach snapshot bundle, same shape as the Anthropic variant."
              location="United States. Retention governed by OpenAI's enterprise policy applicable to the configured API key."
              policyUrl="https://openai.com/policies/privacy-policy"
            />
            <SubProcessor
              name="Withings SAS"
              role="Wearable-device data sync when the user connects a Withings account."
              data="OAuth refresh and access tokens, Withings user identifier, webhook notifications about new measurements."
              location="France (European Union)."
              policyUrl="https://www.withings.com/de/de/legal/privacy-policy"
            />
            <SubProcessor
              name="Apple, Inc."
              role="HealthKit (on-device store; samples never leave the user's device or iCloud unless the user grants read access to HealthLog) and Apple Push Notification service (APNs, when notifications are enabled)."
              data="HealthKit access is local to the device. APNs receives a device token, the application bundle identifier, and the notification payload."
              location="United States. Apple stores HealthKit data on the user's device and iCloud-encrypted backups under the user's Apple ID."
              policyUrl="https://www.apple.com/legal/privacy/"
            />
            <SubProcessor
              name="Telegram FZ-LLC"
              role="Optional notification channel when the user enables the Telegram-bot integration."
              data="Telegram chat identifier and the notification payload."
              location="United Arab Emirates / Telegram global infrastructure."
              policyUrl="https://telegram.org/privacy"
            />
            <SubProcessor
              name="GitHub, Inc."
              role="Hosting of the open-source repository and the issue tracker used as the support channel."
              data="Issue contents and any voluntary attachments. Avoid posting personal data in public issues; the maintainer offers a private channel after the first response."
              location="United States."
              policyUrl="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"
            />
            <SubProcessor
              name="Cloudflare, Inc."
              role="Authoritative DNS for the bombeck.io zones. The application itself is not behind the Cloudflare proxy; only the DNS resolution path is."
              data="Source IP address and user-agent at resolution time."
              location="United States; Cloudflare's standard global anycast network."
              policyUrl="https://www.cloudflare.com/privacypolicy/"
            />
            <SubProcessor
              name="Hetzner Online GmbH"
              role="Hardware host for the application server and the PostgreSQL database."
              data="Disk and network traffic between the operator-controlled virtual machines and the public internet."
              location="Germany (European Union). All HealthLog application data lives on Hetzner-hosted infrastructure under German jurisdiction."
              policyUrl="https://www.hetzner.com/legal/privacy-policy"
            />
          </ul>
        </Section>

        <Section id="storage" title="5. Data storage and retention">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Primary data store: PostgreSQL on a Hetzner-hosted server in
              Germany. Disk encrypted at rest. Sensitive columns
              (authentication tokens, integration secrets) are individually
              encrypted with a key separate from the database key.
            </li>
            <li>
              Backups: daily, encrypted, retained for 30 days on an
              S3-compatible object store with its own encryption-at-rest layer.
            </li>
            <li>
              Retention: account data is retained until the user requests
              erasure (see section 6) or the account is administratively
              closed. Audit logs are retained for 90 days; server access logs
              for 14 days.
            </li>
            <li>
              Deletion: the account-deletion endpoint cascades through every
              user-scoped table — health observations, sessions, audit log,
              integration tokens, notification subscriptions, achievements,
              uploaded files. The deletion is immediate; backups age out under
              the 30-day window above.
            </li>
          </ul>
        </Section>

        <Section id="rights" title="6. Your rights (GDPR Art. 15-22, DSGVO)">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-foreground font-medium">
                Right of access (Art. 15)
              </span>{" "}
              — every value the application has stored is reachable through the
              in-app history surfaces. A consolidated JSON export is offered
              under <em>Settings → Data &amp; export</em>.
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
              — <em>Settings → Account → Delete account</em>. The action
              cascades immediately through user-scoped tables; backups age out
              within the 30-day window described in section 5.
            </li>
            <li>
              <span className="text-foreground font-medium">
                Right to restriction of processing (Art. 18)
              </span>{" "}
              — request an administrative suspension by opening a GDPR issue
              (see section 9).
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
                Right to object to automated decision-making (Art. 22)
              </span>{" "}
              — the AI Coach does not make automated decisions in the Art. 22
              sense. It generates written suggestions for the user to read; no
              action is taken on the user&apos;s behalf without explicit
              confirmation. See section 7 for the medical-device boundary.
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
        </Section>

        <Section
          id="medical-boundary"
          title="7. Medical-device boundary (EU MDR 2017/745, MDCG 2021-24)"
        >
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
        </Section>

        <Section
          id="apple-categories"
          title="8. Apple App Store privacy categories"
        >
          <p>
            The iOS application&apos;s Privacy Nutrition Labels in App Store
            Connect map to the following categories:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <span className="text-foreground font-medium">
                Health &amp; Fitness
              </span>{" "}
              — linked to the user; used for app functionality.
            </li>
            <li>
              <span className="text-foreground font-medium">
                Sensitive Info
              </span>{" "}
              (blood pressure, glucose, medications) — linked to the user; used
              for app functionality.
            </li>
            <li>
              <span className="text-foreground font-medium">Contact Info</span>{" "}
              (email address) — linked to the user; used for app functionality
              and account management.
            </li>
            <li>
              <span className="text-foreground font-medium">User Content</span>{" "}
              (notes attached to measurements, mood notes, bug-report text) —
              linked to the user; used for app functionality.
            </li>
            <li>
              <span className="text-foreground font-medium">Identifiers</span>{" "}
              (device identifier, user identifier) — linked to the user; used
              for app functionality.
            </li>
            <li>
              <span className="text-foreground font-medium">Diagnostics</span>{" "}
              — not collected.
            </li>
            <li>
              <span className="text-foreground font-medium">Usage Data</span>{" "}
              — not collected.
            </li>
            <li>
              <span className="text-foreground font-medium">Location</span>{" "}
              — not collected, except for an optional GPS route the user
              attaches manually to a workout.
            </li>
            <li>
              <span className="text-foreground font-medium">
                Browsing History
              </span>{" "}
              — not collected.
            </li>
            <li>
              <span className="text-foreground font-medium">
                Search History
              </span>{" "}
              — not collected.
            </li>
            <li>
              <span className="text-foreground font-medium">Other Data</span>{" "}
              — not collected.
            </li>
          </ul>
        </Section>

        <Section id="children" title="9. Children">
          <p>
            HealthLog is not directed at children under the age of 16. The
            application should not be used by anyone under 16 without
            verifiable parental supervision. The operator does not knowingly
            collect personal data from children under 16; if such data is
            discovered, it will be deleted on detection.
          </p>
        </Section>

        <Section id="changes" title="10. Changes to this policy">
          <p>
            This document is version-stamped at the top. Material changes will
            be summarised in the in-app release notes and on the open-source
            changelog. The published policy version is bound to the
            application release version that introduced it.
          </p>
        </Section>

        <Section id="contact" title="11. Contact">
          <p>
            For privacy questions and data-subject requests, open a public
            issue at{" "}
            <a
              href="https://github.com/MBombeck/HealthLog/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              github.com/MBombeck/HealthLog/issues
            </a>{" "}
            titled <em>GDPR — &lt;Access | Erasure | Portability&gt; request</em>
            . Do not include personal data in the public issue. A private
            channel for the actual exchange will be provided in the first
            response.
          </p>
        </Section>

        <footer
          className="border-border/60 mt-12 border-t pt-6 text-xs text-muted-foreground"
          data-slot="privacy-footer"
        >
          <p>
            HealthLog — open source under{" "}
            <a
              href="https://github.com/MBombeck/HealthLog/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline"
            >
              AGPL-3.0
            </a>
            . Policy version {POLICY_VERSION}. Last updated {LAST_UPDATED}.
          </p>
        </footer>
      </main>
    </div>
  );
}
