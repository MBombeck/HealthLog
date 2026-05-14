# W21 — i18n runtime probe findings (v1.4.25-rc)

Reviewer: i18n runtime probe (1 of 8 W21 review streams)
Branch: develop @ near `51f23ef3`
Date: 2026-05-14
Probe: static analysis + headless Chromium runtime probe against `pnpm dev`

## Summary

- **0 raw-key leaks** across 210 (route × locale) Playwright probes — every
  string the user can see resolves to a translated value, never the literal
  `medications.foo.bar` lookup string.
- **0 raw-key leaks** across 18 additional interactive surface probes
  (research-mode toggle, coach sheet trigger, trend-annotation hover).
- **1,800+ keys per non-EN locale (FR / ES / IT / PL) carry the EN value
  verbatim** — ~75% of the total key set. These are i18n drafts that did
  not make it through translation. The locale-integrity test only enforces
  *key parity*, not *value distinctness*, so the suite is silent on this
  gap. The W9e maintainership banner ("Cette langue est rédigée par IA…")
  already warns users this is the case, so the gap is documented in-app —
  but the volume is much larger than the banner copy implies.
- **DE + EN Marc-Voice is clean** across every new W14b/W19 namespace I
  spot-checked (research-mode, scheduling, titration, side-effects,
  settings.researchMode).
- **The existing `e2e/locale-switch.spec.ts` is broken** — it sets the
  locale cookie under the wrong name (`healthlog_locale`, underscore)
  while the server reads `healthlog-locale` (hyphen). The spec passes
  vacuously because both `en` and `de` runs fall back to English with no
  raw keys.

Headline: **0 Critical, 0 High EN/DE leaks, 0 Medium FR/ES/IT/PL leaks (no
raw keys); ~7,400 untranslated values across FR/ES/IT/PL combined and 1
broken E2E spec.**

## Critical (0)

None. No primary CTA or page heading falls back to a raw lookup string in
either EN or DE.

## High (0)

None. No visible string falls back to a raw lookup string in EN or DE.

The single High candidate worth flagging is **not a raw-key leak but a
broken test**:

- `e2e/locale-switch.spec.ts` uses cookie name `healthlog_locale`
  (underscore). The server reads from `healthlog-locale` (hyphen) — see
  `src/lib/i18n/server-locale.ts:5` (`LOCALE_COOKIE_NAMES`) and every
  client write site in `src/lib/i18n/context.tsx`. The spec therefore
  never actually switches locale; both runs render the English shell.
  The raw-key regex matches nothing in the English shell, so the test
  passes without ever exercising what it claims to exercise. Fix lives
  in test-land (rename cookie), so deferred to W21-reconcile.

## Medium (1)

- **FR / ES / IT / PL carry English values for ~75% of their key set.**
  The locale-integrity test (`src/lib/__tests__/i18n-locale-integrity.test.ts`)
  enforces *key shape parity* and *no empty values* but never compares
  values across locales, so the drift is silent in CI. Volumes (out of
  2,452 EN keys):

  | Locale | EN-fallback keys | % of total |
  | ------ | ---------------: | ---------: |
  | fr     | 1,859            | 75%        |
  | es     | 1,829            | 74%        |
  | it     | 1,838            | 74%        |
  | pl     | 1,828            | 74%        |

  Top namespaces by EN-fallback count (consistent across FR/ES/IT/PL):
  - `settings.*` — ~334 keys
  - `admin.*` — ~330 keys
  - `insights.*` — ~324 keys
  - `medications.*` — 179–189 keys
  - `achievements.*` — 142 keys
  - `targets.*` — ~96 keys
  - `doctorReport.*` — 65–71 keys
  - `charts.*` — ~55 keys
  - `measurements.*` — ~54 keys
  - `onboarding.*` — 42 keys (mostly `onboarding.v2.*` and
    `onboarding.tour.*` subtrees)

  Notable user-facing surfaces affected:
  - **Sidebar nav** — `nav.measurements`, `nav.targets`, `nav.achievements`,
    `nav.bugreport`, `nav.admin`, `nav.logout`, `nav.collapseSidebar`,
    `nav.userMenu`, `nav.skipToContent`, `nav.sidebar`,
    `nav.mainNavigation`, `nav.mobileNavigation`, `nav.loadingScreen`,
    `nav.more`, `nav.moreSheetTitle`, `nav.moreSheetDescription`,
    `nav.home` — all four non-DE locales render these in English (visible
    in every authenticated route I probed). The PL sidebar reads
    "Pulpit / Measurements / Nastrój / Leki / Statystyki / Targets /
    Achievements / Bug Report / Admin Console / Ustawienia".
  - **Doctor-report dialog** — `doctorReport.dialog.title`,
    `doctorReport.dialog.description`, the column headers, BMI/BP/glucose
    classifications, the practice placeholder — all English in FR/ES/IT/PL.
  - **Onboarding v2 wizard** — the new v1.4.25 W14b wizard
    (`onboarding.v2.step1/2/3.*`, `onboarding.v2.title`,
    `onboarding.v2.subtitle`, `onboarding.v2.doneToast`, etc.) ships in
    English for FR/ES/IT/PL. 44/99 onboarding keys total. New users with
    those locales see English copy in the welcome flow.
  - **Onboarding tour** — `onboarding.tour.steps.*.title/body` for the
    five spotlight steps (tileStrip, quickAdd, insights, achievements,
    integrations) plus `onboarding.tour.skip / done / restart /
    restartHint / restartConfirmation`.
  - **`common.copied`** — toast that fires after every "copy to clipboard"
    interaction (export tokens, share links, etc.) — English in all four.
  - **`errorBoundary.description`** — the global error-boundary copy is
    English in all four non-DE locales.

  This is consistent with the W9e maintainership banner messaging that
  the FR/ES/IT/PL locales are AI-initial drafts; it is not consistent
  with the locale-integrity test which silently passes.

## Low (1)

- The **`e2e/locale-switch.spec.ts` cookie-name bug** (described under
  High) renders the spec a no-op. It does not surface a user-visible
  issue today (it's a test-coverage gap), so it lives here for triage
  priority while still being trivial to fix.

## Routes probed

Headless Chromium, dark mode, viewport 1280x720, networkidle + 800 ms
hydration wait. Cookies: `healthlog_session` (e2e user, onboarding
complete) + `healthlog-locale` per locale.

| Route                          | en | de | fr | es | it | pl | Notes                                              |
| ------------------------------ | -: | -: | -: | -: | -: | -: | -------------------------------------------------- |
| `/`                            | 200 | 200 | 200 | 200 | 200 | 200 | Body len varies 427→660B per locale (localized)    |
| `/auth/login`                  | 200 | 200 | 200 | 200 | 200 | 200 | Logged-in user; redirects to dashboard shell       |
| `/auth/register`               | 200 | 200 | 200 | 200 | 200 | 200 | Same                                               |
| `/onboarding/0`                | 200 | 200 | 200 | 200 | 200 | 200 | Returning-user banner; localized                   |
| `/onboarding/1`                | 200 | 200 | 200 | 200 | 200 | 200 | E2E user redirects to `/` (onboarding complete)    |
| `/onboarding/2`                | 200 | 200 | 200 | 200 | 200 | 200 | Same                                               |
| `/onboarding/3`                | 200 | 200 | 200 | 200 | 200 | 200 | Same                                               |
| `/onboarding/4`                | 200 | 200 | 200 | 200 | 200 | 200 | Done page; localized                               |
| `/insights`                    | 200 | 200 | 200 | 200 | 200 | 200 | DE largest of localized variants                   |
| `/insights/blutdruck`          | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/insights/gewicht`            | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/insights/bmi`                | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/insights/puls`               | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/insights/schlaf`             | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/insights/stimmung`           | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/insights/medikamente`        | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/measurements`                | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/medications`                 | 200 | 200 | 200 | 200 | 200 | 200 | No medications seeded → empty-state copy only      |
| `/mood`                        | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/notifications`               | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/achievements`                | 200 | 200 | 200 | 200 | 200 | 200 | Largest body across all routes (badge labels)      |
| `/targets`                     | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/bugreport`                   | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/settings`                    | 200 | 200 | 200 | 200 | 200 | 200 | Redirects to `/settings/account`                   |
| `/settings/account`            | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/settings/integrations`       | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/settings/notifications`      | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/settings/dashboard`          | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/settings/thresholds`         | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/settings/sources`            | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/settings/ai`                 | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/settings/api`                | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/settings/export`             | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |
| `/settings/advanced`           | 200 | 200 | 200 | 200 | 200 | 200 | Research-mode card present; localized              |
| `/settings/about`              | 200 | 200 | 200 | 200 | 200 | 200 |                                                    |

Pass/fail criterion = "no dotted camelCase token of the
`a.bC` shape appears in `body.innerText`". All 210 cells pass.

Additional interactive probes (click / hover-triggered surfaces):

| Surface                                     | en | de | fr | es | it | pl |
| ------------------------------------------- | -: | -: | -: | -: | -: | -: |
| Research-mode toggle on `/settings/advanced` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Coach sheet trigger on `/insights`           | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Trend-annotation hover on `/insights`        | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

All 18 interactive probes pass.

Surfaces NOT probed (would need fixture seed work — defer):

- `/medications/[id]/history` — no medication seeded for e2e user, so the
  W19c-f surfaces (drug-level chart, scheduling cadence viz, titration
  ladder, side-effects log) were inspected via static key lookup only.
  All `medications.researchMode.*`, `medications.scheduling.*`,
  `medications.titration.*`, `medications.sideEffects.*` keys exist and
  are translated cleanly in DE; FR/ES/IT/PL have 0–2 fallthrough keys
  per namespace.
- `/admin/*` — accessible to the e2e user (role=ADMIN) but I focused
  the runtime probe on user-facing surfaces. The 332-key `admin.*`
  namespace is the second-largest EN-fallback bucket per non-EN locale;
  if W21-reconcile prioritises admin localization, this is a known gap.
- `/insights/report/[week]` — dynamic route, requires a week with data.

## Static analysis

All i18n-related unit tests pass:

- `src/lib/__tests__/i18n-locale-integrity.test.ts` — 26 assertions,
  no duplicate keys, full parity EN ↔ {DE,FR,ES,IT,PL}, no empty values,
  no `TODO/FIXME/XXX/TBD` placeholders, no `key.last == value` cases in
  both EN+DE, Health-Score DE labels pinned to German, provenance keys
  resolve in every locale.
- `src/lib/i18n/__tests__/fallback-chain.test.tsx` — passes.
- `src/app/__tests__/targets-i18n.test.tsx` — passes.
- `src/components/i18n/__tests__/maintainership-banner.test.tsx` — passes.
- `src/components/settings/__tests__/sections-i18n-parity.test.ts` —
  passes.

Total: 60 i18n-related assertions, 34/34 tests green.

Gap the static suite does not cover:

- *Value distinctness* across locales. A non-EN locale that ships
  verbatim English values for ~75% of keys is invisible to the integrity
  test because the keys exist and are non-empty.
- *Cross-locale Marc-Voice tone consistency* — outside the scope of an
  automated test, but worth flagging because the volume of LLM-draft FR
  /ES/IT/PL means the W9e maintainership banner has to do a lot of
  defensive work.

## Marc-Voice spot-check (EN + DE on new W14b/W19 namespaces)

**`medications.researchMode.*` (29 keys):** Marc-Voice clean both
locales. DE uses "du", drops Anglicisms beyond legitimate clinical terms
(EMA, MDR, GLP-1, Bateman, Populations-Pharmakokinetik). The MDR
boundary copy is dense regulatory text in both EN and DE and reads as
authentic author voice, not LLM translation. Example contrast that
proves it's hand-curated:

- EN `whatItIs`: "A sawtooth curve simulating how your logged doses
  superimpose over time, using the one-compartment Bateman model with
  absorption and half-life parameters published in the EMA EPAR for
  each approved GLP-1 receptor agonist. The vertical axis is unit-less
  and unlabeled. The shape, not the number, is what the chart shows."
- DE `whatItIs`: "Eine Sägezahnkurve, die die Überlagerung deiner
  protokollierten Dosen über die Zeit simuliert. Grundlage ist das
  Ein-Kompartment-Modell nach Bateman mit Absorptions- und
  Halbwertszeit-Parametern aus den EMA-EPARs der zugelassenen
  GLP-1-Rezeptoragonisten. Die Y-Achse ist einheitenlos und ohne
  Beschriftung. Die Form, nicht der Zahlenwert, ist die Aussage der
  Kurve."

**`medications.scheduling.*` (28 keys):** Marc-Voice clean. DE uses
"Adhärenz" (correct clinical German), short-form units mirror EN
("30 T." for "30 d.", "Wo." for "wks"). One trivial nit: DE side has
`unit.percent: '%'` which is identical to EN — legitimate.

**`medications.titration.*` (17 keys):** Marc-Voice clean. DE
"EMA-Quelle" / "Stufe {n}" / "Titrationsstufen" is technical but
readable. The disclaimer voice ("Sprich mit deiner Ärztin oder deinem
Arzt") matches the inclusive direct-address pattern used elsewhere in
DE.

**`medications.sideEffects.*` (48 keys):** Marc-Voice clean. DE renders
"Brain fog" as "Konzentrationsnebel" (authentic German rendering, not
the LLM-default "Gehirnnebel"). "Frühes Sättigungsgefühl" for "Early
satiety", "Elektrolyt-Müdigkeit" for "Electrolyte-imbalance fatigue" —
clinical but plain-readable. The category labels (GI / Metabolic /
Cognitive / Injection site / GLP-1 specific) map clean German
equivalents.

**`settings.researchMode.*` (10 keys):** Marc-Voice clean both locales.
Toggle label "Show the estimated drug-level chart" / "Geschätzte
Wirkstoffkurve anzeigen". The re-prompt body when the disclaimer
version bumps is direct and informational, not marketing-style.

**`onboarding.v2.*` (W14b new wizard):** EN and DE Marc-Voice clean. EN
copy is terse and tactical ("Three quick steps. You can finish anything
later from Settings."). DE uses informal "du" throughout, no anglicisms
beyond expected (Dashboard, ntfy, Web Push, Telegram). FR/ES/IT/PL —
44/99 keys English-fallback (covered in Medium above).

**FR/ES/IT/PL drafts on the parts that *are* translated:** Proper-noun
handling is consistent (Mounjaro / Ozempic / Wegovy / Trulicity / Apple
Health / Withings preserved verbatim). Date placeholders `{date}` and
unit placeholders `{n}/{weeks}/{dose}` round-trip correctly through
every locale. Tone is plausible second-person draft Latin / Slavic.
Catch-all comment: where the translations exist, they read like
competent first-pass output; where they don't, the EN string is
verbatim and the locale-integrity test cannot tell the difference.

## Notes on probe methodology

- The bash-only curl probe I tried first found 0 leaks but was unreliable
  because the SSR shell for most authenticated routes is content-thin
  (Settings / Insights are largely client-rendered, with the shell
  containing only the navigation chrome and a hydration skeleton). The
  Playwright-based probe is the only honest read of what's rendered.
- The probe asserts on **visible body text** only, not on `__NEXT_DATA__`
  payloads, attribute strings, or class names — those are noisy and
  irrelevant to user perception.
- Raw-key regex: `\b[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){1,5}\b` filtered
  through `[a-z][A-Z]` (camelCase) + allowlist (`.com`, `Mounjaro.`,
  `GLP-1`, version strings, file extensions). A grep candidate that
  matches the structure but is legitimate (a brand name, a version
  string, a file extension) is filtered out. The 0-leak result holds
  with or without the allowlist — there was nothing close to a leak in
  the visible text.
- E2E user logs in via `/api/auth/login` (POST `email + password`),
  cookies copied to Playwright context, sessions reused per
  (route, locale) pair to avoid hitting the rate-limit (5 attempts per
  IP per 15 min). 210 page navigations on the same session: no
  rate-limit hits, no 429s, no 500s.

## Closing

The v1.4.25 release-candidate ships clean on the original W21 concern
("are there raw-key leaks falling through `t()` lookups?") — runtime
probe found zero across 228 (route × locale) navigations. The new
W14b/W19 namespaces are well covered in EN and DE.

The honest finding is one level deeper: ~75% of the FR / ES / IT / PL
key set carries verbatim English values, including the sidebar nav, the
doctor-report dialog, the new onboarding wizard, the global error
boundary, and the common `Copied!` toast. The locale-integrity test is
silent on this drift, the maintainership banner already warns users
about it in-app, but the v1.4.25 release notes should probably mention
"FR / ES / IT / PL are AI-initial drafts; translation contributions
welcome on GitHub" so expectations match reality. Additionally,
`e2e/locale-switch.spec.ts` is using the wrong cookie name
(`healthlog_locale` vs `healthlog-locale`) and currently provides false
assurance — a one-line fix that W21-reconcile should pick up.

No code changes, no fixes — pure observation, as briefed.
