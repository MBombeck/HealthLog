# GLP-1 Injection Tracking — Holistic Integration Research

**Marc directive 2026-05-14**
**Scope:** Research only — survey the GLP-1 tracker landscape and propose how to wire injectable GLP-1 receptor agonist support into HealthLog without bolt-on feel.
**Author:** research run, no implementation.

---

## TL;DR

The dedicated GLP-1 tracker space (Shotsy, Glapp, Pep, InjectionLog, MeAgain, MyTherapy) has converged on six features that the existing HealthLog medication model does not natively cover: **(1)** body-map injection-site rotation, **(2)** weekly-cadence reminder pattern, **(3)** dose-titration history with current-vs-planned dose, **(4)** structured side-effect logging correlated to dose changes, **(5)** pen/vial inventory countdown, and **(6)** weight-curve annotations on injection days.

HealthLog already has the primitives — `MedicationSchedule.daysOfWeek` supports weekly cadence today (the reminder worker filters on it at line 347), `Measurement.weight` is already first-class, the AI Coach already has a medication-compliance hook in its snapshot, and the spotty "compliance %" view treats weekly-cadence drugs gracefully. The gaps are: **injection-site state**, **dose-as-of-date history** (current `Medication.dose` is a single string), **side-effect logging surface**, and **GLP-1-aware Coach context**.

Recommended scope split:

- **v1.4.25 foundation (3 cheap wins, ~1 day):** category-aware classification, weekly-cadence dashboard caption, Coach snapshot extension for active weekly-cadence meds.
- **v1.4.26 first cut (~5 days):** injection-site state on Medication, dose titration history table, GLP-1 dashboard tile, weight-chart injection markers.
- **v1.5 polish:** side-effect logging surface, pen-inventory countdown, dedicated `/insights/medikamente` therapy-timeline view, GLP-1-aware Coach prompts (plateau detection, dose anniversary).

Hard no on nutrition tracking, photo upload, drug-interaction checking, coupon integration, and social comparisons — all explicitly out of scope per Marc and HealthLog DNA.

---

## Section 1 — Existing app landscape

### Dedicated GLP-1 trackers

**Shotsy** ([shotsyapp.com](https://shotsyapp.com/), [App Store](https://apps.apple.com/us/app/shotsy-glp-1-tracker/id6499510249)) — iOS + Android, free. The category leader. Tracks dose, weight, side effects, with an interactive medication-level curve based on peer-reviewed pharmacokinetic data for semaglutide / tirzepatide / liraglutide / dulaglutide. Auto-imports weight, calories, protein, water from Apple Health. Suggests next rotation site but only by general area (abdomen/thigh/arm), not point-precise. Customizable weekly reminders. Watch app. Complaints in reviews: limited body-map granularity, no cycle-over-cycle "where exactly" history. ([Done Dose review](https://www.donedose.com/guides/best-glp1-tracker-app))

**Glapp** ([glapp.io](https://glapp.io/)) — Free native iOS, also a web app. Strong on **estimated medication-in-system curve** (the "where am I in the weekly cycle" plot users obsess over on r/Mounjaro), pen/vial expiration countdown, common-side-effect quick-log (nausea, constipation, diarrhea, fatigue), titration-step guidance, "missed dose" recovery guide.

**Pep** ([pepglp1.com](https://pepglp1.com/), [App Store](https://apps.apple.com/us/app/glp-1-tracker-pep/id6504788281), [Play Store](https://play.google.com/store/apps/details?id=com.shredapps.glp1)) — iOS + Android. Covers Ozempic, Wegovy, Mounjaro, Zepbound, Rybelsus, Saxenda, plus compounded semaglutide/tirzepatide. Logs date, time, site, dose. Adds nutrition + macros + water tracking — that is the "do everything" pivot Marc explicitly does not want.

**InjectionLog** ([injectionlog.com](https://injectionlog.com/)) — Free iOS. Color-coded body map with point-precision rotation. Built-in knowledge of 20+ compounds including GLP-1s, peptides, TRT. Differentiator: **shared dashboard with a coach or clinician** — practitioners get live read-only access without spreadsheets. Privacy-sensitive, not a fit for HealthLog's self-hosted ethos.

**MeAgain** ([meagain.com/mounjaro-app](https://meagain.com/mounjaro-app)) — iOS. "Shot day checklist" walks through the injection step by step. Tracks the 6-step Mounjaro ramp, side effects, food, weight. Strong on the procedural side of weekly injection day.

**Mounjaro Tracker** ([App Store UK](https://apps.apple.com/gb/app/mounjaro-tracker/id6670317407)) — 80,000+ users, 4.8 stars. Auto site rotation, weight tracking, side-effect timeline tied to dose changes, doctor-report export.

**Jabby** ([getjabby.com](https://getjabby.com/)) — iOS. Tirzepatide-focused. Heavy on dose-anniversary reminders and titration-step planning.

### General-purpose medication apps with GLP-1 surfaces

**Medisafe** — Cross-platform, freemium. "Best in class" for **persistent notifications** with multi-prompt fallback (great for weekly-cadence reliability). Supports independent schedules for stacked meds (e.g., basal insulin + weekly GLP-1). No body map. ([Done Dose review](https://www.donedose.com/guides/best-injection-site-rotation-app))

**Round Health** ([App Store](https://apps.apple.com/gb/app/round-health/id1059591124)) — iOS + Watch, free. **Reminder windows** with a three-prompt cadence (window start / middle / end) — exactly the HealthLog `windowStart` / `windowEnd` model. Supports every-N-day and weekly schedules. No body map, no side-effect schema — generic.

**MyTherapy** ([mytherapyapp.com/glp1-apps](https://www.mytherapyapp.com/glp1-apps)) — Cross-platform, free. Notable: dedicated GLP-1 marketing page, includes an **injection-site rotation diagram**, exports doctor-ready reports. Treats GLP-1 as a first-class category inside a general med tracker — closest analogue to where HealthLog should aim.

### What users wish they had (r/Mounjaro, diabetes.co.uk forum, Mumsnet GLP-1 threads)

Recurring "I wish my app did X" themes across reviews and forum threads ([diabetes.co.uk forum](https://www.diabetes.co.uk/forum/threads/tracking-app-advise-please-mounjaro-glp-1-medications.208690/), [Mumsnet GLP-1 thread](https://www.mumsnet.com/talk/weight-loss-injections/5379404-mounjaro-newbie-app-for-trackingcalories), [glp1effect.com app list](https://glp1effect.com/p/3-must-have-apps-while-on-glp-1)):

- "When does the dose peak and trough? Show me the curve."
- "How many doses are left in this pen?"
- "I want to print a side-effects-vs-dose report for my next appointment."
- "Tell me whether the nausea I'm getting is normal for week 3 of 7.5 mg."
- "Stop forcing me to log every meal — I just want injection day + weight + how I felt."

That last bullet maps directly to Marc's "NOT a calorie tracker" stance — there is a clear market gap for a GLP-1 surface that does **not** demand food logging. HealthLog is well-positioned.

---

## Section 2 — Unique features of injectable GLP-1 tracking

### 2.1 Injection-site rotation

**Clinical rationale.** Eli Lilly's Mounjaro patient information ([pi.lilly.com/us/mounjaro-uspi.pdf](https://pi.lilly.com/us/mounjaro-uspi.pdf), [pi.lilly.com/us/mounjaro-us-ifu.pdf](https://pi.lilly.com/us/mounjaro-us-ifu.pdf)) and Novo Nordisk's Ozempic / Wegovy product information ([novo-pi.com/ozempic.pdf](https://www.novo-pi.com/ozempic.pdf), [novo-pi.com/wegovy.pdf](https://www.novo-pi.com/wegovy.pdf)) both mandate site rotation per dose to prevent lipohypertrophy / lipoatrophy / localized cutaneous amyloidosis. Approved sites: abdomen (avoiding 2-inch radius around navel), thighs (anterior / outer), and back of upper arms. Self-injection is feasible into abdomen and thigh; upper-arm injection typically requires assistance.

**Best-in-class implementation.** InjectionLog uses a point-precise body map with color coding (cooled-off green → warmer red as a site approaches the recommended next-use threshold). Shotsy uses a coarser zone-rotation suggestion. MyTherapy has a stylized diagram.

**HealthLog infrastructure.** None. The `Medication` model has no site state. Adding it requires either:

- A column `Medication.lastInjectionSite` (Json: `{ zone, subzone, injectedAt }`) for "most recent" only — cheap, sufficient for "suggest next site" hint.
- Or a dedicated `MedicationIntakeEvent.injectionSite` Json column to capture per-event site, enabling a real history view — costlier but unlocks the "where did I inject 4 weeks ago" view.

**Recommendation:** start with `MedicationIntakeEvent.injectionSite` (Json nullable). Existing rows stay NULL; new rows for GLP-1 medications get populated. The "next site" hint reads the last 4 rows and suggests the least-recently-used quadrant. No new table required.

### 2.2 Weekly cadence

**Clinical reality.** Mounjaro (tirzepatide), Ozempic (semaglutide injection), Wegovy (semaglutide injection), Zepbound (tirzepatide), Trulicity (dulaglutide) — all once-weekly. Saxenda (liraglutide) and Victoza — once-daily. Rybelsus (oral semaglutide) — once-daily oral. So the schedule model needs to cover daily-pill, daily-injection, and weekly-injection.

**HealthLog infrastructure.** Already supports it. `MedicationSchedule.daysOfWeek` is a comma-separated weekday list (`0=Sun..6=Sat`). `NULL` = daily. The reminder worker filters on it at `src/lib/jobs/reminder-worker.ts:347` via `parseScheduleRecurrence(schedule.daysOfWeek)`. A weekly Wednesday Mounjaro injection would be persisted as `daysOfWeek = "3"`. **No schema change required for weekly cadence.**

The only gap is **UI affordance**. The current med-edit form likely shows a daily-by-default toggle; a "Once weekly on …" preset would surface the existing capability. The reminder copy probably also says "today" instead of "this week" — a small i18n adjustment.

### 2.3 Dose titration history

**Clinical reality.** Mounjaro titrates 2.5 → 5 → 7.5 → 10 → 12.5 → 15 mg, in 2.5 mg increments, with at least 4 weeks at each step before escalation per Eli Lilly's prescribing information ([medical.lilly.com — dose escalation Q&A](https://medical.lilly.com/us/products/answers/how-should-mounjaro-tirzepatide-doses-be-increased-in-adults-110552), [accessdata.fda.gov label](https://www.accessdata.fda.gov/drugsatfda_docs/label/2025/215866s031lbl.pdf)). Wegovy titrates 0.25 → 0.5 → 1.0 → 1.7 → 2.4 mg over 16+ weeks ([wegovy.com prescribing info](https://www.wegovy.com/prescribing-information.html)). Saxenda titrates 0.6 → 1.2 → 1.8 → 2.4 → 3.0 mg over 5 weeks ([saxenda.com dosing schedule](https://www.saxenda.com/about-saxenda/dosing-schedule.html)).

**ADA 2026 Standards of Care** ([diabetesjournals.org/care 9. Pharmacologic Approaches](https://diabetesjournals.org/care/article/49/Supplement_1/S183/163934/9-Pharmacologic-Approaches-to-Glycemic-Treatment), [diabetesjournals.org/care 8. Obesity and Weight Management](https://diabetesjournals.org/care/article/49/Supplement_1/S166/163915/8-Obesity-and-Weight-Management-for-the-Prevention)) explicitly endorse **individualized titration** — the optimal dose is not necessarily the maximum approved dose, and stepwise gradual titration enhances tolerability. Apps should not preach to taper faster than the patient's clinician prescribes.

**HealthLog infrastructure.** `Medication.dose` is a single `String`. There is no history. A user who escalated from 2.5 → 5 mg in March will see their March intake events labeled with whatever dose is currently in the row.

**Two implementation options:**

- **Option A — DoseChange table.** New `MedicationDoseChange { id, medicationId, dose, effectiveFrom DateTime, reason String? }`. Joined at intake-event display time. Clean, but adds a table.
- **Option B — JSON history on Medication.** `Medication.doseHistoryJson` = `[{dose, effectiveFrom, plannedNext, plannedNextOn}, ...]`. Single column, no migration tablescape. Loses the relational query power.

**Recommendation:** Option A. The query pattern "what dose was I on at time X" is too common for JSON traversal (Coach snapshot needs it, chart annotation needs it, doctor report needs it). A small dedicated table earns its keep.

### 2.4 Side-effect tracking

**Clinical reality.** GI side effects peak during titration and the first week after each dose increase, then plateau ([PMC review of GLP-1 adverse effects](https://pmc.ncbi.nlm.nih.gov/articles/PMC5397288/), [Tandfonline managing GI side effects](https://www.tandfonline.com/doi/full/10.1080/00325481.2021.2002616), [GoodRx GLP-1 side effects](https://www.goodrx.com/classes/glp-1-agonists/glp-1-side-effects)). Nausea incidence 27-44%, vomiting, diarrhea, constipation, fatigue from reduced caloric intake. The clinically useful signal is "nausea spike 1-3 days after the 7.5 mg step-up" — i.e., **side effect timing relative to the most recent dose change**.

**HealthLog infrastructure.** MoodEntry exists (super_gut..lausig + tags + score) but it is a daily generic-mood log, not a structured side-effect log. There is no symptom/side-effect schema today.

**Lightweight option:** reuse `MoodEntry.tags` (JSON tag array) — add a curated GLP-1 tag set (`gi.nausea`, `gi.vomiting`, `gi.constipation`, `gi.diarrhea`, `general.fatigue`, `general.headache`, `gi.reflux`). The Coach snapshot already aggregates moodTags. Zero schema change. The UI surface is the moodLog quick-log.

**Heavier option:** dedicated `SymptomLog { id, userId, occurredAt, type, severity 0-10, note }`. Cleaner separation, supports the "0-10 severity slider" pattern users prefer (Glapp uses 0-10). But adds a table.

**Recommendation:** start with **MoodEntry tag extension** (zero schema). If the Coach correlations prove valuable and users want a 0-10 slider, promote to SymptomLog in v1.6.

### 2.5 Pause / hold tracking

**Clinical reality.** Users pause for: severe side effects, surgery prep ([ASA 2024 guidance: most patients should continue, those at highest GI risk should follow liquid diet 24h before](https://www.asahq.org/about-asa/newsroom/news-releases/2024/10/new-multi-society-glp-1-guidance), [Medscape: GLP-1 drugs and surgery](https://www.medscape.com/viewarticle/glp-1-drugs-and-surgery-stop-or-continue-2026a1000e4z)), pregnancy (contraindicated), supply shortage ([FDA shortage page](https://www.fda.gov/drugs/drug-alerts-and-statements/fda-clarifies-policies-compounders-national-glp-1-supply-begins-stabilize)). Pause needs to NOT mark the user as "non-adherent."

**HealthLog infrastructure.** Already exists. `Medication.pausedAt` (DateTime nullable). The reminder worker skips paused meds. The adherence calculator should also skip-as-paused-not-missed. Add a `pauseReason String?` for the doctor-report row. Add an "un-pause" UI affordance.

**Gap:** `pauseReason` does not exist. Adherence calculator behavior under `pausedAt` should be verified — out of scope here.

### 2.6 Pen / vial inventory

**Clinical reality.** A Mounjaro KwikPen holds **4 weekly doses**. After first use, room-temperature storage caps at 30 days or 4 doses, whichever comes first ([lilly.com KwikPen storage](https://www.lilly.com/en-CA/resources/faq/mounjaro-kwikpen/storage-mounjaro-kwikpen)). Unopened refrigerated pens hold 24 months. Ozempic/Wegovy pens vary: Ozempic 0.25/0.5 mg pen = 4 doses, Wegovy single-dose pen = 1 dose. So inventory math is "doses-remaining per pen × pens in fridge."

**HealthLog infrastructure.** None. No inventory model. Glapp does this well with a simple `Pen { count, dosesRemaining, expiresOn }` list.

**Recommendation:** add `MedicationInventoryItem { id, medicationId, dosesRemaining, dosesPerUnit, openedAt DateTime?, expiresOn Date }`. Decremented by intake-event creation. Dashboard tile reads "≈ N weeks of supply left." Defer to v1.5 — useful but not foundational.

### 2.7 Cost tracking

**Scope-creep.** Marc has not asked for it, GLP-1 prices vary wildly (insurance, compounded vs branded, country), and exposing cost in a doctor-report is privacy-loaded. **Skip.**

### 2.8 Body composition correlation

**HealthLog infrastructure.** Already first-class. Weight, body fat %, body water, bone mass, waist (via notes) are all in `Measurement`. The killer feature is **chart annotation** — a small dot on each injection day, a colored band when the dose increased. Pure UI work; no schema impact.

### 2.9 A1c / glucose

**HealthLog infrastructure.** Already first-class. `BLOOD_GLUCOSE` with `GlucoseContext` enum (fasting / postprandial / random / bedtime). A1c is not currently a measurement type — but for GLP-1 monitoring, fasting glucose and postprandial trends are what move first. Out of scope for this research; revisit when a user requests it.

### 2.10 Photos

**Skip per Marc's privacy stance.** Pre/post photos are a privacy hot zone for a self-hosted tool; if they ever land, they must be local-device-only. Out of scope.

---

## Section 3 — User journey + the AI Coach angle

A typical Mounjaro user's week-3 experience that today's HealthLog would handle generically and a GLP-1-aware HealthLog should handle specifically:

| Moment                        | What the user wants                | What HealthLog does today                                     | What GLP-1-aware HealthLog should do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wednesday 8am (injection day) | "Did I do it? Remind me."          | Generic medication reminder fires if `daysOfWeek="3"` is set. | Same reminder, but with site suggestion in the body ("Last week: right abdomen. Try left thigh.").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Wednesday 8pm                 | "Log the shot."                    | Tap intake event → done.                                      | Tap intake event → quick-log injection site (4-zone abdomen grid + thigh + arm).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Thursday-Friday               | "Why do I feel awful?"             | No surface.                                                   | Briefing card: "GLP-1 day-after fatigue is most common 24-48h post-injection. Hydration & protein help."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| End of week 4 on 2.5 mg       | "Should I bump to 5?"              | No surface.                                                   | Dashboard: "Week 4 of 2.5 mg. Eli Lilly's titration schedule supports stepping up to 5 mg at your next dose. Discuss with your clinician." (Carefully framed — never prescriptive, always defers to the clinician.)                                                                                                                                                                                                                                                                                                                                                                     |
| Week 8 plateau                | "Why has weight stopped dropping?" | Generic weight chart.                                         | Coach reads dose history + weight curve, notes "0.3 kg loss over the last 14 days, which is below your prior 0.7 kg/week trend. Plateaus typically resolve at the next dose step. If you increase to 7.5 mg next week, expect the trend to resume by week 11. If it does not, mention it at your next appointment." ([clinicalnutritioncenter.com plateau research](https://www.clinicalnutritioncenter.com/research/breaking-through-the-weight-loss-plateau-what-the-research-actually-shows), [glp-1.com weight loss timeline](https://glp-1.com/article/glp-1-weight-loss-results)) |
| Doctor visit prep             | "Give me a one-page summary."      | Existing doctor report.                                       | Same report, plus: dose timeline, weight curve with injection markers, side-effect distribution by dose step, adherence %.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The Coach prompt today does NOT see what medication category a user is on. The `coach/snapshot.ts` builder (`/Users/marc/Projects/HealthLog/src/lib/ai/coach/snapshot.ts`, ~616 lines) aggregates compliance counts and intake events but never names the drug class. That is the single most impactful gap: a user on Mounjaro asks the Coach about weight stalling and the Coach answers generically, when it could answer specifically.

---

## Section 4 — Holistic integration plan

For each HealthLog surface, what changes and how invisibly it stays for non-GLP-1 users.

### 4.1 Medication category enum

Today the `Medication` model has no category. There is no enum `MedicationCategory`. Two options:

- **Lightweight (v1.4.25):** add `Medication.category String?` — free-text but UI-bounded to a small enum (`glp1`, `insulin`, `oral`, `topical`, `other`, …). Allows future categories without migrations.
- **Strict (v1.5):** Prisma enum `MedicationCategory`. Costs a migration but gives type safety in queries.

**Recommendation:** start lightweight; promote to enum in v1.5 when we know which categories actually appear in the wild. The category enables every conditional surface below — without it, "is this user on a GLP-1?" is a string-search through `Medication.name`, which is fragile (compounded tirzepatide names vary).

### 4.2 Dashboard

A user with at least one active GLP-1 medication gets a **GLP-1 tile** in the dashboard widget grid (controlled by the existing `User.dashboardWidgetsJson` layout system). The tile shows:

- Current dose with weeks-on-current-dose ("2.5 mg · week 3 of typical 4")
- Last injection date / site
- Next injection date (today / Wed in 4 days)
- Weight delta since GLP-1 start
- Pen-inventory countdown if v1.5 ships

Tile component: `src/components/dashboard/glp1-tile.tsx` (new). Invisible for users with no GLP-1 medication. Registered in the widget catalog with `defaultVisible: false` so it only appears when the dashboard config layer detects an active GLP-1 med (same pattern as the "BD-Zielbereich" tile).

### 4.3 Insights / Daily Briefing

Briefing pulls in GLP-1 context (current dose, days since last injection, recent side-effect tags) for the day-of and day-after-injection. No new card type — the existing Daily Briefing schema already accepts arbitrary card.kind values. New kind: `glp1.weekly.cycle`.

### 4.4 Medications page

For GLP-1 medications, the card grows three extra fields:

- Last injection site + suggested next site (small body diagram)
- Dose titration history (timeline rail with dose-change markers)
- Pen-inventory line (v1.5)

Component: `src/components/medications/glp1-card.tsx` (new). The regular `MedicationCard` renders for non-GLP-1.

### 4.5 Weight chart

Annotate the weight chart with:

- Small dot markers on injection days (only when a GLP-1 med is active in the window)
- Vertical line + label on dose-change dates ("→ 5 mg")
- Optional colored band per dose step (very subtle)

Pure Recharts annotation work. No schema impact. Touches the existing weight chart component.

### 4.6 New `/insights/medikamente` sub-page

Already in scope for v1.4.25 W4 (insights-sub-pages-ux research). For GLP-1 users, this page gets a **Therapy Timeline** view: horizontal timeline with dose changes, pause/resume markers, side-effect occurrences, weight curve overlay. Defer this view to v1.5.

### 4.7 AI Coach prompt

`src/lib/ai/coach/snapshot.ts` currently aggregates compliance counts (line 437). Add a new `weeklyContext.glp1` block:

```
{
  active: true,
  drug: "Mounjaro",
  dose: "5 mg",
  weeksOnCurrentDose: 3,
  startedTherapy: "2026-03-15",
  lastInjection: "2026-05-08",
  nextInjection: "2026-05-15",
  recentSideEffects: [{tag: "gi.nausea", count: 3, lastN: 14}],
  weightDeltaSinceStart: -4.2
}
```

This is the highest-leverage change. The Coach goes from generic to GLP-1-aware with a snapshot extension and one paragraph of system-prompt guidance. ~50 LOC.

Critical guardrail: the Coach must **never prescribe a titration step**. It can describe the typical clinical pattern (citing Eli Lilly's published schedule) and defer to the user's clinician. The existing refusal/safety layer at `src/lib/ai/coach/refusal.ts` should be extended with GLP-1-specific guardrails (no dose recommendations, no "skip a dose" advice, no diabetes-specific glucose targets, no off-label dose suggestions).

### 4.8 Reminders

Today's reminder worker (`src/lib/jobs/reminder-worker.ts:347`) already supports `daysOfWeek` filtering. A weekly Wednesday med with `daysOfWeek="3"` works correctly. The reminder copy should mention "this week" for weekly meds; for daily meds, "today." Pure i18n change in `messages/de.json` + `messages/en.json` — new key `medication.reminder.weeklyOn`.

The GLP-1 reminder body could embed the suggested injection site for the day. That requires the site-suggestion helper to exist (§2.1).

### 4.9 Empty state for non-users

Every surface above is conditional on `Medication.category === "glp1"` with `active === true`. Users without a GLP-1 see nothing GLP-1-flavored. No marketing copy in the empty dashboard ("Set up GLP-1 tracking!") — that would feel like a bolt-on. The feature is invisible until triggered. ✔ Matches Marc's "everywhere integriert, nowhere announced" pattern.

---

## Section 5 — Scope recommendation

Effort: **S** = ~½ day, **M** = 1-2 days, **L** = 3-5 days. Risk: schema-migration (high), AI-context (medium), UI-only (low).

| #   | Item                                                                                       | Effort | Risk   | User value       | Recommended release |
| --- | ------------------------------------------------------------------------------------------ | ------ | ------ | ---------------- | ------------------- |
| F1  | `Medication.category` (String, nullable)                                                   | S      | low    | foundation       | **v1.4.25**         |
| F2  | Dashboard "next injection in N days" caption for weekly-cadence meds                       | S      | low    | medium           | **v1.4.25**         |
| F3  | Coach snapshot — surface active weekly-cadence medications by name + dose                  | S      | low    | high             | **v1.4.25**         |
| F4  | Coach refusal/safety guardrails — no dose recommendations                                  | S      | medium | high (safety)    | **v1.4.25**         |
| F5  | Med-edit form: "Once weekly on …" preset, weekly reminder copy                             | S      | low    | medium           | **v1.4.25**         |
| C1  | `MedicationIntakeEvent.injectionSite` Json column                                          | M      | medium | high             | v1.4.26             |
| C2  | `MedicationDoseChange` table + UI for titration step                                       | M      | medium | high             | v1.4.26             |
| C3  | GLP-1 dashboard tile (current dose, weeks-on, last/next injection, weight delta)           | M      | low    | high             | v1.4.26             |
| C4  | Weight-chart injection-day markers + dose-change vertical lines                            | M      | low    | high             | v1.4.26             |
| C5  | GLP-1 medication-card variant with site + dose history                                     | M      | low    | medium           | v1.4.26             |
| C6  | Coach snapshot extension — `weeklyContext.glp1` block + GLP-1-aware system-prompt language | M      | medium | very high        | v1.4.26             |
| D1  | MoodEntry GLP-1 tag set + Coach correlation with dose changes                              | M      | low    | medium           | v1.5                |
| D2  | `Medication.pausedReason` + adherence-calculator pause handling verification               | S      | low    | medium           | v1.5                |
| D3  | `MedicationInventoryItem` table + pen-countdown dashboard line                             | M      | medium | medium           | v1.5                |
| D4  | `/insights/medikamente` Therapy Timeline view for GLP-1                                    | L      | low    | medium           | v1.5                |
| D5  | Briefing card `glp1.weekly.cycle` (day-of and day-after-injection prompts)                 | M      | low    | medium           | v1.5                |
| D6  | Plateau-detection + dose-anniversary briefing prompts                                      | M      | medium | high             | v1.5                |
| E1  | Promote `Medication.category` to Prisma enum `MedicationCategory`                          | S      | medium | low              | v1.5                |
| E2  | Doctor-report enhancement: dose timeline + side-effect-by-dose distribution                | M      | low    | high             | v1.5                |
| Z1  | `SymptomLog` table (0-10 severity) if MoodEntry tags prove insufficient                    | L      | medium | low until proven | v1.6+               |

### v1.4.25 foundation (F1-F5, ~1 day total)

Five additive items, all small, all low risk. They make HealthLog "GLP-1 aware enough that the Coach stops sounding generic," without committing to the heavy UI lift. Crucially, F4 (Coach guardrails) must ship together with F3 — exposing medication context to the LLM without the guardrails is a clinical-safety regression.

### v1.4.26 first cut (C1-C6, ~5 days)

The product gets a real GLP-1 surface — dashboard tile, weight-chart annotations, injection-site rotation, dose-titration history, GLP-1-aware Coach. This is the release where Marc can say "HealthLog has GLP-1 support."

### v1.5 polish

The rest — inventory, briefing prompts, plateau detection, therapy-timeline page. These are differentiators but not required for a credible first cut.

---

## Section 6 — Anti-patterns (explicit non-goals)

Per Marc's directive and HealthLog's positioning:

- **No nutrition / calorie / macro tracking.** Pep does this; HealthLog won't. Users who want food logging use a dedicated tool.
- **No pre/post photos.** Privacy + scope creep. If revisited, must be device-local-only.
- **No prescription-image OCR.** Regulatory complexity (HIPAA / medical-device classification creep).
- **No drug-drug interaction warnings.** That is clinical-decision-support, FDA-regulated as a medical device in some interpretations; we are not taking on clinical responsibility.
- **No pharmacy coupon / GoodRx-style price comparison.** Commercial entanglement, against the self-hosted ethos.
- **No insurance billing connection.** Compliance nightmare.
- **No "compare to other users on Mounjaro" social.** Privacy compromise — HealthLog never shares user data cross-account.
- **No autonomous dose recommendations.** The Coach can describe Eli Lilly's published titration schedule and recommend "discuss with your clinician at your next visit" — never "you should bump to 7.5 mg."
- **No telemedicine integration / prescribing pipeline.** Out of scope.

---

## Section 7 — File-path level routing (for v1.4.26 / v1.5 implementation)

When implementation lands, expected file touches:

**Schema (v1.4.26):**

- `/Users/marc/Projects/HealthLog/prisma/schema.prisma` — `Medication.category String?` (v1.4.25), `MedicationIntakeEvent.injectionSite Json?`, new `model MedicationDoseChange`, `Medication.pausedReason String?` (v1.5).
- New Prisma migration `prisma/migrations/00XX_glp1_foundation/migration.sql`.

**API:**

- `/Users/marc/Projects/HealthLog/src/app/api/medications/[id]/route.ts` — PATCH handler accepts new `category` + `pausedReason` fields.
- New endpoint `/Users/marc/Projects/HealthLog/src/app/api/medications/[id]/dose-changes/route.ts` for the titration timeline.
- `/Users/marc/Projects/HealthLog/src/app/api/medications/[id]/intake/route.ts` — POST accepts optional `injectionSite` payload.

**UI:**

- New `/Users/marc/Projects/HealthLog/src/components/dashboard/glp1-tile.tsx`.
- New `/Users/marc/Projects/HealthLog/src/components/medications/glp1-card.tsx`.
- New `/Users/marc/Projects/HealthLog/src/components/medications/injection-site-map.tsx` (4-zone abdomen grid + thigh + arm).
- Extend `/Users/marc/Projects/HealthLog/src/components/medications/MedicationCard.tsx` (or equivalent) to delegate to `glp1-card.tsx` when `category==="glp1"`.
- Extend the weight-chart component (under `/Users/marc/Projects/HealthLog/src/components/charts/`) with injection markers + dose-change reference lines.

**AI Coach:**

- `/Users/marc/Projects/HealthLog/src/lib/ai/coach/snapshot.ts` — new `weeklyContext.glp1` block.
- `/Users/marc/Projects/HealthLog/src/lib/ai/coach/system-prompt.ts` — GLP-1-aware language ("when the user has an active GLP-1 medication, reference dose and weeks-on-dose when discussing weight progress; never prescribe titration; defer to the user's clinician").
- `/Users/marc/Projects/HealthLog/src/lib/ai/coach/refusal.ts` — extend refusal patterns for "should I increase my Mounjaro dose" → safe deflection.
- `/Users/marc/Projects/HealthLog/src/lib/ai/coach/types.ts` — extend snapshot type with `glp1` field.

**Reminders:**

- No code change to `/Users/marc/Projects/HealthLog/src/lib/jobs/reminder-worker.ts` (weekly cadence already supported via `daysOfWeek`).
- Reminder copy: `/Users/marc/Projects/HealthLog/messages/en.json` + `/Users/marc/Projects/HealthLog/messages/de.json` — new keys `medication.reminder.weeklyOn`, `medication.glp1.suggestSite`.

**Insights:**

- `/Users/marc/Projects/HealthLog/src/app/insights/medikamente/page.tsx` (created in v1.4.25 W4 backbone) — extend with Therapy Timeline component for GLP-1 users.
- `/Users/marc/Projects/HealthLog/src/lib/ai/briefing/` — new card kind `glp1.weekly.cycle`.

**Tests:**

- Snapshot tests: GLP-1 snapshot block present when active med exists, absent otherwise.
- Coach refusal: "should I increase my Mounjaro dose?" returns the safe deflection.
- Reminder: `daysOfWeek="3"` med fires only on Wednesdays (already covered, just verify).
- Migration round-trip test on the dose-change table.

**Seed:**

- Demo server post-implementation: one synthetic user with a Mounjaro medication, 6 weeks of synthetic intake events, weight curve with realistic 0.5 kg/week loss, side-effect tags, dose change from 2.5 → 5 mg at week 4.

**Docs:**

- `/Users/marc/Projects/HealthLog/docs/api/openapi.yaml` — document the new fields once they land. (Hard requirement per v1.4.23 OpenAPI gate.)
- No marketing / user-facing announcement until v1.4.26 release notes — per "feature is invisible until triggered" rule.

---

## Sources

### Clinical / regulatory

- Eli Lilly Mounjaro USPI: [pi.lilly.com/us/mounjaro-uspi.pdf](https://pi.lilly.com/us/mounjaro-uspi.pdf)
- Eli Lilly Mounjaro IFU: [pi.lilly.com/us/mounjaro-us-ifu.pdf](https://pi.lilly.com/us/mounjaro-us-ifu.pdf)
- FDA Mounjaro label (2025): [accessdata.fda.gov drugsatfda label 215866s031](https://www.accessdata.fda.gov/drugsatfda_docs/label/2025/215866s031lbl.pdf)
- Eli Lilly KwikPen storage: [lilly.com Mounjaro KwikPen storage FAQ](https://www.lilly.com/en-CA/resources/faq/mounjaro-kwikpen/storage-mounjaro-kwikpen)
- Eli Lilly dose escalation Q&A: [medical.lilly.com — how should Mounjaro doses be increased](https://medical.lilly.com/us/products/answers/how-should-mounjaro-tirzepatide-doses-be-increased-in-adults-110552)
- Novo Nordisk Ozempic PI: [novo-pi.com/ozempic.pdf](https://www.novo-pi.com/ozempic.pdf)
- Novo Nordisk Wegovy PI: [novo-pi.com/wegovy.pdf](https://www.novo-pi.com/wegovy.pdf)
- Wegovy prescribing info: [wegovy.com/prescribing-information.html](https://www.wegovy.com/prescribing-information.html)
- Saxenda dosing schedule: [saxenda.com/about-saxenda/dosing-schedule.html](https://www.saxenda.com/about-saxenda/dosing-schedule.html)
- ADA 2026 Standards of Care, pharmacologic: [diabetesjournals.org/care 9. Pharmacologic Approaches](https://diabetesjournals.org/care/article/49/Supplement_1/S183/163934/9-Pharmacologic-Approaches-to-Glycemic-Treatment)
- ADA 2026 Standards of Care, obesity & weight management: [diabetesjournals.org/care 8. Obesity and Weight Management](https://diabetesjournals.org/care/article/49/Supplement_1/S166/163915/8-Obesity-and-Weight-Management-for-the-Prevention)
- PMC GLP-1 adverse effects review: [pmc.ncbi.nlm.nih.gov PMC5397288](https://pmc.ncbi.nlm.nih.gov/articles/PMC5397288/)
- Managing GLP-1 GI side effects (Tandfonline): [tandfonline.com 10.1080/00325481.2021.2002616](https://www.tandfonline.com/doi/full/10.1080/00325481.2021.2002616)
- ASA multi-society GLP-1 surgery guidance (2024): [asahq.org GLP-1 perioperative](https://www.asahq.org/about-asa/newsroom/news-releases/2024/10/new-multi-society-glp-1-guidance)
- Medscape GLP-1 and surgery: [medscape.com glp-1-drugs-and-surgery](https://www.medscape.com/viewarticle/glp-1-drugs-and-surgery-stop-or-continue-2026a1000e4z)
- FDA GLP-1 supply policy: [fda.gov compounders GLP-1 supply](https://www.fda.gov/drugs/drug-alerts-and-statements/fda-clarifies-policies-compounders-national-glp-1-supply-begins-stabilize)
- Plateau research summary: [clinicalnutritioncenter.com plateau research](https://www.clinicalnutritioncenter.com/research/breaking-through-the-weight-loss-plateau-what-the-research-actually-shows)
- Weight loss timeline: [glp-1.com weight loss results](https://glp-1.com/article/glp-1-weight-loss-results)
- Lipodystrophy / site rotation rationale: [getheally.com semaglutide injection rotation map](https://getheally.com/patients/news/semaglutide-injection-rotation-map)
- Mounjaro injection sites overview: [medicalnewstoday.com Mounjaro injection sites](https://www.medicalnewstoday.com/articles/drugs-mounjaro-injection-sites)

### Apps surveyed

- Shotsy: [shotsyapp.com](https://shotsyapp.com/), [App Store](https://apps.apple.com/us/app/shotsy-glp-1-tracker/id6499510249), [Play Store](https://play.google.com/store/apps/details?id=com.shotsy.app)
- Glapp: [glapp.io](https://glapp.io/), [glapp.io/mounjaro-app](https://glapp.io/mounjaro-app)
- Pep: [pepglp1.com](https://pepglp1.com/), [App Store](https://apps.apple.com/us/app/glp-1-tracker-pep/id6504788281), [Play Store](https://play.google.com/store/apps/details?id=com.shredapps.glp1)
- InjectionLog: [injectionlog.com](https://injectionlog.com/)
- MeAgain: [meagain.com/mounjaro-app](https://meagain.com/mounjaro-app)
- Mounjaro Tracker (Apple): [App Store UK](https://apps.apple.com/gb/app/mounjaro-tracker/id6670317407)
- Jabby: [getjabby.com](https://getjabby.com/), [getjabby.com best-app-tracking-tirzepatide-injections](https://getjabby.com/best-app-tracking-tirzepatide-injections.html)
- Medisafe: covered via [donedose.com best-injection-site-rotation-app](https://www.donedose.com/guides/best-injection-site-rotation-app)
- Round Health: [App Store](https://apps.apple.com/gb/app/round-health/id1059591124), [iMedicalApps review](https://www.imedicalapps.com/2016/11/round-health-app-personal-assistant-pill-taking/)
- MyTherapy: [mytherapyapp.com/glp1-apps](https://www.mytherapyapp.com/glp1-apps), [App Store](https://apps.apple.com/us/app/pill-reminder-mytherapy/id662170995)

### Comparison roundups (used for cross-app feature surveys)

- Done Dose GLP-1 tracker round-up: [donedose.com best-glp1-tracker-app](https://www.donedose.com/guides/best-glp1-tracker-app)
- Done Dose injection-site rotation apps: [donedose.com best-injection-site-rotation-app](https://www.donedose.com/guides/best-injection-site-rotation-app)
- The GLP-1 List community ranking: [theglp1list.com](https://theglp1list.com/en)
- LearnMuscles 2026 comparison: [learnmuscles.com 6 Best GLP-1 Tracking Apps](https://learnmuscles.com/blog/2025/11/27/6-best-glp-1-tracking-apps-compared-which-app-actually-works-in-2026/)
- heySlim apps for GLP-1 success: [heyslim.co.uk 9 best apps for GLP-1](https://www.heyslim.co.uk/blog/best-apps-glp-1-success-track-doses-food-progress-2025)
- TrimRX tracking tools: [trimrx.com tools-tracking-glp-1-progress](https://trimrx.com/blog/tools-tracking-glp-1-progress/)

### Community / user-wish signals

- diabetes.co.uk forum tracking-app thread: [diabetes.co.uk forum 208690](https://www.diabetes.co.uk/forum/threads/tracking-app-advise-please-mounjaro-glp-1-medications.208690/)
- Mumsnet GLP-1 newbie thread: [mumsnet.com weight-loss-injections 5379404](https://www.mumsnet.com/talk/weight-loss-injections/5379404-mounjaro-newbie-app-for-trackingcalories)
- glp1effect must-have apps: [glp1effect.com 3-must-have-apps](https://glp1effect.com/p/3-must-have-apps-while-on-glp-1)

### Internal HealthLog references (file paths only — no code embedded)

- `/Users/marc/Projects/HealthLog/prisma/schema.prisma` — Medication / MedicationSchedule / MedicationIntakeEvent / MoodEntry models
- `/Users/marc/Projects/HealthLog/src/lib/jobs/reminder-worker.ts:347` — existing `daysOfWeek` filtering proves weekly cadence already works
- `/Users/marc/Projects/HealthLog/src/lib/ai/coach/snapshot.ts:437` — existing medication-compliance hook for snapshot extension
- `/Users/marc/Projects/HealthLog/src/lib/ai/coach/refusal.ts` — guardrail surface for "no dose recommendations" safety layer
- `/Users/marc/Projects/HealthLog/.planning/research/insights-sub-pages-ux.md` — sibling research, `/insights/medikamente` backbone targeted for v1.4.25 W4
