# W14b Onboarding Rebuild — Research

**Status:** Research, read-only, no code changes.
**Target release:** v1.4.25 (last release before the v1.5 iOS launch).
**Scope:** Replace the v1.4.20-era 3-step wizard at `/onboarding` with a polished,
mobile-first, value-first flow that scales to iOS-funnelled traffic.
**Inputs:** current implementation in this repo, Marc-directive 2026-05-14,
external onboarding patterns from Withings Health Mate, Apple Health, Oura,
MyTherapy, Strava and accessibility / progressive-onboarding literature.

---

## Section 1 — Current HealthLog onboarding inventory

### 1.1 Surfaces involved

There are **three distinct onboarding surfaces** in HealthLog today, plus
one server-side gate:

| Surface                                                  | File                                                                       | Trigger                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The wizard at `/onboarding`                              | `src/app/onboarding/page.tsx`                                              | Server redirect from `src/proxy.ts:163–180` when the `hl_onboarding=pending` cookie is set                |
| The dashboard spotlight tour                             | `src/components/onboarding/tour.tsx` + `src/components/onboarding/tour-launcher.tsx` | First dashboard visit *after* wizard completion; gate flag `user.onboardingTourCompleted`            |
| The persistent "Getting started" checklist on dashboard  | `src/components/onboarding/getting-started-checklist.tsx`                  | Visible while `onboardingCompletedAt == null` *or* `measurementCount < 5` and not user-dismissed          |
| DB flags                                                 | `prisma/schema.prisma` — `User.onboardingCompletedAt`, `User.onboardingTourCompleted` | Persisted; cookie `hl_onboarding` (`src/lib/auth/session.ts`) mirrors `onboardingCompletedAt`             |

### 1.2 The wizard (3 steps)

From `src/app/onboarding/page.tsx`:

1. **Step 1 — About you.** Display name, language, height, gender, date of
   birth — six fields stacked on one screen. (lines 217–317)
2. **Step 2 — First measurement.** Inlines the production
   `<MeasurementForm>` and considers the step "done" on first success.
   (lines 320–350)
3. **Step 3 — One notification channel.** Radio group of Telegram /
   Web Push / ntfy / Skip; the chosen channel deep-links into
   `/settings/notifications#<hash>`. (lines 353–414)

A `role="progressbar"` with `aria-valuemin/max/now` is rendered between
the header and the form (lines 191–214) — accessibility scaffolding is
already in place. The wizard always calls `POST /api/onboarding/complete`
on finish, which sets `onboardingCompletedAt = NOW()`, optionally writes
profile fields, and clears the proxy cookie
(`src/app/api/onboarding/complete/route.ts:62`).

### 1.3 UX flaws identified

1. **No value-prop screens.** Wizard opens directly with a profile
   form; no "what HealthLog does" pitch. Every reference app starts
   with value before asking for data.[¹][²][³] Apple HIG: experiencing
   the app *is* the best onboarding.[⁴]
2. **Step 1 is too dense for mobile.** Six fields on one card overflow
   the 393 px Pixel-5 viewport once the keyboard opens. Mobile-first
   apps pace 1–2 fields per screen.[⁵]
3. **Step 2 mounts `<MeasurementForm>` raw** — same component the
   dashboard uses. No "What do you have?" pre-selector. The success
   state (line 340) dead-ends with only a Continue path.
4. **Step 3 forces a single channel.** The radio group excludes
   users who want Telegram *and* Web Push — they re-enter Settings
   afterwards. The deep-link also flips the CTA label between
   "Finish setup" and "Continue in Settings" (line 450), muddying the
   contract.
5. **No Withings step.** OAuth — the marquee integration — appears
   only in the post-wizard checklist. With Apple Health bridging in
   v1.5, the gap widens.
6. **No GLP-1 branch.** Strongest niche per Marc memos; invisible in
   onboarding.
7. **No Coach introduction.** BYOK Coach is the differentiator;
   discovered organically at best.
8. **No resume across sessions.** Step state is component-local
   `useState`; closing the tab in Step 2 wipes Step 1's input.
9. **i18n key sprawl.** Parallel `onboarding.*` and `onboarding.v2.*`
   trees (70 leaf keys in `messages/en.json`); legacy
   `targetsTitle / medicationsTitle / medScheduleHint` keys are dead
   but still translated across all six locales.
10. **Subjective "unsexy" feel.** No illustrations, no animation, no
    brand beyond the 48 px Logo. Comparators use distinct
    illustration treatment (Withings photographic hero[⁶],
    Strava orange activity carousel[¹]).
11. **Checklist collapsed by default** (`getting-started-checklist.tsx:120–128`).
    A deliberate v1.4.15 fix, but it means skipped onboarding items
    rarely re-surface.

---

## Section 2 — Best-of-breed comparison

### 2.1 Withings Health Mate

Pageflows documents **33 screens**: Bluetooth permission → 3-slide
welcome carousel → sign-up → email verification → T&C → name/DOB/gender →
Apple Health permissions → notifications → first device pairing.[²]
Dribbble's official template[⁶] shows the signature 2018 layout —
full-bleed photographic hero on top half, white card on bottom half,
one headline + one paragraph + one CTA.

**Borrow:** 3-slide value-prop carousel; single-question-per-screen
pacing; 50/50 hero+card layout; permission timing (post-account,
pre-dashboard).
**Reject:** 33 screens (Withings users tolerate setup because they
just bought a device — our users haven't); forced email verification
(we use passkey/password); mandatory device-pairing.

### 2.2 Apple Health (iOS)

HIG: onboarding "should be fast, fun, and optional. […] Ideally,
people can understand your app or game simply by experiencing it."[⁴]
HealthKit uses **fine-grained per-type permissions** at the point of
use, with per-type `NSHealthShareUsageDescription`.[⁷]

**Borrow:** "Fast, fun, optional" framing; permissions at first use;
skip everywhere non-critical.
**Reject:** Pure-discovery model — BYOK Coach + Withings genuinely
cannot be discovered without prompting.

### 2.3 Oura Ring

Charger plug → email → T&C → pair ring → fit check, then a profile
questionnaire (age, sex, weight, height, goals).[⁸][⁹] Crucially, Oura
sets the expectation that *a few days of baseline data are required*
before insights appear.[¹⁰]

**Borrow:** Baseline expectation-setting — our `trendHintFor`
(`src/lib/onboarding/checklist.ts:172`) needs ≥ 5 readings; users
should know that upfront. Hero-feature pairing in-flow (Withings /
Apple Health), not after.
**Reject:** Hardware-first sequencing.

### 2.4 MyTherapy (medication-focused, German market)

MyTherapy's German page[¹¹] explicitly markets four pillars:
medication reminders, refill management, health journal, doctor
collaboration.

**Borrow:** Doctor-report angle as a value slide (maps to our
`/reports` feature). Tone (`"Pünktlich und sicher"`) for German hero
copy.
**Reject:** Pure medication-tracker positioning — HealthLog is broader.

### 2.5 Strava

**14–21 screens**[¹²][¹³] front-loaded with value: record-your-first-activity
within ~60 s of open; account + permissions slotted around it.[¹⁴]
UXCam cites Strava as the canonical "first meaningful action priority"
exemplar.[¹⁵]

**Borrow:** "First meaningful action" framing — for us that's
*log first measurement* **or** *connect Withings*, user's choice.
Goal-selection screen ("What are you here to track?") to seed the
pre-filled measurement form.
**Reject:** 21 screens; aggressive upfront notification / location
requests.

### 2.6 Cross-cutting guidance

UXCam[¹⁵] and UserOnboarding Academy[¹⁶] converge on:
**(1)** value before account/permission asks; **(2)** progress
indicators improve completion; **(3)** skip on every non-critical
step; **(4)** defer permissions (in-context opt-in rates rise 20–40 %);
**(5)** progressive disclosure beats upfront wizards.

Accessibility literature[¹⁷][¹⁸] requires `aria-valuenow/max`,
`aria-current="step"`, focus-moves-to-step-heading on each transition,
`<fieldset>/<legend>` for grouped controls, and session-resume
support for users with motor/cognitive disabilities.

---

## Section 3 — Step-list recommendation for HealthLog

Proposed flow, **6 screens** with 2 conditional branches. Mobile-first;
each screen ≤ 1 vertical viewport on Pixel-5 (393 × 851) with keyboard
open.

| #     | Screen                       | Purpose                                                                                       | Skip?     | Persists?                          |
| ----- | ---------------------------- | --------------------------------------------------------------------------------------------- | --------- | ---------------------------------- |
| **0** | **Welcome carousel (3 slides)** | Pitch the three pillars: Track → Understand → Share. 50/50 hero + card layout à la Withings.    | "Skip intro" link top-right | No                |
| **1** | **About you**                | Display name, language, date of birth, gender. Two fields per screen, paced. (drop height to step 2 bundling) | Skip individual field | `User.displayName/dateOfBirth/gender/locale` |
| **2** | **What do you track?**        | Multi-select chips: Blood pressure, Weight, Glucose, GLP-1, Mood, Workouts. Drives later defaults and unlocks GLP-1 branch. | Skip → defaults to BP+Weight | `User.dashboardWidgetsJson` seed (Marc: confirm slot) |
| **3** | **Connect a source (optional)** | Three cards: **Withings**, **Apple Health** (iOS only — feature-flagged for v1.5), **Manual**. Withings opens OAuth in new tab, returns via callback. | "I'll do this later" | `WithingsConnection`; otherwise no-op |
| **4a** | **First measurement** *(if Manual chosen on #3)* | Pre-selected metric based on #2 choices, single big input pad, save → toast.            | "Skip — I'll log later" | `Measurement` row + reads `onboardingStep=4` |
| **4b** | **Sync running** *(if Withings/Apple Health chosen on #3)* | Live counter ("Synced 12 measurements from the last 30 days…"). Auto-advances when ≥1 row lands or after 5 s timeout. | Auto-advances | Withings `lastSyncedAt` |
| **5** | **Notifications**            | Single yes/no card per channel; can pick multiple. Telegram, Web Push, ntfy. Permission ask only fires when user toggles ON, not preemptively. | Skip all  | `NotificationChannel` rows         |
| **6** | **You're set**               | Streak-style success screen: "Logged 1 measurement · Connected Withings · 2 channels". CTA "Open dashboard" → dashboard with tour. Optional secondary CTA: "Meet your Coach" (only if BYOK key exists OR admin-key is configured). | n/a       | Sets `onboardingCompletedAt`       |

**Branching logic:**

- If `trackingGoals` (Step 2) includes `glp1`, append a Step 4.5 prompt
  to "Log your first injection — your weekly tracker is ready" with a
  link straight to the GLP-1 injection-site picker. Rationale: niche
  user-segment per Marc's directive.
- If user is on iOS Safari and v1.5 iOS Health is shipped, replace the
  Withings card on Step 3 with an Apple Health card.
- Coach introduction moved to step 6 (secondary CTA) and the
  `/settings/integrations/coach` page, **not** an onboarding step.
  BYOK is enough friction that putting it in the critical path costs
  more than it saves.[⁴][¹⁵]

**Doctor-report:** advertised on the **welcome carousel** as slide 3
("Share with your doctor in one tap"); the user discovers the actual
`/reports` page organically post-onboarding via the value-prop seed.
Avoid making it an onboarding step.

**What we cut from current flow:**

- Height entry — defer to Profile page; height is non-essential for
  the first session (BMI calculation can wait).
- The "Pick one channel" radio (Step 3 v1.4.20) — replaced by the
  per-channel toggle screen which allows multi-select.

---

## Section 4 — Architectural decisions

### 4.1 Step state — persist `User.onboardingStep`

**Decision:** add `User.onboardingStep Int @default(0)` (nullable would
also work; default-0 keeps schema simpler), updated on every "Continue"
click via `POST /api/onboarding/progress`. The wizard reads it on mount
and resumes at the highest non-skipped step.

**Why:**

- Multi-day onboarding is normal for health apps (people get
  interrupted by life).
- Mirrors Oura's "set up later" affordance and Strava's
  resume-from-where-you-left-off.[⁸][¹²]
- WCAG 2.1 best-practice for multi-step forms expects save-and-resume
  for motor/cognitive accessibility.[¹⁷]

**Cost:** one migration; one new API route; one extra `useQuery`
on wizard mount. Trivial.

### 4.2 Skip-and-resume

- Per-step "Skip" is non-destructive (writes `skippedSteps: number[]`
  to the same row).
- "Skip everything" on top-right of the welcome carousel performs the
  same `POST /api/onboarding/complete` the current wizard does, then
  redirects to dashboard with the *full* "Getting started" checklist
  expanded (override the v1.4.15 default-collapsed). This is the user
  who skipped on purpose and gets the gentle nudge.
- Re-trigger: an explicit "Restart onboarding" button in
  `Settings → Account` (next to the existing "Restart tour" button at
  `src/components/onboarding/tour-launcher.tsx`'s sibling). Wipes
  `onboardingStep`, `onboardingCompletedAt` and re-redirects.

### 4.3 A/B testability

**Decision: ship without A/B infrastructure.**

- Reasoning: HealthLog has no analytics framework beyond the
  optional Umami integration; building A/B funnel splits for a
  single user would be over-engineering.
- Instead, log step-transition events to the existing `AuditLog` table
  with a stable schema (`onboarding.step.complete`,
  `onboarding.step.skip`) so once we have multi-user telemetry post-iOS
  launch we can read funnel drop-off retroactively.

### 4.4 Mobile-first

- Every step ≤ 1 viewport on Pixel-5 393×851 *with* keyboard open
  (≈ 393×400 visible).
- Single-column always; the current `sm:grid-cols-2` row in Step 1
  (`page.tsx:272`) goes.
- Tap-targets ≥ 44 px per WCAG 2.5.5 — already established by the
  v1.4.15 H4 tour fix (`tour.tsx:425`), continue the same
  `min-h-11` floor.
- iOS PWA viewport must respect the `--safe-area-inset-bottom` (the
  home-bar overlap) — wrap the primary CTA in a `pb-[max(env(safe-area-inset-bottom),1rem)]`
  container.

### 4.5 i18n parity

- Drop the dead `onboarding.targetsTitle / medicationsTitle / medScheduleHint`
  keys from all six locale files
  (`messages/{de,en,es,fr,it,pl}.json`) in the same PR.
- Add the new W14b keys under `onboarding.v3.*` (don't reuse v2 so
  partial rollout is safe) and run the i18n-coverage gate (per
  `docs/audit/v1415-i18n-coverage.md`) before merge.
- German is the highest-priority locale per Marc memos; commission
  the German strings first, machine-translate the rest, hand-review
  Italian + Polish (smallest user base).

### 4.6 Accessibility (WCAG 2.1 AA)

Per the accessibility-multi-step-form study[¹⁷]:

- `role="progressbar"` with `aria-valuemin`, `aria-valuemax`,
  `aria-valuenow`, `aria-label="Step X of Y"` — already
  in place.
- Add `aria-current="step"` to the current step's progress-dot.
- On every step transition, move focus to the `<h2>` step heading
  (currently the focus stays on the "Continue" button — fine, but
  screen-reader users lose orientation). Apply `tabIndex={-1}` to the
  heading so it accepts programmatic focus.
- Wrap each step's controls in `<fieldset><legend class="sr-only">` —
  Step 1 today uses bare `<Label>` pairs with no grouping.
- Polite `aria-live` region announcing transitions ("Now on step 3 of
  6: Connect a source"). Pattern already proven in
  `src/components/onboarding/tour.tsx:374–382`.
- Keyboard: Esc dismisses (returns to dashboard with
  `onboardingStep` persisted so Continue picks up later). Tab cycles
  forward inside the card; Shift+Tab back. Already proven by tour
  trap (`tour.tsx:286–308`).
- `prefers-reduced-motion`: disable the carousel auto-advance and the
  card slide animation between steps (the current wizard has no
  animation, so this is a new commitment).

---

## Section 5 — Markup pattern sketch (no code)

### 5.1 Routing

Promote `/onboarding` to a **route segment with nested step pages**
instead of one giant client component:

```
src/app/onboarding/
  layout.tsx              # <OnboardingShell>: logo + progress dots + main slot
  page.tsx                # redirects to /onboarding/welcome (or last step)
  welcome/page.tsx        # Step 0
  about/page.tsx          # Step 1
  goals/page.tsx          # Step 2
  source/page.tsx         # Step 3
  measurement/page.tsx    # Step 4a (manual branch)
  sync/page.tsx           # Step 4b (auto-sync branch)
  notifications/page.tsx  # Step 5
  done/page.tsx           # Step 6
```

Benefits over the current single-file approach:

- Each step gets its own bundle → faster TTI on mobile.
- Browser back/forward works natively — currently
  `setStep((s-1) as 1|2|3)` is the only "back" path, and back-button
  exits the wizard.
- Skip-to-step deep links are free (`/onboarding/source` resumes
  there).

### 5.2 Component shape

- `<OnboardingShell>` (layout): logo, progress strip (6 dots),
  `<main>`, primary CTA strip pinned to the safe-area bottom.
- `<StepCard>`: standard 50/50 hero illustration + form card on
  mobile, side-by-side on ≥ 768 px.
- `<StepFooter>`: "Back" (ghost) + "Continue" (primary) +
  "Skip this step" (small underline-on-hover link). Always
  three buttons; visibility of Back governed by step index.
- `<WelcomeCarousel>`: a 3-pane horizontal slider with dots; respects
  `prefers-reduced-motion`.
- `useOnboardingState()`: SWR-style hook that reads `User.onboardingStep`,
  exposes `complete(stepId)` and `skip(stepId)` mutations writing to
  `POST /api/onboarding/progress`.

### 5.3 Server contract

New endpoint:

```
POST /api/onboarding/progress
  { step: number, completed: boolean, skipped: boolean }
```

Existing `POST /api/onboarding/complete` stays — called by Step 6 to
flip `onboardingCompletedAt`.

Add a `GET /api/onboarding/state` endpoint returning
`{ step, skippedSteps, trackingGoals }` so the wizard layout can
resume without N+1 calls.

---

## Section 6 — Edge cases

1. **Mobile portrait + keyboard open.** One input per visual block;
   correct `inputMode` (`tel` for DOB on iOS, `decimal` for numbers);
   CTA pinned `position: sticky; bottom: 0` with backdrop blur,
   wrapped in `pb-[max(env(safe-area-inset-bottom),1rem)]`.
2. **Returning user mid-flow.** Proxy still redirects (cookie
   pending); layout reads `onboardingStep` and router-replaces to
   `/onboarding/<last-step>`. DB + cookie kept in sync via
   `setOnboardingPendingCookie`.
3. **Expired session mid-flow.** Step submissions are
   `requireAuth()`-guarded; on 401, the query client refreshes and
   replays the mutation; toast only on second failure.
4. **Locale switch mid-flow.** `setLocale` is reactive; re-render in
   place, do not navigate. "Step X of 6" is already `t()`-driven.
5. **Dark mode.** Carousel illustrations need a dark variant
   (CSS-tinted SVG preferred). Logo already adapts via `text-primary`.
6. **iOS PWA standalone.** No URL bar; safe-area bottom padding
   becomes mandatory.
7. **Slow network / no JS.** SSR the welcome carousel so first paint
   is value, not a spinner; hydrate to interactive.
8. **Restart onboarding.** Resets `onboardingStep=0` and
   `onboardingCompletedAt=null`; must also call
   `setOnboardingPendingCookie(true)` to re-arm the proxy gate.
9. **Family-shared device.** Apply the user-scoped sessionStorage
   key pattern from `tour-launcher.tsx:59–65` to any wizard-side
   ephemeral state.
10. **Admin-created users.** Today admin-only registration via
    `src/app/api/auth/register/route.ts`; new user inherits
    `onboardingCompletedAt=null`. Wizard must not block first-login
    password-change flow.

---

## Section 7 — Open questions for Marc

1. **Account creation deferral.** Today registration is admin-driven.
   Should v1.5 iOS launch open public sign-up, and if yes, does the
   onboarding flow need a "Create account" step *before* Step 0, or
   does the iOS app handle sign-up natively before the WebView is
   ever shown?
2. **Apple Health step at v1.4.25?** Apple Health bridge ships in v1.5.
   For v1.4.25 should the Step 3 card show **Apple Health (coming
   soon)** to seed expectations, hide it entirely, or only show it
   when a feature-flag is enabled?
3. **GLP-1 branch placement.** Step 4.5 (after "What do you track?"
   chose GLP-1) injects a first-injection prompt. Acceptable, or
   should GLP-1 onboarding be a separate flow accessible only from
   `/medications/glp1`?
4. **Doctor-report onboarding stance.** Carousel slide 3 advertises
   "Share with your doctor". Should we instead include a step that
   *generates* a starter PDF for them to download, or only seed the
   value-prop and let them discover `/reports`?
5. **Coach introduction.** Step 6 secondary CTA ("Meet your Coach")
   only when a key exists. Should we instead make the **lack** of a
   Coach key prompt a soft callout on Step 6 ("Add a Claude/OpenAI key
   in Settings to unlock your Coach")?
6. **Withings OAuth UX.** OAuth opens a new tab — should it be a
   `window.open` popup with `postMessage` callback, or a full-page
   redirect that returns to `/onboarding/source?withings=connected`?
   Popup is slicker on desktop, but iOS PWA standalone mode is
   notoriously bad at popups.
7. **Persist or redo height.** Today the wizard collects height.
   Proposal drops it (defer to profile settings). Confirm — or do we
   need it for the Coach prompt's BMI context?
8. **Should the welcome carousel slides reference Marc personally /
   reference real numbers / show example screenshots?** Per the
   "no-PII in user-facing artifacts" memo, real numbers and Marc's
   personal data are forbidden. Synthetic example screenshots
   ("Anna, age 42 …") need confirmation that they're acceptable.
9. **"Restart onboarding" parity with tour-restart.** The existing
   tour-restart button (`onboarding.tour.restart`) lives in
   `Settings → Account`. Add the wizard-restart next to it, or in a
   different section ("Setup" sub-page)?
10. **Removing `onboarding.v2.*` keys.** Once v3 ships and `onboardingCompletedAt`
    is non-null for every user, the v2 keys are dead — but
    pre-v1.4.25 users still in the funnel might still hit them. Do we
    keep v2 strings for one release as a safety net, or drop them
    immediately at v1.4.25?

---

## Citations

External — [¹] App Fuel, *Strava — Onboarding*, theappfuel.com/examples/strava_onboarding · [²] Pageflows, *Withings Healthmate Onboarding Flow on iOS*, pageflows.com/post/ios/onboarding/withings-healthmate · [³] Mobbin, *Withings Health Mate iOS Onboarding Flow* (33 screens, preview), mobbin.com · [⁴] Apple HIG, *Onboarding*, developer.apple.com/design/human-interface-guidelines/onboarding · [⁵] Reteno, *Strava App Onboarding Flow Screens*, gallery.reteno.com/flows/app-screens-strava · [⁶] Dribbble, *Health Mate — Onboarding Flow* (Withings, 2018), dribbble.com/shots/4784931 · [⁷] Apple Developer, *Authorizing access to health data (HealthKit)*, developer.apple.com/documentation/healthkit/authorizing-access-to-health-data · [⁸] Oura Partners Support, *Member Onboarding and Consenting Data*, partnersupport.ouraring.com/hc/en-us/articles/28560644825491 · [⁹] Oura Support, *Create and Manage an Oura Account*, support.ouraring.com/hc/en-us/articles/360025441234 · [¹⁰] Tom's Guide, *Set up your new Oura Ring* (Dec 2025), tomsguide.com/wellness/smart-rings · [¹¹] MyTherapy DE, mytherapyapp.com/de · [¹²] Mobbin, *Strava Android Onboarding Flow* · [¹³] Pageflows, *Strava onboarding tasks screenshot* · [¹⁴] Dribbble, *Onboarding for Strava app* · [¹⁵] UXCam, *12 Apps with Great User Onboarding (2026)*, uxcam.com/blog/10-apps-with-great-user-onboarding · [¹⁶] UserOnboarding Academy, *What Is Progressive Onboarding?*, useronboarding.academy/post/progressive-onboarding · [¹⁷] Accessibility.chat, *Accessible Multi-Step Forms* · [¹⁸] W3C, WCAG 2.1, w3.org/TR/WCAG21.

Internal — `src/app/onboarding/page.tsx` (current wizard); `src/components/onboarding/tour.tsx` (reference for keyboard/focus-trap/`aria-live`); `src/components/onboarding/tour-launcher.tsx` (resume-state pattern); `src/components/onboarding/getting-started-checklist.tsx`; `src/lib/onboarding/checklist.ts`; `src/lib/onboarding/tour-state.ts` (mirror for the new wizard state machine); `src/proxy.ts:163–180` (must keep working); `src/app/api/onboarding/complete/route.ts` (+ new `progress/route.ts`); `src/lib/auth/session.ts` (`setOnboardingPendingCookie`); `prisma/schema.prisma` (add `onboardingStep Int @default(0)`); `messages/{de,en,es,fr,it,pl}.json` (new keys under `onboarding.v3.*`).
