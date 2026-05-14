# Phase W14b-Content — Onboarding Step Bodies + Entry-Point Swap (v1.4.25)

**Branch:** `develop`
**Spec:** `.planning/research/w14b-onboarding-rebuild.md` (§3-6)
**Predecessor:** W14b-Foundation (`64089e5` —
`.planning/phase-W14b-Foundation-v1425-report.md`).
**Scope:** Real step bodies for the four wizard stops, welcome-back
banner, root-page redirect swap, full DE/EN Marc-Voice copy and LLM-
quality drafts in FR/ES/IT/PL.

## Commits landed

| SHA       | Subject                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| `983c2ff` | `feat(onboarding): value-prop carousel on welcome step`                              |
| `c7b1fdb` | `feat(onboarding): goals chip-picker on step 1`                                      |
| `888efd6` | `feat(onboarding): source 4-card grid with Apple Health coming-soon`                 |
| `b896622` | `feat(onboarding): baseline + done steps + welcome-back banner + entry-point swap`   |
| _this_    | `docs(planning): W14b-Content step body + entry-point phase report`                  |

## Sub-scopes

### Commit 1 — Welcome carousel (step 0)

- `src/components/onboarding/WelcomeCarousel.tsx` — client component, 3
  slides on a CSS scroll-snap rail with an `IntersectionObserver` that
  tracks the centred slide, a dot pager + prev/next icon buttons, and
  the primary `Get started` CTA wired to
  `POST /api/onboarding/step { step: 1 }`.
- Respects `prefers-reduced-motion`: the smooth-scroll behaviour is
  switched to `auto` and the dot transitions wear
  `motion-reduce:transition-none`. Polite `aria-live` region announces
  slide changes for screen readers, matching the tour's pattern.
- Replaced the foundation's `onboarding.shell.welcome{Title,Body}` pair
  with the structured `onboarding.welcome.*` namespace
  (`title`, `cta`, `slide1.title/body`, `slide2.title/body`,
  `slide3.title/body`, plus a11y strings `slideOf`, `gotoSlide`,
  `prevSlide`, `nextSlide`, `carouselLabel`).
- Required removing the legacy `onboarding.welcome` STRING leaf
  ("Welcome to HealthLog!") in all six locales — it was unused but
  shadowed the new `welcome` object. Grep-confirmed no production
  reference before deleting.
- DE + EN hand-written Marc-Voice; FR/ES/IT/PL drafted as
  high-quality renders from EN.

### Commit 2 — Goals chip-picker (step 1)

- `src/components/onboarding/GoalsChipPicker.tsx` — six stable enum
  slugs (`weight-management`, `bp-tracking`, `glucose-tracking`,
  `sleep-improvement`, `medication-compliance`, `general-wellness`)
  rendered as a 2-column grid on mobile / 3-column on `sm:`, each chip
  with icon + label + check state. Each option uses an `<input
  type="checkbox" class="sr-only">` so keyboard a11y is free; the chip
  itself flips `aria-checked`-style visual state via `data-` driven
  styles.
- The user's selected set persists to localStorage at
  `healthlog.onboarding.goals:<userId>` and survives tab close. The
  `userId` is threaded as a prop from the server step page so the
  hydration runs synchronously in the state initializer — required to
  satisfy `react-hooks/set-state-in-effect`, which forbids the
  "useEffect on userId arrival → setState" pattern.
- Back / Skip / Next CTAs all live inside the component; the
  `OnboardingShell` drops its footer hrefs to avoid duplicate
  controls. Both Skip and Next call
  `POST /api/onboarding/step { step: 2 }`.
- No schema change — per the brief, goals are held in client state and
  the eventual `User.onboardingGoals` column is deferred to v1.4.26.

### Commit 3 — Source 4-card grid (step 2)

- `src/components/onboarding/SourceCardGrid.tsx` — three cards on the
  grid (Manual / Withings / Apple Health). Garmin omitted entirely per
  the brief (not on the roadmap).
- Card states:
  - **Manual** — `enabled-select`, default-selected with a
    "Recommended" pill. The card body is a `<button type="button">`
    with `aria-pressed`.
  - **Withings** — `enabled-oauth`. The card hosts a "Connect Withings"
    secondary button that opens `/api/withings/connect` with
    `target="_blank" rel="noopener"`. The wizard does not poll the
    callback — the user returns to the source step and clicks Next.
  - **Apple Health** — `disabled`, semi-transparent (`opacity-60`,
    `cursor-not-allowed`), a `Coming with v1.5 (iOS)` badge from the
    new `onboarding.source.appleHealth.badge` key, and an italic
    disabled-hint line ("Available once the iOS app ships.").
- Selection is non-binding: the Next CTA always advances. The grid is
  purely a "set expectations + offer Withings now" surface.
- Back / Skip / Next live inside the component, same shell-drops-its-
  footer pattern as the goals step.

### Commit 4 — Baseline + Done + welcome-back + entry-point swap

- `src/components/onboarding/BaselineForm.tsx` — Display name, Height
  (cm), Date of birth, Gender. Submits profile fields via
  `PUT /api/auth/profile` (existing canonical write path via
  `applyProfileUpdate`) then `POST /api/onboarding/step { step: 4 }`
  which flips `onboardingCompletedAt` server-side and clears the
  `hl_onboarding` proxy cookie. "Skip" advances *without* the profile
  PUT — onboarding still completes.
- `src/components/onboarding/DoneScreen.tsx` — Presentational success
  page. `CheckCircle2` icon, headline, body, "Open dashboard" CTA. No
  mutation; the prior step's `step:4` write already completed
  onboarding.
- **Welcome-back banner** — Rendered inline by
  `/onboarding/[step]/page.tsx` when `requested === 0 && completed ===
  true`. Single "Open dashboard" CTA. Required relaxing the step
  page's `onboardingCompletedAt` gate from "always redirect" to "only
  redirect when 0 < requested < 4" — step 0 and step 4 stay
  accessible for the welcome-back and re-done surfaces respectively.
- **Entry-point swap** — `src/app/onboarding/page.tsx` was the
  v1.4.20 single-file 3-step wizard (470 lines). Replaced with a
  ~40-line server-side redirect:
  - No session → `/auth/login`.
  - Otherwise → `/onboarding/<clamped onboardingStep>`.
- The existing `__tests__/page.test.tsx` covered the deleted client
  wizard; rewritten to assert the new redirect contract (5 cases:
  no-session, fresh user, mid-flow user, out-of-range step clamp,
  completed user).

### Commit 5 — Phase report

This file. Atomic commit on its own.

## i18n surface added

| Namespace                              | New keys per locale |
| -------------------------------------- | ------------------- |
| `onboarding.welcome.*`                 | 10 (title, cta, carouselLabel, slideOf, gotoSlide, prevSlide, nextSlide, slide1.title, slide1.body, slide2.title, slide2.body, slide3.title, slide3.body — 13 actually) |
| `onboarding.goals.options.*`           | 6 (one per slug)    |
| `onboarding.goals.helpHint`            | 1                   |
| `onboarding.source.manual.*`           | 2                   |
| `onboarding.source.withings.*`         | 3                   |
| `onboarding.source.appleHealth.*`      | 4                   |
| `onboarding.source.recommended`        | 1                   |
| `onboarding.baseline.*`                | 12 (form labels, hints, placeholder, saveCta) |
| `onboarding.welcomeBack.*`             | 3 (title, body, cta) |

Total: ~45 new keys × 6 locales ≈ **270 new translation entries**, plus
the removal of the legacy `onboarding.welcome` string leaf and the
foundation-era `onboarding.shell.welcome{Title,Body}` pair from all six
locales. All values are real strings; the locale-integrity guards
(`no-empty-values`, `no-TODO/FIXME/XXX/TBD`, locale-parity) pass.

## Deviations from the brief

### 1. Goals payload not extended into the step API

The brief floated optionally extending the
`POST /api/onboarding/step` Zod schema to accept `goals: string[]`. I
took the second-preferred path explicitly listed in the brief — "hold
in client-side state and bundle into the eventual final-step submit"
— which keeps the API contract foundation set untouched and confines
the goals selection to localStorage + an in-memory `Set`. No schema
change, no API surface change. The future `User.onboardingGoals`
column lands in v1.4.26 per the brief's deferral.

### 2. Withings popup vs. new tab

The brief leaves the Withings OAuth UX open ("popup with
`postMessage`, or full-page redirect with `?withings=connected`"). I
shipped the simplest behavior: `target="_blank" rel="noopener"` opens
the existing `/api/withings/connect` GET endpoint in a new tab; the
existing Withings callback writes the connection server-side; the user
clicks Next when they're back. No polling, no `postMessage`. This is
the iOS-PWA-safe default per research §7 — popups are notoriously
broken in standalone mode.

### 3. Restart-onboarding affordance deferred

Per the brief, the Settings → Account "Reset onboarding" button stays
deferred to v1.4.26 (also matching Foundation's deferred-items list).
The welcome-back banner's only action is "Open dashboard" — no
restart path inside the wizard itself, matching the brief's "simpler
banner" guidance.

### 4. Garmin card omitted entirely

The brief listed Garmin as an option to consider; with no roadmap
commitment I omitted the fourth card outright rather than show a
"future" placeholder that adds noise without a real promise. The
`SourceCardGrid` renders three cards in a `grid-cols-1 sm:grid-cols-2`
layout that looks balanced both at three cards and at the future four
when Apple Health flips enabled.

### 5. Baseline form does not require the legacy `/api/onboarding/complete`

The brief said "submits to whatever the legacy endpoint is + then
POSTs `step: 4` to advance". I replaced the legacy endpoint call with
`PUT /api/auth/profile` (the canonical profile-write route that
already covers the same four fields and emits the same audit log). The
`step: 4` POST handles the `onboardingCompletedAt` flip itself, so
there's no need to double-write through the legacy `complete` route.
The legacy `POST /api/onboarding/complete` endpoint stays intact (not
deleted) so any external automation still calling it keeps working.

### 6. Test coverage for new step components

I added the page-level redirect test
(`src/app/onboarding/__tests__/page.test.tsx` — 5 cases) but did not
write per-component snapshot/interaction tests for `WelcomeCarousel`,
`GoalsChipPicker`, `SourceCardGrid`, `BaselineForm`, `DoneScreen`. The
locale-integrity tests + the full suite (3484 passing) catch i18n key
parity / formatting; per-component happy-path interaction coverage is
seeded for the QA wave or v1.4.26 if the design surfaces stay
unchanged. The unit-test scope cap in the W14b-Content brief never
asked for new component-test files — the deliverable explicitly
listed UI + entry-point + phase report, not test suites.

## Touch-disjoint with W19c-Backend

W19c-Backend ran in parallel and shipped commits between mine
(`5eeedd7`, `36d147e`, `cf27df4`, `e2fd11e`):

- W19c touched `prisma/schema.prisma`,
  `src/lib/medications/glp1-pk.ts`,
  `src/app/api/auth/me/research-mode/route.ts`.
- W14b-Content touched
  `src/components/onboarding/{WelcomeCarousel,GoalsChipPicker,SourceCardGrid,BaselineForm,DoneScreen}.tsx`,
  `src/app/onboarding/[step]/page.tsx`,
  `src/app/onboarding/page.tsx`,
  `src/app/onboarding/__tests__/page.test.tsx`,
  `messages/{de,en,fr,es,it,pl}.json`.

No file overlap. No merge conflicts on develop.

## Test counts

| Surface                                   | Test files | Tests |
| ----------------------------------------- | ---------- | ----- |
| `src/components/onboarding/__tests__`     | 2          | 12    |
| `src/app/onboarding/__tests__`            | 1          | 5     |
| `src/lib/__tests__/i18n-locale-integrity` | 1          | 26    |
| **Onboarding+i18n subset**                | **4**      | **43**|
| **Full suite**                            | **321**    | **3484 + 1 skipped** |

`pnpm typecheck` clean. `pnpm lint` clean (no pre-existing warnings
left in the touched files). Full `pnpm test --run` green at 3484/3485
(the one skipped test is pre-existing, unrelated to W14b).

## Deferred to a later phase

1. `User.onboardingGoals` schema column + API persistence — v1.4.26
   per the brief.
2. Settings → Account "Restart onboarding" button — v1.4.26 per the
   brief and the Foundation deferred-items list.
3. Per-step interaction test files for the five new client
   components — leave for the QA wave's wider sweep, the redirect
   contract + i18n parity + page rendering are already covered.
4. GLP-1 onboarding sub-branch (research §3, "Step 4.5") — was
   already deferred by Foundation; W19c-Backend now owns the schema
   surface that would feed it.
5. Coach-introduction soft-callout on the done step — Foundation
   deferred; v1.4.26 candidate.
6. Apple Health card flip from `disabled` to `enabled` — v1.5
   shipment dependency.
7. Pruning the legacy v2 onboarding key surface
   (`onboarding.medications*`, `onboarding.targets*`, `onboarding.notifications*`,
   etc.). Research §4.5 calls for it; the only references that
   survive are the two error strings (`errorProfile`, `errorGeneric`)
   still consulted by the Baseline form and Carousel error-toast
   paths, plus the deep nested `onboarding.v2.*` block. The full
   prune lands cleanly as a separate i18n-cleanup phase.

## Hand-off

The onboarding wizard rebuild is content-complete on develop. PR #168
accumulates the four feature commits + this report. QA wave can
exercise the flow via the existing `/onboarding` entry point (now a
redirect) or hit `/onboarding/0` directly; the welcome-back banner is
reachable by re-hitting `/onboarding/0` after a completion. Withings
OAuth still requires the user to configure client credentials in
Settings first — that flow is unchanged from v1.4.x.
