# Targets / Zielwerte page redesign — UX research

Author: Research pass commissioned 2026-05-11 ahead of the v1.4.25
pre-iOS polish window.
Scope: how the Targets page should look once the v1.4.22 C1 per-card
sparkline + Δ-vs-last-month caption is removed in v1.4.25 (Marc's
directive — "ungeliebt", looks bad in practice).
Status: research only. No source files are modified by this report.

---

## 0. What's there today (codebase grounding)

- Page: `src/app/targets/page.tsx` (790 lines, single file). Renders
  a header, an optional "profile incomplete" hint, then a
  `grid sm:grid-cols-2 gap-4` of `<TargetCard>` instances.
- API: `src/app/api/insights/targets/route.ts` (780 lines). Emits
  `targets: TargetItem[]`, plus `bpDiastolic` + `profile`. Each
  `TargetItem` already carries `current`, `average30`, `trend` ("up"
  / "down" / "stable"), `unit`, `range`, `classification` (category
  - colour), `source`, and the optional v1.4.22 `points30d` +
    `deltaVsLastMonth`.
- Card composition today:
  1. Icon + label + tiny `<TrendIcon>` (up/down/minus, 4×4 px)
  2. Big 3xl bold current value + small unit + 30-day average caption
  3. `<RangeBar>` (green / orange / red zones, draggable dot,
     min/max labels, hover tooltip)
  4. **v1.4.22 inline sparkline (24 px tall, dracula-purple stroke)**
     **+ "Δ −2.3 kg vs. last month" caption** — both removed in v1.4.25.
  5. `<Badge>` with classification + an external-link reference to
     the guideline source.
- Nav: `/targets` is a top-level route. Sidebar entry
  (`src/components/layout/sidebar-nav.tsx:77-80`) + bottom-nav entry
  (`src/components/layout/bottom-nav.tsx:51`). Auth-gated via the
  shared shell.
- i18n: `messages/en.json:2611-2706` + the mirror block in `de.json`.
  Strings are well-factored (`targets.label.*`, `targets.status.*`).
- Coach drawer: lives only on `/insights` today
  (`src/app/insights/page.tsx:532` holds `coachOpen` state,
  `src/components/insights/coach-panel/coach-drawer.tsx` accepts a
  `prefill` prop). Already plumbed for scope-prefilled prompts —
  see the `CoachScope` schema at
  `src/lib/ai/coach/types.ts:68-85`, which accepts `sources` and
  `window` so a target card could open the drawer pre-narrowed
  to one metric.
- Known backlog gripes already filed against today's page:
  - `phase-W5-v1422-reconcile-report.md` Design M2 — sparkline has
    no min-points threshold, 3 points over 30 days reads "lots of
    activity".
  - Design M7 — SVG is `aria-hidden`, so the only "thing changing"
    cue is invisible to screen readers.
  - Design L3 — `preserveAspectRatio="none"` distorts the y axis
    versus x.
  - Senior-Dev M2 — sparkline is computed via 7 sequential
    `Array.filter` passes inside the route handler.

These four findings, taken together, are the reason the v1.4.22
sparkline addition is being rolled back: even with full data it
distorts, it can't be reasoned about, and it adds visual debt
without adding insight. Removing it is correct. The question this
report answers: **what replaces it?**

---

## 1. Benchmark study — how comparable products structure a "your goals" page

### 1.1 Apple Health — Trends / Highlights / Summary

Apple Health does not have a single "Targets" page. Goal-shaped
content is fragmented across:

- **Summary tab**: a vertical list of cards. Each card is a metric
  thumbnail with the latest value, a tiny D/W/M chip, and a label
  like "Showing Today" or "Last 7 Days". No goal framing at this
  level.
- **Trends tab** (introduced in iOS 15, surfaced inside the Summary
  → Show All Health Data drill): a list of "Heart Rate is trending
  up" / "VO2 Max is trending down" entries. Each row is one metric +
  one sentence + a 26-week sparkline.
- **Activity rings** (the Fitness app, separate surface): the closest
  analogue to a "personal targets" page. Three concentric rings for
  Move / Exercise / Stand, each with a number-vs-goal readout in the
  centre of the ring and a weekly history grid below.

Critique (corroborated by Dr. Drang at leancrew.com/all-this and the
two Medium UX case studies surfaced in the search): the Trends tab
is widely faulted on four counts.

1. **Buried behind multiple taps.** Many users never discover it.
   The Apple Community thread "No Health Trends, plenty of data
   history" is a textbook example — a power user with three years
   of data could not find Trends because it lives at the bottom of
   a long Summary scroll, gated by minimum-data-history rules that
   aren't surfaced.
2. **Inconsistent thresholds.** Dr. Drang shows Apple flagging a
   6 000-step variation as "trending up" but ignoring a 10 bpm
   cardio-recovery swing. The algorithm is opaque to the user.
3. **Step-function fit instead of a regression.** The trend line
   jumps in discrete bands, so a steady drift reads as "no
   change → no change → suddenly higher" rather than "gradually
   higher". Users intuit a linear line, not a Heaviside.
4. **Week-boundary inconsistency.** Health defines weeks
   Sunday-Saturday while Fitness uses Monday-Sunday. The same data
   produces different captions in different tabs.

Lesson for HealthLog: never quietly hide a card behind a data
threshold; never invent a "trending up" rule the user can't
inspect; never compare two windows of unequal length and call it
a delta. The v1.4.22 sparkline already violated #1 implicitly —
it disappeared when `points30d.length < 2` with no caption telling
the user why.

### 1.2 Apple Activity rings (Fitness app)

This is the strongest external precedent for what a target page
**should** look like for a single user:

- Three rings, large, centred, animated to current %.
- Below each ring: numeric "523 of 600 cal" line.
- Below that: a 7-day strip (one column per day, each showing the
  three rings in miniature). Tappable, deep-links to that day's
  detail.
- Edit affordance: top-right "Change Goals" button, opens a
  modal with three steppers.
- The page is short and dense. No vertical scroll on iPhone 14.

The 7-day mini-rings strip is the single most copyable pattern:
it gives "am I on track" + "what does my last week look like"
without a per-card chart. We adapt this in §3.4 below.

### 1.3 Withings Health Mate

Goals are set per-metric inside the Profile tab, not on a dedicated
page. Weight goal UX: a slider that the user drags up/down to the
target, then a second slider that picks the pace (kg/week). On the
metric detail page, the goal renders as a horizontal dashed line
overlay on the chart. There's no separate "all my goals" surface.

Strength: the dashed-line overlay on the chart is unambiguous —
"here's the line, here's where you are, the gap is the delta".
Weakness: setting a goal requires three taps deep into Profile,
and the Heart Score replaces explicit BP / pulse goals with a
composite that few users can decompose.

### 1.4 Garmin Connect — Goals

Garmin's "Goals" page is web-only (the mobile app omits it).
Layout is a card list, one card per goal, each card showing:

- Goal name + sport icon
- Big progress bar (linear, not ring)
- "X of Y completed" under the bar
- "Pace: on track / behind / ahead" pill
- Personal-best comparator pill ("vs. last year: +12 km")
- Edit / delete kebab menu top-right

The UX case study by Sara Vegazo (Medium, "Redesigning Garmin
Connect") explicitly calls Garmin's goal surface confusing because
goals are mixed in with Insights cards rather than living on their
own page. The mobile gap (no goals UI) is also widely complained
about on the Garmin forums.

Lesson: a goal card needs (a) a single dominant progress signal,
(b) an "on track / off track" verbal label that doesn't require
the user to decode a colour, and (c) a comparator. We adopt this
in §3.

### 1.5 Oura — Readiness contributors

Oura's Today screen has three large numeric scores
(Readiness / Sleep / Activity) and a "contributors" expansion under
each. Each contributor renders as a horizontal bar with three
visual cues:

- A coloured horizontal bar showing where the contributor sits
  within its personal-norm band.
- An icon-glyph (sleep, HRV, body temperature) on the left.
- A one-line natural-language sentence ("Sleep efficiency is 12 %
  below your norm") on the right.

There is no sparkline per contributor. Oura's stated design
rationale (Pulse blog "What is Readiness?") is that **a sparkline
distracts from the "is this normal for me?" judgement** the user
is making at-a-glance. The chart lives one tap deeper on the
contributor detail screen. The status sentence is the headline.

This is the cleanest external precedent for HealthLog's redesign.
Adopt the "no per-card sparkline, sentence-as-headline" rule.

### 1.6 MyFitnessPal — Today screen

The 2025 redesign collapsed Goals, Diary, and Habits into one
"Today" screen. The top is a thick horizontal calorie progress
bar with macro bars underneath, then a tappable list of "Goals
& Habits" cards. Each habit card has a streak counter, today's
status (done / not done), and a 7-day dot grid.

The 7-day dot grid is the strongest one-take-away from MFP:
seven coloured dots, green = on target, grey = no data, red =
missed. Cheap to render, instantly scannable, and it answers
"how's my consistency" without a chart. We adopt this in §3.4.

### 1.7 Bearable

Bearable's strength is its tracked-symptom heatmap. Each
"trackable" gets a year-view GitHub-style heatmap. Bearable does
not have an explicit "goals" surface — every trackable is a goal
in disguise. The visual is the calendar heatmap, no progress bar.

Lesson: the calendar heatmap is the right primitive when the
metric is binary "did it / didn't" (logged BP today, took meds
today). Less useful for continuous metrics (weight, BMI) where
the question is "how far from target" not "did I log it".

### 1.8 Strava — Goals graphs

Strava's "Goals Graphs" feature (BikeRadar 2024 coverage) overlays
the actual cumulative metric (green) on top of the goal trajectory
(grey). One chart per goal, on a dedicated Goals page. The goal
trajectory is a straight line from 0 to target over the period.
"On pace" is when the green line is above the grey line for that
date.

Strength: the "pace" framing is honest — it tells the user
whether the _trajectory_ gets them to the goal in time, not just
where they are today. This is the strongest UX answer to "how
long until I hit the goal at my current rate". HealthLog
currently has none of this; we should consider it for one or two
cards (weight loss target, daily-steps target) where the goal is
an accumulating count or a moving-towards-target.

---

## 2. Information hierarchy — what the user actually wants to know

The seven candidate questions from the brief, ranked by the
benchmark-frequency they appear:

| #   | Question                           | Apple | Withings | Garmin | Oura | MFP     | Strava | Bearable |
| --- | ---------------------------------- | ----- | -------- | ------ | ---- | ------- | ------ | -------- |
| 1   | Am I on track right now? (binary)  | yes   | yes      | yes    | yes  | yes     | yes    | partial  |
| 2   | How far from goal? (delta)         | weak  | yes      | yes    | yes  | yes     | yes    | no       |
| 3   | Time-to-goal at current rate?      | no    | partial  | no     | no   | no      | yes    | no       |
| 4   | When did I last meet it? (recency) | no    | no       | no     | no   | weak    | no     | yes      |
| 5   | Best run in last 90 days?          | no    | no       | yes    | no   | yes     | yes    | yes      |
| 6   | What to do today? (actionable)     | weak  | yes      | no     | yes  | yes     | no     | no       |
| 7   | % of days in range last N days     | weak  | no       | no     | yes  | partial | no     | yes      |

Five strong patterns emerge:

- **Q1 is universal.** Every product surfaces a binary or
  three-state pill / colour / icon answering "are you doing well
  right now". HealthLog already has this via the classification
  Badge. Keep it; make it more prominent.
- **Q2 is dominant.** All but Bearable surface a delta-to-goal.
  HealthLog has it inside the RangeBar tooltip — too hidden.
  Surface it as a sentence, like Oura ("12 % below your norm").
- **Q7 is the Oura insight.** "Percentage of days in range over the
  last 30 days" answers a question users actually have ("am I
  consistent or just lucky today?") and is something HealthLog
  already computes for one metric (BLOOD_PRESSURE_IN_TARGET — 70 %
  good, 40 % moderate, < 40 % low). We should generalise that
  metric to every target. This is the **largest gap** in the
  current page.
- **Q3 / Q5 are nice-to-haves.** Pace-to-goal (Strava) and
  best-run-in-90-days (Bearable, MFP) are differentiators we can
  defer to a v1.5 follow-up.
- **Q6 is where HealthLog wins.** Nobody else has a personalised
  AI coach attached to a target. See §5.

### What HealthLog surfaces today vs the gap

| Question        | Today                                  | Gap                                   |
| --------------- | -------------------------------------- | ------------------------------------- |
| Q1 on track     | Badge (classification.category)        | Move it to card-top, larger, leftmost |
| Q2 delta        | Inside RangeBar tooltip (hover-only)   | Promote to prose under headline value |
| Q3 time-to-goal | None                                   | Add for WEIGHT, ACTIVITY_STEPS only   |
| Q4 last met     | None                                   | Add for all                           |
| Q5 best 90-day  | None                                   | Defer to v1.5                         |
| Q6 actionable   | None on this page (Coach is elsewhere) | Add "Ask Coach" CTA per card          |
| Q7 % in-range   | Only for BP                            | Generalise to all metrics             |

---

## 3. Visual hierarchy recommendation

### 3.1 Anti-patterns to avoid

Distilled from §1's critique passes:

- **No per-card sparkline.** Already learned in v1.4.22 C1
  rollback. Reinforced by Oura's stated rationale.
- **No hidden cards.** Never silently drop a card because data is
  thin — Apple's Trends mistake. Show the card with an explicit
  "need N more readings" caption.
- **No opaque trend rules.** The current `computeTrend()` 2 %
  threshold is invisible. Either expose the threshold in the
  tooltip ("trend triggers above ±2 %") or replace with a
  user-readable rule ("trending up = average of last 7 days >
  average of previous 7 days by X").
- **No mixed week boundaries.** HealthLog already uses Berlin tz
  consistently (`berlinDayKey`). Keep it. Caption every window
  ("Last 30 days, Mon-Sun in your timezone") when it's not the
  default.
- **No SVG aria-hidden on the only motion cue** — Design M7 from
  the W5 reconcile.

### 3.2 Recommended card layout (markdown wireframe)

```
┌──────────────────────────────────────────────────┐
│  [icon] Blood pressure              [⚙ kebab]    │  ← row 1
│                                                  │
│  124 / 78  mmHg                  [On target]     │  ← row 2 (status pill MOVED here, right-aligned)
│  Target: 110–130 / 70–80 mmHg                    │  ← row 3 (target + delta as prose)
│  6 mmHg above target band on systolic            │
│                                                  │
│  ┌────────────────────────────────┐              │  ← row 4 (range bar, kept)
│  │  ░░  ▓▓▓▓▓●▓▓▓▓▓  ░░  ░░░░░░  │              │
│  └────────────────────────────────┘              │
│   90       110          150     200              │
│                                                  │
│  Last 7 days  ● ● ◐ ● ○ ● ●     5 of 7 in range  │  ← row 5 (NEW: 7-dot consistency strip)
│  Last met goal: yesterday                        │  ← row 6 (NEW: recency)
│                                                  │
│  [Ask Coach about this] [↗ ESH 2023]             │  ← row 7 (CTAs)
└──────────────────────────────────────────────────┘
```

Translations of the new rows:

- **Row 2 — status moved.** Currently the Badge sits in the footer.
  Lift it to the headline row, right-aligned, same baseline as the
  big number. Reading order: "124/78 — on target". This is the
  Garmin/Oura pattern and the Q1 answer.
- **Row 3 — delta as prose.** Currently the delta lives inside the
  RangeBar tooltip (hover-only). Promote it to a permanent sentence:
  "6 mmHg above target band on systolic". Bilingual via existing
  `targets.aboveTarget` / `targets.belowTarget` / `targets.inTarget`
  i18n keys (already present in `messages/en.json:2633-2635`).
- **Row 4 — RangeBar unchanged.** This is the strongest piece of
  the current page; keep it. It answers Q1 + Q2 visually.
- **Row 5 — 7-day consistency strip.** Replaces the deleted
  sparkline. Seven dots, one per day of the last week. Green = in
  range, yellow = orange band, red = out of range, grey = no
  reading. Cap with a count: "5 of 7 in range". Cheap to render
  (7 absolutely-positioned dots), accessible (each dot gets an
  `aria-label`), honest about thin data ("3 of 7 days logged"
  when grey dots dominate).
- **Row 6 — Recency.** New: "Last met goal: yesterday" or "Last
  met goal: 3 days ago" or "Hasn't hit goal in the last 30 days".
  Uses the existing `relative-time.ts` helper. Important for
  Q4 — the maintainer-tester case (weight goal that hasn't been
  hit in months but the user still has a green pill because
  today's reading lucky-landed in range).
- **Row 7 — CTAs.** Left: "Ask Coach about this" — opens the
  Coach drawer with a pre-filled prompt and scope narrowed to
  this metric. Right: the source link, unchanged but moved
  out of the footer.
- **Kebab menu (row 1, right).** Currently no per-card edit
  affordance — users have to go to Settings → Targets to change
  a threshold. v1.4.16 already shipped per-user
  threshold overrides (`thresholdsJson` on the user row,
  `getEffectiveRange()` in `effective-range.ts`). The kebab opens
  a small popover with "Edit my target" → routes to
  `/settings/targets`. Discoverable; non-blocking.

### 3.3 Headline metric choice

- **Continuous metrics (WEIGHT, BMI, BODY_FAT, PULSE,
  SLEEP_DURATION, ACTIVITY_STEPS, glucose contexts).**
  Headline = today's value (or latest reading) with one-decimal
  precision. The big `text-3xl` already does the right thing
  visually.
- **Compound metrics (BLOOD_PRESSURE).** Headline = `sys / dia`.
  Already correct.
- **Rate metrics (BLOOD_PRESSURE_IN_TARGET, MEDICATION_COMPLIANCE,
  MOOD_STABILITY).** Headline = the percentage (already correct
  for the first two). For MOOD_STABILITY: σ is a poor headline —
  most users can't interpret a standard deviation. **Recommend
  switching** the headline to the verbal label ("Very stable",
  "Stable", "Fluctuating") and demoting σ to a second-tier
  caption. This is a small i18n + render change, no schema work.

### 3.4 Trend without a per-card sparkline

The replacement primitive is the **7-day consistency strip**
(see row 5 above). Concretely:

- 7 dots, 10 px diameter, 6 px gap.
- Each dot represents one Berlin-tz day from `now − 6` to `now`.
- Dot colour from same green/orange/red palette as RangeBar.
- Aggregation rule per day: the day's mean of that metric is
  classified against the green / orange / red bands. If no
  readings, the dot is grey.
- For compound BP, the rule is "the day's mean systolic AND mean
  diastolic both in range".
- For binary metrics (medication-compliance per day already exists
  in `compliance.ts`), green = day's expected doses all taken.
- Caption to the right: "N of 7 in range" (or "N of 7 logged" when
  grey dominates — switch caption to the more informative count).
- Tooltip on hover: the date + the day's value.
- Accessible: each dot has `aria-label="2026-05-08: in range"` or
  similar; the strip is a `<ul role="list">` so screen readers
  read it as a sequence.

Why this works:

- **Honest with thin data.** If only 3 dots are coloured, the
  user sees only 3 dots coloured — there is no curve to fit
  through them.
- **No y-axis distortion** (the Design L3 finding). Categorical
  dots have no continuous scale to compress.
- **Cheap.** 7 absolutely-positioned divs, no SVG, no Recharts
  ResponsiveContainer.
- **Aggregates the right question** — "how consistent am I",
  which is Q7 from the hierarchy.

Optional v1.5 follow-up: extend the strip from 7 days to a
**30-day GitHub-style heatmap** for users who want longer
context. Behind a "show more" toggle so the default view stays
short. Bearable's heatmap is the reference. Use a single colour
ramp from grey → green when in-range, grey → red when out-of-range
(do not mix; the user only sees one band at a time).

### 3.5 Edit affordance

Today: no per-card edit. Users must traverse Settings → Targets.

Recommendation: small kebab top-right of each card. Menu items:

- "Edit my target" → opens a `<Dialog>` with two number inputs
  (min, max) seeded from the effective range. On save, PATCHes
  `/api/auth/me/profile` with `thresholdsJson` populated for that
  metric. Existing route — no API change needed.
- "Reset to guideline" → clears the metric's override row.
- "Disable this card" → `userPrefs.hiddenTargets += type` (new
  user-prefs field; small migration).

The kebab is discoverable but doesn't crowd the card visually
(15 × 15 px lucide icon, `text-muted-foreground`).

### 3.6 Empty state vs full state

Per-card empty (no readings):

- Render the full card chrome (icon, label, target range,
  classification placeholder).
- Replace the big-number row with "No readings yet" + a primary
  CTA `Log {metric}` that deep-links to the relevant add-flow
  (Add Measurement modal, pre-selecting the type).
- 7-day strip renders all grey.
- "Ask Coach about this" CTA disabled (`aria-disabled`) with a
  tooltip "Log a reading first".

Whole-page empty (zero measurements across all types):

- A single `Card` with onboarding copy: "Set up your first
  measurement to see how you're doing against your targets."
  Single CTA: "Add measurement". Linkout to a one-shot guided
  capture.

Profile-incomplete state:

- The current orange-bordered hint card (`targets/page.tsx:750-767`)
  is correct. Keep it. Add per-card sub-states: if heightCm is
  null, the BMI card renders an in-card hint "Add your height in
  settings to unlock BMI tracking" with a CTA, instead of
  silently dropping the card.

---

## 4. Page-level layout

### 4.1 Summary header

**Add it.** A one-row hero at the top of the page summarising the
account-level state:

```
You're meeting 4 of 6 targets today.
You're on a 3-day streak for blood pressure.
```

- Line 1: "X of Y targets met today" — a simple count of cards
  where today's reading sits in the green band.
- Line 2: longest current streak across all metrics, surfacing
  the metric name. Pulls from the streak primitive we will need
  to compute (see §7).
- Subtle CTA on the right: "Ask Coach about my targets" —
  pre-fills "How am I doing against my targets this month?" and
  opens the drawer with all sources enabled.

This is the Q-mix-summary line every benchmark has and HealthLog
doesn't.

### 4.2 Card grid

Today: `grid sm:grid-cols-2 gap-4`. With ~10-12 cards (when
glucose and mood expand), this produces a long scroll on phones
(stacked) and a 2-column wall on desktop.

Recommendation:

- Mobile (`<sm`): unchanged — single column, full-width cards.
- Tablet (`sm-md`): unchanged 2-column.
- Desktop (`lg+`): 3-column. The cards have low information
  density at 2-col on a 1440 px viewport — three cards per row
  matches the dashboard / insights grid and lets the user see
  more above the fold. Cards are short (no inline chart any
  more), so 3-col doesn't crowd.

Cards within the grid should be sorted by **a priority signal**:

1. Cards out of green band, sorted by severity (red first)
2. Cards in orange band
3. Cards in green band
4. Cards with no recent data

This puts the "needs attention" cards at the top — the Oura
contributor sorting pattern. Each user gets a personalised
running order; cards are stable when the underlying state is
stable.

### 4.3 Linkouts to Insights sub-pages

Once v1.4.25 ships the per-metric Insights sub-pages
(`/insights/blood-pressure`, etc. — see
`.planning/research/insights-sub-pages-ux.md`), each Target card
should deep-link to the matching sub-page from the headline value
or the source label. The Target page is the "how am I doing now"
surface; the Insights sub-page is the "tell me more about this
metric". Don't duplicate the chart on Targets — link out.

Concretely: clicking the big-number row navigates to
`/insights/{metric}`. The 7-day strip click can also deep-link
to the sub-page with a query string like `?range=7d` so the
chart paints the matching window.

### 4.4 Where to put the Coach

The Coach drawer currently mounts only on `/insights/page.tsx`.
For v1.4.25, mount it on `/targets/page.tsx` too. The drawer
component is already fully-controlled and accepts a `prefill`
prop — no internal changes required. The page gains a
`coachOpen` state, an `<Sheet>`/`<CoachDrawer>` pair, and per-card
"Ask Coach" buttons that set `prefill` + open. See §5.

---

## 5. The HealthLog edge — Coach hand-off

This is what Apple/Withings/Garmin/Oura cannot do: a personalised
LLM that can answer "why is my blood pressure trending up?" with
the user's own data.

### 5.1 Per-card "Ask Coach" CTA

- Button label: "Ask Coach about this" (EN) / "Coach fragen"
  (DE). Small, secondary variant, left-aligned in the footer row.
- On click:
  - Open the Coach drawer (`setCoachOpen(true)`).
  - Set `prefill` to a metric-specific prompt seeded from the
    card's current state. Examples:
    - WEIGHT: "I'm at 86.2 kg, my target is 70–80 kg, and I've
      gained 1.4 kg over the last month. What should I focus on?"
    - BLOOD_PRESSURE: "My systolic is 6 mmHg above my target band
      and my diastolic is on target. Walk me through what to
      check."
    - MEDICATION_COMPLIANCE: "I'm at 78 % medication adherence
      this week. What can I change in my routine?"
  - Set `scope.sources` to the single matching source if a 1:1
    mapping exists (e.g. `WEIGHT → ['weight']`,
    `BLOOD_PRESSURE → ['bp']`). For derived metrics (BMI →
    weight, MOOD_STABILITY → mood) use the source the metric is
    derived from. `CoachScope.sources` already accepts a partial
    list — see `lib/ai/coach/types.ts:78`.
  - Set `scope.window` to `last30days` (the default; can be
    overridden by the user in the drawer's sources rail).
- The prefill is editable; the user can rewrite before sending.
  This honours the same UX rule the hero-strip suggested-prompt
  chips already follow (`hero-strip.tsx`).

### 5.2 Prompt-template registry

Add a small `src/lib/ai/coach/target-prompts.ts` that exports a
function `buildTargetPrompt(targetType, current, range, status,
delta, days_in_range_7d) → string`. Keep prompts deterministic
and bilingual. Mark `PROMPT_VERSION` bump (Marc's convention).

### 5.3 Account-level Coach CTA in the hero

In the page header (§4.1), the right-side "Ask Coach about my
targets" button opens the drawer with a longer prefill that
references the summary line:

> "I'm meeting 4 of 6 of my health targets today. My longest
> current streak is 3 days for blood pressure. Where am I doing
> well and where should I focus this week?"

Scope: all sources, last 30 days.

### 5.4 Coach-suggested target adjustments (v1.5)

Out of scope for v1.4.25 but worth noting: once the Coach has
streaming + tool-call support, it could propose target
adjustments ("Your sleep target of 8 hours is rarely hit; would
you like me to relax it to 7.5?") and surface an in-chat
"Adjust target" button that hits the existing
`/api/auth/me/profile` endpoint. This is the conversation-driven
goal-setting line item already on the v1.6+ roadmap.

---

## 6. Concrete file-path recommendations (no implementation here)

### 6.1 Files to change

| File                                                       | Change                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------- |
| `src/app/targets/page.tsx`                                 | Delete `<Sparkline>` (lines 264-303). Move `<Badge>` from footer to headline row. Add header summary line. Add 3-col on `lg+`. Mount `<CoachDrawer>`. Sort cards by priority.                                                                 |
| `src/app/targets/page.tsx` (TargetCard)                    | Reflow as the §3.2 wireframe. Add 7-day strip, recency line, "Ask Coach" button, kebab edit affordance. Promote delta-to-prose.                                                                                                               |
| `src/app/api/insights/targets/route.ts`                    | Drop `points30d` + `deltaVsLastMonth` from the response shape. Add `daysInRange7d: number`, `daysLogged7d: number`, `daysInRange30d: number`, `lastMetGoalAt: Date                                                                            | null`, `streakDays: number`. Replace 7-pass per-type computation with a single grouped query (Senior-Dev M2). |
| `src/components/targets/`                                  | New folder. Extract `TargetCard`, `RangeBar`, `ConsistencyStrip`, `TargetHeader` into separate files. Today's 790-line page.tsx is overdue for decomposition.                                                                                 |
| `src/components/targets/consistency-strip.tsx` (new)       | 7-day dot strip primitive. Pure presentational, takes `{ days: ('green'                                                                                                                                                                       | 'orange'                                                                                                      | 'red' | 'none')[]; inRangeCount: number; loggedCount: number }`. |
| `src/components/targets/target-coach-button.tsx` (new)     | Small button that builds the per-target prompt + scope and calls `onAskCoach({ prefill, scope })`. Decouples target cards from coach state.                                                                                                   |
| `src/lib/ai/coach/target-prompts.ts` (new)                 | `buildTargetPrompt(target, locale)`. Bilingual EN/DE. PROMPT_VERSION bump.                                                                                                                                                                    |
| `messages/en.json` + `messages/de.json`                    | New keys under `targets.*`: `summaryHeader`, `streakHeader`, `daysInRange`, `daysLogged`, `lastMetGoal`, `lastMetGoalRelative`, `askCoach`, `editTarget`, `resetToGuideline`, `disableCard`. Remove `deltaVsLastMonth*` + `deltaUnavailable`. |
| `src/components/layout/sidebar-nav.tsx` + `bottom-nav.tsx` | No change. `/targets` stays a top-level route.                                                                                                                                                                                                |
| `docs/api/openapi.yaml`                                    | Regenerate via the v1.4.23 zod-openapi registry. The schema for `GET /api/insights/targets` changes; the registry catches it.                                                                                                                 |

### 6.2 Files to test

- `src/app/__tests__/targets-sparkline.test.tsx` — delete or
  re-purpose for the 7-day strip.
- New `src/components/targets/__tests__/consistency-strip.test.tsx`
  — render with each colour combination, verify aria-labels.
- New `src/app/__tests__/targets-summary-header.test.tsx` —
  "4 of 6" math, streak math.
- Update `src/app/__tests__/targets-i18n.test.tsx` and
  `targets-spacing.test.tsx` for new layout.

### 6.3 Migration considerations

- No DB migration required for v1.4.25 if we compute
  `daysInRange*`, `lastMetGoalAt`, `streakDays` on the fly. These
  are cheap per-user aggregations over the existing
  `measurement` table.
- A future migration (v1.5+) might add a materialised
  `target_state` row per user × target so the page can render
  without a heavy aggregate query on every load. Defer.

---

## 7. New aggregations the API needs (v1.4.25)

For each card, the route needs to surface:

1. **`daysInRange7d` / `daysLogged7d`.** For the last 7 Berlin
   days: how many had at least one reading, and of those, how
   many landed in the green band. Single grouped Prisma query:
   `groupBy(type, day)` filtered to `measuredAt >= now - 7d`.
2. **`daysInRange30d` / `daysLogged30d`.** Same over 30 days.
   Optional for the redesign; useful for the kebab "details"
   popover.
3. **`lastMetGoalAt: Date | null`.** Latest `measuredAt` of a
   reading in the green band. Single `findFirst` per type, ordered
   by `measuredAt desc`.
4. **`streakDays: number`.** Number of consecutive Berlin days
   ending today where the day's mean reading was in the green
   band. Cap at 365. Reuse the day-bucket loop pattern that
   already lives in `lib/analytics/berlin-day.ts`.
5. **`pageSummary: { metTodayCount, totalCount, longestStreakMetric, longestStreakDays }`.**
   Account-level summary for the new header strip.

All five additions live inside `getEffectiveRange()` -aware
classification logic that already exists in the route. The Senior-Dev
M2 backlog item (collapse 7-pass sparkline computation to a single
groupBy) gets paid off in the same pass.

---

## 8. Where this work fits

- **v1.4.25 (pre-iOS final polish).** The right home. This is
  the polish-and-iOS-prep window; the redesign is contained
  (one page + one route + one new primitive + one i18n pass)
  and it removes the v1.4.22 mistake before the iOS app starts
  consuming the same `targets` API. Doing it now means the iOS
  client can render the same five new fields natively, instead
  of being shipped with the sparkline contract and then
  migrated.
- **v1.5 (iOS + Apple Health).** Mirror the redesign in iOS.
  The Coach hand-off works the same way (drawer scope =
  CoachScope.sources for a single metric).
- **v1.6+.** 30-day heatmap behind a toggle; Coach-suggested
  target adjustments with in-chat "Adjust target" tool call;
  pace-to-goal projection for weight + steps; best-90-day-streak
  badge per card.

### Estimate (rough)

- API route changes: 1 day. Mainly the grouped query + new
  computed fields.
- Page reflow + new primitives (ConsistencyStrip,
  TargetCoachButton, header strip): 1 day.
- Coach hand-off (mounting drawer on Targets, prefill templates,
  PROMPT_VERSION bump): 0.5 day.
- i18n EN/DE pass + screen-reader pass: 0.5 day.
- Tests (consistency strip, summary header, snapshot drift): 0.5
  day.
- Multi-agent QA + reconcile (Marc's standard for releases): 0.5
  day.

Total: ~4 dev days inside v1.4.25, with the discovery now
complete and the contract fully sketched.

---

## 9. Open questions for Marc

1. **Confirm "ungeliebt" = "currently feels low-priority + chartless"** rather than "we should kill the page entirely".
   Recommendation in this report is to keep the page and re-aim it
   at the consistency-and-coach combination. Alternative reading:
   merge it into Settings → Targets and surface a target-status
   chip on the Insights mother page instead. The recommendation
   stands if the page should remain a navigable surface — confirm
   before implementation.
2. **Three columns on desktop.** Verify against the dashboard / insights row
   widths. If the design tokens have already standardised
   `2xl:grid-cols-3`, follow that; if not, this report introduces
   the rule.
3. **Card priority sorting.** Some users may prefer a stable
   visual order (e.g. WEIGHT always top-left). If so, expose a
   small toggle in user prefs ("Sort by status" vs "Fixed order")
   and default to "by status". Decision needed.
4. **Mood-stability headline switch.** Recommend changing the
   headline from "0.42 σ" to "Very stable". Small change but
   user-visible. Confirm.

---

## 10. Citations

### Codebase paths investigated

- `src/app/targets/page.tsx` (current page, 790 lines)
- `src/app/api/insights/targets/route.ts` (current API, 780 lines)
- `src/components/insights/coach-panel/coach-drawer.tsx` (Coach
  drawer contract, used as the hand-off target)
- `src/lib/ai/coach/types.ts:68-85` (`CoachScope` schema; the
  prefill scope for per-card hand-off)
- `src/lib/analytics/berlin-day.ts` (timezone-correct day bucket
  primitive, used for 7-day strip)
- `src/lib/analytics/classifications.ts` (the green/orange/red
  band classifiers; reused by the day-classification rule for
  the consistency strip)
- `src/lib/analytics/effective-range.ts` (per-user threshold
  overrides; reused by the per-card "edit my target" kebab)
- `src/lib/analytics/compliance.ts` (medication day-bucket
  source-of-truth)
- `src/components/layout/sidebar-nav.tsx` / `bottom-nav.tsx`
  (nav routing; no change needed)
- `messages/en.json:2611-2706` + de.json (i18n surface)
- `.planning/phase-W5-v1422-reconcile-report.md` (W5 Design
  M2 / M7 / L3 + Senior-Dev M2 findings against the v1.4.22 C1
  sparkline — confirms removal is correct)
- `.planning/v1422-backlog.md` (sparkline findings parked for
  v1.4.23+)
- `.planning/research/insights-sub-pages-ux.md` (sister research
  pass on `/insights` carve-up; the deep-link target for "Tell me
  more about this metric")
- `.planning/ROADMAP.md` (v1.4.25 polish window confirmation;
  Marc directive 2026-05-14)

### External benchmarks

- Apple Health Trends critique — Dr. Drang, leancrew.com:
  https://leancrew.com/all-this/2024/11/apple-health-trends/
- Apple Community "No Health Trends, plenty of data history":
  https://discussions.apple.com/thread/254189834
- Apple Health UX case study — Kbeauchamp:
  https://medium.com/@kbeauchamp2/apple-health-re-design-ux-case-study-eb18f6b894b0
- Apple Health UI/UX case study — ncao6:
  https://medium.com/@ncao6/ui-ux-case-study-apple-health-0b2361204a93
- Apple Health 2025 hidden features:
  https://apple.gadgethacks.com/how-to/apple-health-hidden-features-finally-revealed-for-2025/
- Withings Health Mate weight-goal docs:
  https://support.withings.com/hc/en-us/articles/201491327-Health-Mate-Online-Dashboard-Setting-a-weight-goal
- Withings iOS health-goal setting:
  https://support.withings.com/hc/en-us/articles/202313656-Health-Mate-iOS-App-Setting-a-weight-goal
- Withings Heart Score:
  https://support.withings.com/hc/en-us/articles/15547200464273-Withings-Health-Improvement-Score
- Oura Readiness Score docs:
  https://support.ouraring.com/hc/en-us/articles/360025589793-Readiness-Score
- Oura Pulse blog "What is Readiness?":
  https://ouraring.com/blog/what-is-readiness/
- Oura Readiness Contributors:
  https://support.ouraring.com/hc/en-us/articles/360057791533-Readiness-Contributors
- Oura Activity Score:
  https://support.ouraring.com/hc/en-us/articles/360025577993-Activity-Score
- Garmin Connect Goals docs:
  https://support.garmin.com/en-US/?faq=4vH4ZpBjoq0kefON1bJOE6
- Garmin Connect redesign case study — Sara Vegazo, Medium:
  https://medium.com/@s.vegazosancho/ux-ui-case-study-redesigning-garmin-connect-app-62a52b154d95
- MyFitnessPal 2025 Today screen redesign:
  https://blog.myfitnesspal.com/myfitnesspal-today-screen-progress-tab-update/
- MyFitnessPal goals & progress section:
  https://support.myfitnesspal.com/hc/en-us/sections/360006006852-GOALS-CHECK-IN-AND-PROGRESS
- Bearable Health Tracker:
  https://bearable.app/health-tracker/
- Bearable App Review 2025 (Choosing Therapy):
  https://www.choosingtherapy.com/bearable-app-review/
- Strava Goals docs:
  https://support.strava.com/hc/en-us/articles/6822535085709-Goals-on-the-Strava-App
- Strava Progress Summary Chart:
  https://support.strava.com/hc/en-us/articles/28437860016141-Progress-Summary-Chart
- Strava Goals Graphs (BikeRadar):
  https://www.bikeradar.com/news/strava-goals-graphs
- Quantified Self forum — personal dashboards:
  https://forum.quantifiedself.com/t/personal-dashboards-for-self-tracking-data/8202
- Awesome Quantified Self (resources index):
  https://github.com/woop/awesome-quantified-self
- Calendar heatmap pattern (Elysia Tools):
  https://elysiatools.com/en/tools/calendar-heatmap
- react-activity-heatmap (reference implementation):
  https://github.com/stefan5441/react-activity-heatmap
