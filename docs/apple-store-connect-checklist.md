---
file: docs/apple-store-connect-checklist.md
purpose: Step-by-step ASC submission checklist for HealthLog iOS — covering medical-device declaration, privacy nutrition labels, and ASC metadata
audience: Marc (the maintainer) before submitting to App Store
estimated_read_time: 15 min
last_updated: 2026-05-15
---

# App Store Connect Submission Checklist — HealthLog iOS

## TL;DR

Three submission gates that need Marc's hand at ASC:
1. Regulated-Medical-Device declaration (Guideline 1.4 + 5.1.1(ix))
2. Privacy Nutrition Labels matching the iOS Privacy Manifest (Guideline 5.1.2)
3. Standard metadata (name, description, screenshots, categories, age rating)

Plus pre-submit final checks.

## Section 1 — Regulated-Medical-Device declaration

**Where**: App Store Connect → App Information → "Health & Fitness" → "Medical device" toggle

**Decision**: HealthLog is **NOT a medical device** under EU MDR 2017/745 / FDA 21 CFR 880 / Apple's interpretation.

**Recommended wording in the declaration form**:
> HealthLog is a personal health-data logging and visualization app. It displays user-entered observations + integrates with Apple HealthKit, Withings, and manual entry. It does not diagnose, treat, prescribe, or recommend dosing. The AI Coach surfaces are explicit-refusal-gated (GROUND RULES 9 + 15) against any medical-device-class output. The drug-level estimation chart is display-only behind a versioned MDR-acknowledgment dialog citing EU 2017/745 + MDCG 2021-24. For medical advice, users must consult licensed clinicians.

**What to check**:
- [ ] Check "No" on the medical-device toggle
- [ ] Add the description above to the medical-device-justification field if Apple shows one
- [ ] Cross-reference the in-app `/privacy` page (https://healthlog.bombeck.io/privacy) §7 MDR-boundary

**Why this matters**: Apple's first-submission rejection rate for health apps is ~40%. The most common reason is unclear medical-device classification. The above wording mirrors the in-app disclaimer + the per-feature gating; consistency between the form and the app is what Apple looks for.

## Section 2 — Privacy Nutrition Labels

**Where**: App Store Connect → App Privacy → "Edit" the privacy choices.

**Cross-reference**: every data category here MUST match what the iOS Privacy Manifest (in the iOS repo) declares. iOS-Claude's v0.3.0 release extended the manifest to: Email + OtherUserContent + SensitiveInfo + DeviceID + UserID + AccountManagement-purpose.

### Data categories to declare

For each category below: **Linked to user, used for App Functionality + Account Management**. Optional purposes: never enable Analytics, Tracking, Advertising, or Third-Party Tracking.

**Health & Fitness**
- Health: yes (all HKQuantityType + HKCategoryType the iOS app reads — see `/privacy` page §2)
- Fitness: yes (steps, distance, active energy, workouts)
- Purpose: App Functionality
- Linked to user: yes

**Contact Info**
- Email Address: yes (for account login + GDPR data-subject correspondence)
- Purpose: App Functionality + Account Management
- Linked to user: yes

**Sensitive Info**
- Blood pressure, glucose, medications, drug-related observations: yes
- Purpose: App Functionality
- Linked to user: yes

**User Content**
- Emails or Text Messages: NO (the AI Coach is in-app conversation, but iOS does not send emails)
- Photos or Videos: NO
- Audio Data: NO (HealthKit audio-exposure is environmental dB; not the user's voice)
- Customer Support: yes (open-source GitHub Issues; mention in policy)
- Other User Content: yes (Coach conversation context + medication notes + side-effect free-text)
- Purpose: App Functionality
- Linked to user: yes

**Identifiers**
- User ID: yes (server-side user UUID)
- Device ID: yes (X-Device-Id Keychain-stored UUID, APNs push token)
- Purpose: App Functionality + Account Management
- Linked to user: yes

**Other Data Types**
- Other Data Types: yes (general medical observations not fitting above)
- Purpose: App Functionality
- Linked to user: yes

### Data types to NOT declare (because not collected)

- Browsing History
- Search History
- Location (Precise or Coarse) — workout GPS routes are opt-in per-workout; if the iOS app implements them, declare; otherwise omit
- Purchases
- Financial Info
- Diagnostics, Crash Data, Performance Data, Other Diagnostic Data — if iOS uses any analytics SDK, declare; otherwise omit. Verify with iOS-Claude.
- Advertising Data
- Other Usage Data

### Tracking declaration

**Tracking**: NO. HealthLog does not link user data with data from other companies' apps and websites for advertising or share data with data brokers. The Privacy Manifest must not declare any tracking-related purposes.

## Section 3 — Standard Metadata Checklist

### App Information
- [ ] Name: "HealthLog"
- [ ] Subtitle: 30-char tagline (suggestion: "Personal health-data log + Coach")
- [ ] Primary category: Health & Fitness
- [ ] Secondary category: Medical (if Apple accepts non-medical-device classification for it)
- [ ] Content rights: confirm Marc owns the app rights
- [ ] Age rating: 17+ (because Sensitive Health Info content)

### Description
- [ ] Long-form description (4000 char max): cover Insights + Coach + GLP-1 + Withings + Apple HealthKit + open-source nature + EU GDPR compliance
- [ ] What's New (version-by-version notes): v0.3.0 = "Server-sync, comprehensive Apple HealthKit support across 19 sample types, smart Insights, AI Coach, Health Score, GLP-1 tracking with Research-Mode-gated drug-level chart, interactive charts with drill-down, push notifications, deep links, and account deletion."

### Screenshots
- [ ] 6.5" iPhone screenshots: cover Onboarding (welcome carousel + permissions), Dashboard (Health Score tile + tile-strip), Insights (sub-page with severity sort), Coach (refusal example to show MDR boundary), Medications (GLP-1 detail stack), Settings (Research Mode toggle + account deletion).
- [ ] 5.5" iPhone screenshots: same set (Apple's legacy size).
- [ ] iPad screenshots if supporting iPad.

### URLs
- [ ] Marketing URL: https://healthlog.bombeck.io (or marketing site once landing repo's v1.4.25 deployed)
- [ ] Privacy Policy URL: **https://healthlog.bombeck.io/privacy** (ships with v1.4.25.1 hotfix)
- [ ] Support URL: https://github.com/MBombeck/HealthLog/issues

### App Review Information
- [ ] Demo account credentials: Marc creates a read-only demo account on `demo.healthlog.dev` and provides credentials in the demo account fields
- [ ] Review notes: explain MDR boundary + AI Coach safety contract + Research Mode gating; reference `/privacy` §7 MDR-boundary. Apple reviewers DO read this and DO check the in-app behavior matches the claim.
- [ ] Sign-in required: yes (provide demo credentials)

### Pricing + Availability
- [ ] Free
- [ ] Availability: select countries (Marc-decision — recommend EU + US + Canada + Australia + Japan for first launch)

## Section 4 — Pre-Submit Final Check

Run through this list:

- [ ] Privacy Policy URL responds 200 (curl https://healthlog.bombeck.io/privacy)
- [ ] iOS Privacy Manifest categories match the App Privacy declarations in §2
- [ ] Demo account works on the demo server
- [ ] iOS app's TestFlight build is on the latest commit
- [ ] Marc has the APNs .p8 backed up to 1Password or similar (see `.planning/v15-apns-key-handling.md`)
- [ ] Marc's Apple Developer Program subscription is active

## Section 5 — Common First-Submission Rejection Reasons (Apple Health-App-Specific)

- Guideline 1.4.1: "Medical claims" — wording in app or screenshots implies diagnosis/treatment → fix: tone down wording, lean on the MDR-boundary disclaimer
- Guideline 5.1.1(v): "Account Deletion missing" — iOS-Claude added this in v0.3.0
- Guideline 5.1.2(i): "Third-Party AI consent" — DEFERRED to v0.3.1 per iOS-Claude release notes; resubmission may flag
- Guideline 5.1.2: "Privacy Manifest mismatch" — see §2; iOS-Claude needs to ensure the manifest matches

## Section 6 — Post-Submit / If Rejected

- Apple's most common rejection language for health apps: "Your app's marketing language and/or in-app content implies the diagnosis or treatment of conditions..."
- Response template: cite GROUND RULES 9 + 15 + /privacy §7 + the screenshot of the in-app MDR-boundary disclaimer. Apple usually accepts a clear, written delineation.
- If rejected, do NOT escalate to App Review Board immediately — first iterate on the in-app wording (move "GLP-1" / "drug-level" to back of UI, add more explicit "This is not medical advice" copy at every Coach surface). Most rejections resolve within 1-2 iterations.

---

**Source links**:
- Apple Health App Guidelines: https://developer.apple.com/app-store/review/guidelines/#health-and-health-research
- Apple App Privacy Details: https://developer.apple.com/app-store/app-privacy-details/
- EU MDR 2017/745: https://eur-lex.europa.eu/eli/reg/2017/745/oj
- MDCG 2021-24 (Software as a Medical Device): https://health.ec.europa.eu/system/files/2021-10/mdcg_2021-24_en_0.pdf
