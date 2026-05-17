# v1.4.38 W-QA-3 — UX / responsive / a11y findings

Scope: `v1.4.37.2..HEAD` on `develop`. READ-ONLY review. Live site is
v1.4.37.2; develop holds W-A through W-F. Findings are graded P0 →
P3 against shipping the v1.4.38 tag.

Severity legend:
- **P0** — must fix before tag (correctness / a11y break / user-data
  visible bug)
- **P1** — should fix before tag (UX regression on a primary surface or
  i18n string break)
- **P2** — fix in v1.4.38.x (polish; not blocking)
- **P3** — nice-to-have / log for v1.4.39

Summary counts:
- P0: 1
- P1: 2
- P2: 3
- P3: 4

---

## P0 — must fix before tag

### P0-1 — i18n placeholder break in 3 locales: `medications.glp1NextInjectionDays`

**File:** `messages/{fr,it,pl}.json` (key `medications.glp1NextInjectionDays`)

The W-E i18n wave (commit `d95820ab`) translated the GLP-1 cluster but
the merged value is a **broken hybrid string** — half-translated label
joined to a still-English `(in {days} days)` tail:

- `fr`: `"Suivant:{label} (in {days} days)"`
- `it`: `"Avanti:{label} (in {days} days)"`
- `pl`: `"Dalej:{label} (in {days} days)"`

Expected shape (mirrors the German source):
- `de`: `"Nächste:{label} (in {days} Tagen)"`
- `en`: `"Next:{label} (in {days} days)"`

User impact:
- `Glp1MedicationCard.nextInjectionLabel()` (`src/components/medications/glp1-medication-card.tsx:301-305`)
  is the consumer. When a GLP-1 medication's next injection is ≥ 2
  days away (the modal case for weekly drugs) the user sees a mid-
  string English fragment inside otherwise fully-localised French /
  Italian / Polish copy.
- Marc-Voice violation: ships as English literal inside three locales.
- Also the missing space after the colon (`Suivant:{label}` →
  `Suivant : {label}` would be the French typographic convention) is a
  secondary nit but the **English-tail leak is the blocker**.

The W-E report tested `i18n-drift-guard` and `quick-add-labels` but the
GLP-1-NextInjectionDays key has no contract test pinning placeholder
shape; the hybrid passed silently. Recommend a 4th test in
`quick-add-labels` style for the GLP-1 cluster as the follow-up.

Suggested fix (one-line per locale):
- `fr`: `"Suivant : {label} (dans {days} jours)"`
- `it`: `"Prossima: {label} (tra {days} giorni)"`
- `pl`: `"Następne: {label} (za {days} dni)"`

---

## P1 — should fix before tag

### P1-1 — Polish `compliance7d` divergence: parenthesised vs. unparenthesised duplicate

**File:** `messages/{fr,it,pl}.json`

Grep confirms two competing renderings of the same key shipped across
the i18n waves:

- `compliance7d` appears twice in `pl.json` (lines differ):
  - `"Przestrzeganie (7 dni)"` (with parens)
  - `"Przestrzeganie 7 dni"` (without)
- Same drift in `fr.json` (`"Observance (7 jours)"` vs `"Observance
  7 jours"`) and `it.json` (`"Aderenza (7 giorni)"` vs `"Aderenza 7
  giorni"`).

Likely cause: two separate W-E commits (`03952deb` medications status
chips and `b776daf5` insights health-score / Coach) each added their
own version. JSON parser keeps the **second** declaration of a
duplicate key, so the user sees the second value at runtime and the
first one is dead — but the JSON file is technically malformed
(RFC-8259 says "objects SHOULD have unique names").

Action:
1. De-duplicate. Pick the parenthesised form for the medication
   compliance bar (matches DE `"Compliance (7d)"` rhythm) and drop the
   parenless siblings.
2. Add a `i18n-locale-integrity` assertion that flags duplicate keys
   within a JSON tree (currently only flags missing/extra keys).

### P1-2 — Coach gated routes: client error-mapping has no `assistant.disabled.coach` branch

**Files:**
- `src/components/insights/coach-panel/use-coach.ts:359-407`
- `src/components/insights/coach-panel/coach-drawer.tsx`
- `messages/{de,en}.json` — no `coach.disabled` / `assistant.disabled`
  copy detected via grep
- Backend: `src/app/api/insights/chat/[id]/route.ts:32,55` +
  `src/app/api/insights/chat/messages/[id]/feedback/route.ts:63`
  (W-C properly added `requireAssistantSurface("coach")`)

The W-C orphan-API gating is **correct on the server** — the 403
envelope carries `meta.errorCode = "assistant.disabled.coach"`
(`src/lib/feature-flags/index.ts:137-147`). But the client
`useSendCoachMessage` send path reads `response.json().error` and falls
through to `coach.http.403`:

```ts
// use-coach.ts:380-401
const envelope = (await response.clone().json()) as { error?: unknown };
if (typeof envelope?.error === "string") {
  structured = envelope.error;          // "assistant.disabled.coach"
}
setStreaming({ ..., errorCode: structured ?? `coach.http.${response.status}` });
```

The errorCode is preserved on `streaming.errorCode`, but the drawer's
error toast/copy table does **not** branch on `assistant.disabled.coach`
— the envelope's `meta.errorCode` slot is also ignored (the client
reads `.error`, the server emits the human code via `.error` AND the
machine code via `.meta.errorCode`).

Result for the user scenario the task brief asked about (Coach OFF +
stale client opens the drawer):
- `GET /api/insights/chat` 403 → conversations list reads
  `coach.disabled.coach` as the error string → renders as a generic
  TanStack `isError` state (no copy)
- POST attempts → drawer shows `coach.http.403` (literal token) or
  raw `assistant.disabled.coach` token, neither of which has a
  translation entry

User sees either: empty rail with no explanation, or a literal
machine-code error string. Not a crash, but **not a clean operator-
disabled message** either.

Recommend either:
- (preferred) wire a `coach.disabled` / `assistant.disabled` copy key
  across `messages/{de,en,es,fr,it,pl}.json` and branch the drawer's
  error renderer on `errorCode === "assistant.disabled.coach"` to show
  it.
- (fallback) gate the entire Coach drawer mount on a client-side flag
  hydrated from `/api/feature-flags` so a stale client never tries to
  POST.

---

## P2 — fix in v1.4.38.x

### P2-1 — `MeasurementList` drill-down `aria-controls` panel id is on `TableRow` (desktop)

**File:** `src/components/measurements/measurement-list.tsx:626`

W-D P1-1 (`1fd76f26`) added `aria-controls={drilldownId}` on the
chevron button and `id={drilldownId}` on the disclosed `<TableRow>`.

Browser-side WAI-ARIA expects the controlled panel to be a region the
AT can describe coherently; some screen readers (NVDA + VoiceOver
Safari) skip `aria-controls` when the target is a `<tr>` because it
lives inside the implicit `<tbody>` and doesn't expose a landmark.
Mobile branch (line 754) wraps in a plain `<div>` which works.

Low-impact (the `aria-expanded` toggle still announces) but the
desktop chevron's promise of "controls X panel" doesn't fully land on
VoiceOver-Safari. Consider wrapping the drill-down `DayDrillDown` in
a `<div role="region">` rendered inside the `<TableCell colSpan={6}>`
and moving the `id` onto that wrapper.

### P2-2 — `quickAddMedicationIntake` translations diverge in semantic register

**Files:** `messages/{de,en,es,fr,it,pl}.json` key
`dashboard.quickAddMedicationIntake`

- en: "Log medication intake"
- de: "Einnahme erfassen" (short — W-D P1-3 fix)
- es: "Registrar toma"
- fr: "Saisir une prise"
- it: "Registra assunzione"
- pl: "Zarejestruj przyjęcie"

The 3-row dropdown menu in `page.tsx:586-606` reads top-to-bottom as
"Messung / Stimmung / Einnahme erfassen" on DE — the verb is the
SAME ("erfassen"). On FR the verbs differ ("Saisir une mesure" /
"Saisir une humeur" / "Saisir une prise" — assumed; please verify the
other two rows match `Saisir`). On ES, IT, PL the verb register is
correct.

Not a translation **error**, but Marc-Voice asks each locale's menu to
read with the same verb rhythm as DE/EN. Verify and align in v1.4.38.x.

### P2-3 — `DropdownMenuContent max-w-[calc(100vw-2rem)]` clipping risk

**File:** `src/app/page.tsx:577`

W-D P1-3 added `max-w-[calc(100vw-2rem)]` to the Hinzufügen dropdown.

On 320 px viewport (iPhone SE 1st gen):
- `100vw - 2rem` = `320 - 32` = `288 px`
- Polish "Zarejestruj przyjęcie" + `Pill` icon + `mr-2` gap +
  DropdownMenuItem internal `px-2` padding ≈ 260-270 px — fits.

On 280 px (Galaxy Fold folded):
- max-w = `280 - 32` = `248 px`
- Polish row at ≈ 270 px would clip / wrap.

Lucide icon + text wrap to a second line in the DropdownMenu (the
shadcn default is `flex` not `flex-wrap`), so the row would still be
readable but the icon would sit centred over a 2-line label —
visually awkward. Acceptable for v1.4.38 (Galaxy Fold is < 0.1% of
traffic) but worth a `whitespace-nowrap` audit pass before v1.5.

---

## P3 — log for v1.4.39

### P3-1 — Select trigger `pr-2` vs Safari date-input

**File:** `src/components/ui/select.tsx:56`

W-D P1-6 (`b6aefc67`) cut `pr-2.5` to `pr-2`. Confirmed visually
consistent now on Chromium-Material AND Safari/Chromium-legacy
gutters. No follow-up needed; logged so the v1.4.39 design-token sweep
doesn't re-lift it.

### P3-2 — GLP-1 / generic medication card icon pill colour pairing

**Files:** `glp1-medication-card.tsx:413-422`,
`medication-card.tsx:312-321`

W-D P2-3 applied `CircleCheck` / `AlertCircle` / `AlertTriangle`
symmetrically to both cards. Verified parity. The icons are
`size-3.5` (14 px) which is at the low end of the legibility floor —
icons-paired-with-colour passes WCAG 1.4.1 regardless of icon size,
but on a P3 OLED at 100% scaling the icon is barely distinguishable
from the text glyph. Bump to `size-4` in v1.4.39.

### P3-3 — Dashboard sparkline DAY-bucket mean visual character

**File:** `src/app/api/dashboard/summary/route.ts:323-334`

W-F now reads `measurement_rollups.mean WHERE granularity='DAY'`
instead of the raw measurement firehose. For sparklines (≤ 7 points,
one per calendar day) this is **byte-identical** to the prior result
for single-sample-per-day metrics (weight, BMI, BP) because the day's
single sample IS the day's mean.

For high-frequency metrics (steps, sleep duration, active energy) the
prior raw-data sparkline rendered the **last sample of the day** —
the rollup change paints the **mean of the day**. Visually:
- Steps: rollup mean of per-source step samples can read materially
  different from "the day's headline total". Steps is a CUMULATIVE
  type — the v1.4.37 W7c daily-sum collapse is what the user expects.
  Confirm `measurement_rollups.mean` for cumulative types is
  populated as a SUM-day-mean (i.e. one row per day with the day
  total) or rework the sparkline projection to use `r.sum` instead of
  `r.mean` for the CUMULATIVE_DAY_SUM_TYPES set.
- Sleep: mean across a day reads close to the single nightly
  reading; safe.
- Pulse: a meaningful smoothing — actually nicer than the raw last-
  sample noise.

**Investigation flag (not a defect yet):** verify the
`measurement_rollups` aggregator emits `mean` correctly for
CUMULATIVE_DAY_SUM_TYPES; if it emits true mean across per-hour
chunks, the dashboard steps tile sparkline will read low compared to
the daily-sum that the metric strip's headline value shows.

### P3-4 — JSON duplicate-key audit drift

The P1-1 duplicate `compliance7d` keys would have been caught by a
linter; suggest adding a `pnpm test:i18n-uniqueness` step that walks
`messages/*.json` and asserts each leaf path is declared exactly once.

---

## Re-confirmation of v1.4.37.x perf wins at the UI layer

- `HealthScoreCard` full-height: W-D P2-4 explicit no-op. Verified
  the `grid-rows-[auto_auto_auto_auto_auto_1fr_auto]` track holds.
- Dropdown nowrap: W-D P1-3 applied via DE label shortening + max-w
  clamp. Confirmed.
- Target card gap (`gap-3 md:gap-4`): W-D P1-5 no-op confirm. Status
  pill is on title row, not headline-adjacent. Confirmed.
- Mood chart parity: not in this diff's scope; no regression
  introduced.
- Dashboard button alignment (`items-center sm:items-start`): W-D
  P2-5 explicit no-op confirm. Behaviour preserved.

All v1.4.37.x perf wins **remain visible at the UI layer**; nothing
in v1.4.38 reverses them.

---

## Files inspected

- `src/components/measurements/measurement-list.tsx`
- `src/components/ui/select.tsx`
- `src/components/medications/glp1-medication-card.tsx`
- `src/components/medications/medication-card.tsx`
- `src/components/insights/insight-status-card.tsx`
- `src/components/onboarding/getting-started-checklist.tsx`
- `src/components/settings/arztbericht-hero-card.tsx`
- `src/components/dashboard/medication-intake-quick-add.tsx`
- `src/app/page.tsx`
- `src/app/api/insights/chat/[id]/route.ts`
- `src/app/api/insights/chat/messages/[id]/feedback/route.ts`
- `src/components/insights/coach-panel/use-coach.ts`
- `src/lib/feature-flags/index.ts`
- `src/app/api/dashboard/summary/route.ts`
- `messages/{de,en,es,fr,it,pl}.json` (sampled)
- `.planning/phase-W-D-v1438-ux-polish-report.md`
- `.planning/phase-W-E-v1438-i18n-localization-report.md`
