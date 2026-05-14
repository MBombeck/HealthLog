# GLP-1 Feature Inspiration — v1.4.26+ Research

**Marc directive 2026-05-14.**
**Scope.** What HealthLog v1.4.25 (W4d) does **not** yet ship for GLP-1 / GIP-GLP1 receptor agonists, what the open-source PK community + closed-source consumer apps do **better or differently**, and where the regulatory red lines sit. Sibling research [`glp1-injection-tracking.md`](./glp1-injection-tracking.md) covers the foundational landscape — this report is the second pass: deeper clinical data + PK modelling + app teardown + the safe-feature-vs-medical-device boundary.

**Read-only.** No code commits, no schema commits. The "schema sketches" below are design proposals.

---

## TL;DR

HealthLog already covers the **tracking and procedural** half of GLP-1 (treatmentClass enum, injection-site map + recommender, dose-change history, dashboard tile, weight-chart markers, therapy timeline, plateau detection, doctor-report section, Coach refusal rule). The gap is the **pharmacological half** — the "where am I in the weekly cycle" curve every consumer app advertises, and the structured EMA-derived data layer that would let HealthLog answer questions about side-effect frequency, dose-escalation timing, and storage countdown without making them up.

Three highest-leverage adds (detailed in §12): (1) static EMA-derived drug knowledge layer (low regulatory risk); (2) opt-in estimated drug-level chart behind a `researchMode` flag (**two-compartment per psp4.13099, §2.6** — the journal-of-record demands it; one-compartment Bateman acceptable for the qualitative phase chip only); (3) pen/vial inventory with 30-day in-use countdown per EMA §6.3.

Three do-not-builds: weight-loss projection, autonomous dose-escalation recommendations, drug-drug interaction checking — all cross the MDR threshold ([MDCG 2021-24](https://health.ec.europa.eu/system/files/2021-10/mdcg_2021-24_en_0.pdf), [Voelker Gruppe](https://www.voelker-gruppe.com/kompetenzen/medizinrecht/beitraege/ce-marking-medical-apps)). Add a fourth from the 2026-05-14 deeper probe: **N11 — do not import or port any code, schema, or curated dataset from thejdubb02/my-glp-shot** (no LICENSE file → all rights reserved by default; teardown in §9.5). Source the reference layer from EMA EPARs and psp4.13099 directly — both more authoritative and licence-clean.

The line not to cross: anything that turns "display public regulatory information" into "calculate dose / predict outcome / surveil with diagnostic intent" classifies as an EU MDR medical device. HealthLog stays in the display-and-track lane; it does not titrate, advise, or predict.

---

## Section 1 — Clinical data foundation (EMA + WHO ATC)

The data below is extracted verbatim or near-verbatim from EMA EPAR product information PDFs. EMA EPARs are public regulatory documents; reproduction with attribution is the standard convention for clinical reference material. Citations are direct page references in each linked PDF.

### 1.1 Tirzepatide ([EMA EPAR EN](https://www.ema.europa.eu/en/documents/product-information/mounjaro-epar-product-information_en.pdf) / [DE](https://www.ema.europa.eu/de/documents/product-information/mounjaro-epar-product-information_de.pdf))

**Indications (§4.1).** T2DM in adults / adolescents / children ≥ 10 y, adjunct to diet & exercise — monotherapy when metformin inappropriate, or combination. Weight management in adults with initial BMI ≥ 30 (obesity), or 27 to <30 (overweight) with ≥ 1 weight-related comorbidity (hypertension, dyslipidaemia, OSA, CVD, prediabetes, T2DM).

**Posology (§4.2).** Start 2.5 mg weekly. After 4 weeks → 5 mg. Increase in 2.5 mg increments after ≥ 4 weeks on current dose. Adult maintenance 5 / 10 / 15 mg; max 15 mg. Paediatric (10+, T2DM): maintenance 5 / 10 mg, max 10 mg. Missed dose: within 4 days; else skip. Dose day changeable if ≥ 3 days between doses.

**PK (§5.2).** Tmax 8–72 h. Steady state after 4 weeks weekly dosing. SC bioavailability 80%. Vd ~10.3 L (T2DM) / 9.7 L (obesity). Albumin binding 99%. CL ~0.06 L/h. **Elimination half-life ≈ 5 days.** No clinically relevant effect of age, sex, race, body weight, renal impairment (incl. ESRD), or hepatic impairment.

**Population PK model** (Schneck/Urva 2024, [PMC10962491](https://pmc.ncbi.nlm.nih.gov/articles/PMC10962491/)). Two-compartment first-order. Ka 0.0373 h⁻¹ (IIV 22.5%); CL 0.0329 L/h per 70 kg (IIV 14.2%); Vc 2.47 L per 70 kg (IIV 49.0%); Vp 3.98 L per 70 kg; Q 0.126 L/h per 70 kg; F fixed 0.80. Only retained covariate: body weight (~1.1% exposure shift per kg over 70–120 kg).

**Adverse reactions (§4.8, Table 1).** *Very common (≥ 1/10):* hypoglycaemia (with sulphonylurea / insulin), nausea, diarrhoea, vomiting, abdominal pain, constipation. *Common (≥ 1/100 to <1/10):* hypersensitivity, hypoglycaemia (with metformin / SGLT2i), decreased appetite, dizziness, hypotension, dyspepsia, abdominal distention, eructation, flatulence, GERD, hair loss, fatigue, injection-site reactions, HR increased, lipase / amylase / calcitonin increased. *Uncommon:* weight decreased, dysgeusia, dysaesthesia, cholelithiasis, cholecystitis, acute pancreatitis, delayed gastric emptying, injection-site pain. *Rare (post-marketing):* anaphylactic reaction, angioedema. GI events are dose-dependent and higher during titration (T2DM phase-3 pool: 5/10/15 mg → 37.1 / 39.6 / 43.6% vs placebo 20.4%).

**Contraindications (§4.3).** Hypersensitivity to active substance or excipients.

**Warnings (§4.4).** Caution in: history of pancreatitis (not studied), severe GI disease incl. severe gastroparesis, diabetic retinopathy / macular oedema. Pulmonary aspiration risk during anaesthesia / deep sedation. Pregnancy not recommended; discontinue ≥ 1 month before planned pregnancy due to long half-life. Breast-feeding acceptable.

**Interactions (§4.5).** Delays gastric emptying. Monitor narrow-TI drugs (warfarin, digoxin) at initiation / dose changes. Oral contraceptive exposure reduced after single 5 mg dose but not clinically relevant.

**Storage (§6.3, §6.4).** Refrigerate 2–8 °C; do not freeze. Shelf life 2 years. Single-dose pen/vial: ≤ 21 cumulative days unrefrigerated at <30 °C. **KwikPen multi-dose: 30 days at <30 °C after first use, then discard. 4 doses per pen.**

**Injection sites (§4.2).** Abdomen, thigh; back of upper arm only when injected by another person. Rotate with each dose.

### 1.2 Semaglutide injectable for T2DM ([Ozempic EPAR](https://www.ema.europa.eu/en/documents/product-information/ozempic-epar-product-information_en.pdf))

**Indication (§4.1).** Adults with insufficiently controlled T2DM, adjunct to diet & exercise; monotherapy when metformin inappropriate, or combination.

**Posology (§4.2).** Start 0.25 mg weekly → 4 w → 0.5 mg → ≥ 4 w → 1 mg → ≥ 4 w → 2 mg. 0.25 mg is not a maintenance dose. Max 2 mg/week. Missed dose: within 5 days; else skip.

**PK (§5.2).** Half-life ≈ 1 week; SC bioavailability 89%; clearance ~0.05 L/h; albumin binding > 99%; steady-state stable to week 72; ~18% exposure shift per 20% body-weight shift.

### 1.3 Semaglutide for weight management ([Wegovy EPAR](https://www.ema.europa.eu/en/documents/product-information/wegovy-epar-product-information_en.pdf))

**Indication (§4.1).** Same BMI thresholds as Mounjaro weight-mgmt (≥ 30 or ≥ 27 with comorbidity). Adolescents ≥ 12 if obesity + body weight > 60 kg (pediatric BMI cut-offs tabulated in §4.1 Table 1).

**Posology (§4.2, Table 2).** Wk 1–4: 0.25 mg → wk 5–8: 0.5 mg → wk 9–12: 1 mg → wk 13–16: 1.7 mg → maintenance 2.4 mg. After ≥ 4 weeks on 2.4 mg, may escalate to 7.2 mg if BMI ≥ 30 at initiation.

**PK (§5.2).** Same molecule as Ozempic; mean half-life ≈ 1 week; Vd ~12.4 L; present in circulation ~7 weeks after the last 2.4 mg dose.

### 1.4 Liraglutide for weight management ([Saxenda EPAR](https://www.ema.europa.eu/en/documents/product-information/saxenda-epar-product-information_en.pdf))

**Indication (§4.1).** Adults BMI ≥ 30 or ≥ 27 with comorbidity. Adolescents ≥ 12 if obesity + body weight > 60 kg. Children 6 to <12 if obesity + body weight ≥ 45 kg.

**Posology (§4.2, Table 3).** Daily SC injection. Start 0.6 mg → +0.6 mg per week → 3.0 mg/day. Discontinue after 12 wk at 3.0 mg if <5% weight reduction (adults).

**PK (§5.2).** Tmax ~11 h; SC bioavailability ≈ 55%; Vd ~20–25 L (100 kg patient); protein binding > 98%; clearance ~0.9–1.4 L/h; **half-life ≈ 13 hours** — fundamentally different cadence from once-weekly agonists.

### 1.5 Dulaglutide (Trulicity) and Retatrutide (trial)

Dulaglutide: once-weekly, half-life ~5 days, SC bioavailability ~47–65%; "known drug" in the static reference, full data deferred to v1.5. Retatrutide (triple agonist, phase 3 ongoing): out of scope until / unless EMA approval lands — including it now implies endorsement of unauthorised use.

### 1.7 — Data-foundation assets from my-glp-shot (license verdict)

Probed 2026-05-14 (see §9.5 teardown).

**License verdict.** `thejdubb02/my-glp-shot` is published **without any LICENSE file**. GitHub API reports `license: null`. The README claims "open-source" but never names a licence. Under default copyright law this is **all rights reserved** — stricter than AGPL. Not portable as code, schema, or curated dataset.

**Half-life values themselves.** Numerical physical constants (5 days for tirzepatide, 7 days for semaglutide, etc.) are **uncopyrightable facts**. HealthLog will source them directly from EMA EPARs and psp4.13099 (§1.1, §2.6) — both primary regulatory / peer-reviewed sources. The my-glp-shot `MED_PRESETS` block is useful as a *sanity check* (all approved-drug half-lives in that block agree with the EMA labels HealthLog will cite) — not as an import.

**Assets effectively portable.** None. The right path is the one already in §8 — build the reference layer from EMA EPARs directly.

**Assets to deliberately NOT borrow.** (1) Retatrutide inclusion (no EMA approval); (2) the simplified single-exponential decay PK math (§9.5 — less rigorous than HealthLog's planned Bateman / two-compartment approach); (3) the mixing calculator (§9.5 — flagged N2 in §12.3).

---

## Section 2 — PK curve visualization

### 2.1 What third-party apps show

Shotsy renders an "estimated medication levels" curve as the marketing-page headline. Glapp labels the weekly cycle in phases ("rise / peak / fade") and overlays a drug-concentration estimate. The Mounjaro Blood Level Simulator ([mounjaro-simulator.github.io](https://mounjaro-simulator.github.io/)) cites Schneck/Urva 2024 two-compartment, uses 80% bioavailability fixed, imports dose CSVs from Shotsy. Shotwise ([shotwise.app](https://shotwise.app/faq)) advertises "first-order absorption" simulation. The visualization converges across all four: time-axis weeks, value-axis "estimated level" (arbitrary units), dose events as vertical markers, sawtooth curve rising after each dose then exponentially decaying.

### 2.2 Modelling approach

Minimally-defensible model: **one-compartment with first-order absorption + first-order elimination** (Bateman). Both Ka and the terminal half-life are publicly cited in EMA EPAR §5.2.

```
C(t) = (F * D * Ka / (V * (Ka - Ke))) * (exp(-Ke * (t - t_dose)) - exp(-Ka * (t - t_dose)))

F  = SC bioavailability  (tirzepatide 0.80, semaglutide 0.89, liraglutide 0.55)
Ka = absorption rate     (tirzepatide ~0.0373 h⁻¹ per Schneck/Urva)
Ke = ln(2) / t_half      (tirzepatide t_half = 5 d → Ke ≈ 0.00578 h⁻¹)
V  = volume of distrib   (tirzepatide ~10.3 L, semaglutide ~12.4 L, liraglutide ~22 L)
```

Total concentration is the linear superposition over past doses. The Mounjaro Simulator uses two-compartment for higher fidelity; for HealthLog's **display** purpose, one-compartment is sufficient and easier to defend. Two-compartment becomes necessary only if HealthLog ever exposes peak-vs-trough numerics — which it should not.

### 2.3 Regulatory / safety positioning

The output must be framed as **estimated** from **population PK in public regulatory documents**, not measurement, not individual prediction.

- Y-axis label: "Estimated level (relative)," not "Plasma concentration." Avoid nmol/L. Per-patient variability is large (tirzepatide Ka IIV 22.5%, Vc IIV 49%).
- Hover tooltip carries the disclaimer once: "Educational estimate based on EMA-published population pharmacokinetics. Not a measurement. Not medical advice."
- Settings flag `User.researchMode` (default off). The curve hides until opt-in. "Research view" frames it for the curious power user, away from anyone who might read it as guidance.
- The Coach must **never** read drug-level estimates as input. Refusal layer rejects any dependent question ("Should I inject earlier because my level is dropping?" → safe deflection).

### 2.4 UI sketch

Dashboard surface: a **"Shot phase"** chip on the GLP-1 tile — qualitative state (rising / peak / fading), no number. Click expands the research-view chart: Recharts AreaChart, single series, x-axis = last-N-weeks (4 / 8 / 12 / 24), y-axis hidden, vertical reference lines on injection events, shaded band for dose-change weeks.

### 2.5 Verdict

Yes — opt-in, behind `researchMode`. It is the single most-requested feature in the third-party landscape; the math is public, cited, reproducible; the data is already in the schema. Carefully: the disclaimer must be undismissable, the Coach must not reason from it, the user-facing label must not imply individual prediction.

### 2.6 — Peer-reviewed validation (ASCPT psp4.13099)

**Citation.** Schneck K, Urva S. "Population pharmacokinetics of the GIP/GLP receptor agonist tirzepatide." *CPT: Pharmacometrics & Systems Pharmacology* 2024;13(3):494–503. DOI [10.1002/psp4.13099](https://doi.org/10.1002/psp4.13099). Open-access mirror: [PMC10962491](https://pmc.ncbi.nlm.nih.gov/articles/PMC10962491/). Authors: Karen Schneck, Shweta Urva (Eli Lilly Global PK/PD & Pharmacometrics).

**Marc-requested cross-check.** The Schneck/Urva 2024 paper Marc asked the agent to validate against turns out to be the *exact* paper whose parameters this research file already cites in §1.1 (the PMC mirror and the journal-of-record entry are the same article). The values in this file are therefore peer-reviewed primary-source values, not derivative.

**Authoritative methods statement (verbatim).** "Tirzepatide pharmacokinetics were well-described by a two-compartment model with first order absorption and elimination. The tirzepatide population PK model utilized a semimechanistic allometry model to describe the relationship between body size and tirzepatide PK."

**Model structure confirmed.** **Two-compartment** with first-order absorption and first-order elimination — contradicts the simpler one-compartment Bateman model proposed in §2.2 for HealthLog's display layer. The two-compartment structure is the correct *fidelity* model (and what `mounjaro-simulator.github.io` already implements). The one-compartment closed-form remains adequate for HealthLog's qualitative "shot phase" chip (§2.4) since the chip surfaces a phase label, not a numeric concentration. **For the opt-in research-view curve (R8, deferred to v1.5), two-compartment is the more defensible choice** when finally built, because it matches both the Mounjaro Simulator (citation-aligned) and the journal-of-record.

**Parameter table (Table 3 of the paper, verbatim).**

| Parameter | Estimate | Unit | Allometric scaling |
|---|---|---|---|
| Ka (absorption rate constant) | 0.0373 | 1/h | — |
| CL (clearance) | 0.0329 | L/h per 70 kg | exponent 0.8 |
| Vc (central volume) | 2.47 | L per 70 kg | exponent 1.0 |
| Vp (peripheral volume) | 3.98 | L per 70 kg | exponent 1.0 |
| Q (inter-compartmental CL) | 0.126 | L/h per 70 kg | exponent 0.8 |
| F (bioavailability) | 0.80 | fixed | — |
| t½ (terminal half-life) | 5.4 | days | — |

**EMA agreement.** EPAR §5.2 cites "elimination half-life ≈ 5 days," SC bioavailability 80%, Vd ~10.3 L (T2DM) / 9.7 L (obesity), CL ~0.06 L/h. The PK paper's Vc+Vp (2.47+3.98 = 6.45 L/70kg) is the central-plus-peripheral volume at 70 kg, which scales linearly to ~9.2 L at 100 kg, ~10.3 L at 112 kg — **consistent with EMA's apparent Vd within rounding**. Half-life 5.4 d (paper) vs ≈ 5 d (EMA EPAR) — **agreement, no drift**.

**Study scale.** 5 802 participants across 19 pooled studies → 39 644 PK observations. NONMEM 7.4.2, first-order conditional estimation with interaction (FOCEI). Reference body weight 70 kg.

**Covariate findings.** Body weight is the only retained significant covariate on CL (allometric exponent 0.8, time-varying). Fat-mass fraction (0.482) affects volume of distribution. No statistically significant effect on PK from age, renal markers, hepatic markers, race, or ethnicity — re-confirming the EPAR §5.2 statement that no dose adjustment by demographic subgroup is needed.

**HealthLog implication.** No correction needed to the values already in §1.1 or §2.2 — the existing parameter row in §1.1 sources them correctly with the same citation. **One correction stands**: §2.2 says "one-compartment is sufficient and easier to defend" for the research-view curve; with psp4.13099 as the journal-of-record, the more rigorous answer is "one-compartment for the qualitative phase chip; two-compartment for the curve, matching the journal-of-record and the Mounjaro Simulator." Update §2.2's two-compartment caveat to reflect this when the v1.5 research-view chart (R8) is implemented.

---

## Section 3 — Side-effect logbook

**Current state.** HealthLog has `MoodEntry` with free tags. W4d landed the lighter tag-set approach per sibling research §2.4, not a dedicated `SymptomLog` table.

**EMA-derived vocabulary** (from §1.1 §4.8). The right vocabulary for a GLP-1 picker is the EMA categorical list, clustered:

- **GI very common during titration:** nausea, vomiting, diarrhoea, constipation, abdominal pain.
- **GI common:** dyspepsia, abdominal distention, eructation, flatulence, GERD.
- **Metabolism (T2DM common):** hypoglycaemia, decreased appetite.
- **General common:** fatigue, injection-site reactions.
- **Other common:** dizziness, hair loss, heart-rate increased.
- **Uncommon, flag for clinician:** dysgeusia, dysaesthesia, cholelithiasis, cholecystitis, acute pancreatitis.
- **Rare, emergency:** anaphylactic reaction, angioedema.

**UX pattern.** Glapp uses a flat list of ~8 symptoms; Jabby uses a 0–10 severity slider; MyTherapy uses free-text autocomplete. Middle path: a fixed list of ~10–12 EMA "very common" + "common" entries, plus a free-text "other" field. Severity optional, 3-level (mild / moderate / severe) — the same scale EMA uses for phase-3 trial events.

**Storage.** Extend `MoodEntry.tags` with prefixed values (`glp1.gi.nausea`, `glp1.gi.diarrhoea`). Coach snapshot already aggregates moodTags. Severity becomes `glp1.gi.nausea.severity:mild`. Promote to dedicated `SymptomLog` table only if severity-over-time charts become a v1.5 demand.

**HealthLog beats Shotsy / Glapp / Jabby here:** the Coach. None of those apps has an LLM that can read the symptom log against the dose-change timeline and produce a one-paragraph weekly debrief. HealthLog's Coach already reads the snapshot; once it includes structured GLP-1 GI symptoms timestamped against dose changes, it can outperform any third-party app surveyed on this surface.

### 3.4 — Side-effect vocabulary cross-check vs my-glp-shot OSS

my-glp-shot (§9.5) ships a 21-entry vocabulary in 5 categories (`digestive`, `energy`, `mood`, `glp1`, `other`) with a 4-level severity scale (`none / mild / moderate / severe`). Comparison against the EMA-derived list proposed in §3.2:

| my-glp-shot category | Items (illustrative) | EMA equivalent | HealthLog choice |
|---|---|---|---|
| `digestive` | nausea, heartburn, vomiting, diarrhoea, constipation, abdominal pain, dyspepsia | "GI very common" + "GI common" (§3.2 first two clusters) | **EMA wins**: same coverage, cites a regulatory source, granular enough for the doctor report |
| `glp1` (drug-specific) | injection-site reactions, dose-day fatigue, mild appetite drop | "General common" + "Metabolism common" (§3.2 clusters 3–4) | **EMA wins**: explicit "decreased appetite" + "fatigue" + "injection-site reactions" with cited section §4.8 |
| `energy` | fatigue, low energy, temperature shifts | partial overlap with "General common" + "Other common" | **EMA wins**: same items, regulatory grounding |
| `mood` | anxiety, low mood, irritability | *not present in EMA §4.8 categorical list for tirzepatide* | **Open question**: my-glp-shot includes mood; EMA doesn't categorise these as "very common" / "common" GLP-1 ADRs. HealthLog already has `MoodEntry` separately; do not duplicate. If the user reports a mood shift it belongs in the mood log, not the GLP-1 side-effect log. |
| `other` | misc free-text | EMA's "Uncommon" + "Rare" (cholelithiasis, pancreatitis, angioedema) | **EMA wins**: structured categorisation with clinician-flag escalation; free-text "other" can stay as fallback |
| Severity 4-level | none / mild / moderate / severe | EMA phase-3 trial reporting uses mild / moderate / severe (3 levels) | **EMA wins**: "none" is implicit (no log entry); 3-level matches EMA convention |

**Recommendation.** Stay with the EMA categorical list (§3.2) as the primary vocabulary — it's cited, regulator-grounded, and clinician-facing in the doctor report. Borrow only the **4-level severity → 3-level severity** structure from my-glp-shot is *not* needed; HealthLog's 3-level (mild / moderate / severe) is the better match to EMA convention. Do **not** import the `mood` GLP-1 subcategory; route those to the existing `MoodEntry` instead. The 21-item my-glp-shot list overlaps ~70% with the EMA list — the gap is mostly non-categorical items (mood, "low energy") that are better tracked elsewhere in HealthLog.

---

## Section 4 — Dose-escalation guidance

**What the regulator publishes.** Each EMA EPAR §4.2 gives the canonical titration schedule (see §1.1–1.4). Publicly authorized clinical text. **Showing it is safe; recommending the user act on it without their clinician is not.**

**Third-party landscape.** Glapp gives "dose titration guidance"; MyTherapy markets "dose escalation reminders"; Jabby and Shotsy let users log dose changes but don't prescribe a next step. The closer an app gets to "you should escalate now," the closer it gets to the MDR decision-support threshold.

**HealthLog: display only.** Surface the EMA-canonical titration schedule alongside the user's own dose history, so the user can see "EMA says ≥ 4 weeks between increments; you've been on 5 mg for 6 weeks." Do not suggest "consider escalating now." UI: small section "Standard titration (EMA)" on the GLP-1 medication card, current step highlighted, footnote attributing EMA and deferring to clinician.

**Coach refusal layer.** GROUND RULE 9 (PROMPT_VERSION 4.25.0) already refuses dose recommendations. The refusal text can now cite the EMA schedule and defer: "EMA's standard titration interval is ≥ 4 weeks between dose increases. Whether you should escalate at your next interval depends on tolerability and your clinician's assessment. I won't make that recommendation."

---

## Section 5 — Injection-site rotation

**What HealthLog ships (W4d).** 4-zone abdomen + thigh + arm picker, least-recently-used recommender, `InjectionSite` per-event history.

**Third-party landscape.** InjectionLog ([injectionlog.com](https://injectionlog.com/)) — point-precise body map with recency heatmap (sharpest UX in the category). Shotsy — zone-level only. Glapp — "smart rotation," UI detail not in public marketing. Jabby — visual guides. MyTherapy — stylized diagram.

**What HealthLog could add.** Two cheap refinements: (a) **recency heatmap colouring** on existing zones (1-week-old quadrant warmer than 5-week-old; data already there), (b) **"do not use" toggle per zone** for surgical scars / lipohypertrophy spots (one bit per zone). InjectionLog's point-precision picker is over-engineered for the clinical purpose; 4-zone granularity is sufficient.

**Verdict.** Current picker is competitive. Two small additions are v1.4.26-or-v1.5 polish, not foundational.

---

## Section 6 — Compliance + reminders

**What HealthLog ships.** `MedicationSchedule.daysOfWeek` (weekly cadence), `ReminderEvent` scheduling, Telegram / ntfy / Web Push delivery, missed-dose detection at the adherence-counting layer.

**Borrow from third-party.** Medisafe's [persistent-notification pattern](https://www.donedose.com/guides/best-injection-site-rotation-app) — re-prompts at window start / middle / end if not logged. Round Health's [three-prompt cadence](https://www.imedicalapps.com/2016/11/round-health-app-personal-assistant-pill-taking/) — same shape with escalating urgency. The win is **reliability for weekly cadence**: a weekly injection that drifts a day is half the user's compliance gap; multi-prompt reminders reduce drift.

**Add in v1.4.26.** (1) Multi-prompt reminders for weekly meds: window start + 4 h in + 1 h before window end; per-medication opt-out. Extends `reminder-worker.ts` to schedule multiple events per dose. (2) "Missed last week" detection with one-tap "log retroactively" button on the dashboard tile.

**Streak chip.** Shotsy + Glapp both show "weeks logged in a row." Surface this on the GLP-1 tile ("consecutive weeks logged: 12"). Light gamification but specifically clinically useful — a broken streak is a meaningful signal worth surfacing.

---

## Section 7 — Weight-loss projection

**Third-party landscape.** Jabby — "AI weight-loss forecasting" as headline. Mounjaro Simulator — drug levels only, no weight projection. Glapp — clinical-trial comparison + peer-outcome benchmarking (no individual projection but close).

**Why HealthLog should not ship this.** Three lines crossed: (1) implies deterministic biology — clinical-trial mean weight loss for tirzepatide is 22.5% at week 72 (EMA EPAR §5.1, SURMOUNT-1), but individual variability is large; (2) sets the user up for failure when actual loss undershoots the projection; (3) is **prediction** in the MDR sense — "to predict" is a hallmark of medical-device classification ([Voelker Gruppe](https://www.voelker-gruppe.com/kompetenzen/medizinrecht/beitraege/ce-marking-medical-apps)).

**Ship instead.** Existing weight chart with injection markers + dose-change vertical lines + Coach narrative-of-the-past ("you've lost X kg over Y weeks, which aligns with published clinical-trial range Z–W kg over the same window"). Coach describes what happened, never projects what will happen.

**Verdict.** Hard no on individual projection.

---

## Section 8 — Multi-drug support

### 8.1 Schema sketch — the static reference layer

Read-only, no user input. Ship as TS module (`src/lib/medication/glp1-reference.ts`) so it versions alongside code, not as a seeded DB table.

```typescript
export type Glp1Drug = {
  id: "tirzepatide" | "semaglutide" | "liraglutide" | "dulaglutide";
  brandNames: string[];                       // ["Mounjaro", "Zepbound"]
  emaEparUrl: string;                         // citation footnote
  pharmacology: {
    routeOfAdministration: "subcutaneous";
    bioavailability: number;                  // 0.80 / 0.89 / 0.55
    halfLifeHours: number;                    // 120 / 168 / 13
    tmaxHours: { min: number; max: number };
    volumeOfDistributionL: number;
    absorptionRateKaPerHour: number;          // 0.0373 (tirzepatide, Schneck/Urva)
    steadyStateWeeks: number;
    proteinBindingPercent: number;
  };
  dosing: {
    schedule: "weekly" | "daily";
    titrationStepsMg: number[];               // [2.5, 5, 7.5, 10, 12.5, 15]
    titrationIntervalWeeks: number;
    maintenanceDosesMg: number[];
    maxDoseMg: number;
    missedDoseGraceDays: number;              // 4 / 5 / 0
    minIntervalBetweenDosesDays: number;
  };
  indications: {
    t2dm: { available: boolean; ageMin: number | null };
    weightManagement: {
      available: boolean;
      bmiThresholdNoComorbidity: number;     // 30
      bmiThresholdWithComorbidity: number;   // 27
      adolescentSupported: boolean;
    };
  };
  adverseReactions: {                         // per EMA §4.8
    veryCommon: AdverseReaction[];            // ≥ 1/10
    common: AdverseReaction[];                // 1/100–1/10
    uncommon: AdverseReaction[];              // 1/1 000–1/100
    rare: AdverseReaction[];                  // 1/10 000–1/1 000
  };
  contraindications: string[];
  warnings: string[];
  drugInteractionsNarrowTI: string[];         // ["warfarin", "digoxin"] — monitor only
  storage: {
    refrigeratedRangeC: [number, number];     // [2, 8]
    inUseAtRoomTempDays: number;              // 30 KwikPen, 21 single-dose
    inUseAtRoomTempMaxC: number;              // 30
    dosesPerPen: number;                      // 4 for Mounjaro KwikPen
  };
};
```

### 8.2 Priority

(1) Tirzepatide — full data v1.4.26; (2) semaglutide injectable + weight-mgmt — same release; (3) liraglutide — same release; (4) dulaglutide — v1.5; (5) compounded semaglutide / tirzepatide — generic-entry under same active substance, flagged "compounded"; (6) retatrutide — deliberately omitted until EMA approval.

### 8.3 Where the data is read

GLP-1 medication card (titration schedule, contraindications, warnings); Coach snapshot (current dose, maintenance range); drug-level chart (PK parameters); pen-inventory tile (`dosesPerPen`, `inUseAtRoomTempDays`); doctor report (standard titration alongside user's actual dose history).

---

## Section 9 — Open-source tools analysed (Tier 2)

### 9.1 monkeydriven/mounjaro_calc

[Repo](https://github.com/monkeydriven/mounjaro_calc). Single `index.html`, MIT licence. Bidirectional click ↔ mg ↔ weeks calculator for the Mounjaro KwikPen. Linear interpolation `y = y1 + (x - x1) * (y2 - y1) / (x2 - x1)` over a 3-anchor lookup per pen strength. Includes pen price in EUR for cost-per-dose. **Borrowable:** click-to-dose lookup tables — but only if HealthLog supports the manual-clicks-as-dose workflow that compounded-vial users want; skip until requested. **Not borrowable:** hard-coded EUR pricing and the bidirectional UI shape.

### 9.2 mounjaro-simulator.github.io

[Site](https://mounjaro-simulator.github.io/). Two-compartment PK simulator built on [Schneck & Urva (2024)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10962491/). UI: dose selector (2.5–15 mg), clicks slider, look-back filter (7 / 14 / 30 / 60 / 90 days), dose history table, CSV import from Shotsy. "Educational only" disclaimer. **Borrowable as pattern:** CSV import/export between trackers — HealthLog already exports via `/api/export/medications.csv`; aligning column names with Shotsy's would let users migrate without retyping. **Borrowable as data:** the Schneck/Urva PK parameters seed HealthLog's reference layer for tirzepatide. **Not borrowable:** code is closed-source; Bateman math is reproducible from first principles.

### 9.3 peytoncchen/PK-Visualization

[Repo](https://github.com/peytoncchen/PK-Visualization). Stanford Appel Lab. MIT, 10 stars. Web app, HTML + Pyodide + SciPy + NumPy. Multi-compartment first-order kinetics, RK4 ODE integration, forward + inverse modes. **Architecture is wrong for HealthLog:** Pyodide-in-browser is 5 MB WASM overhead; closed-form Bateman in JS over 2 016 points (12 weeks × 1-hour resolution) is sub-millisecond and bundle-free.

### 9.4 Schneck & Urva 2024 paper

[PMC10962491](https://pmc.ncbi.nlm.nih.gov/articles/PMC10962491/). Population PK model for tirzepatide; citable parameter source for HealthLog's reference layer (numbers reproduced in §1.1). Same article as DOI [10.1002/psp4.13099](https://doi.org/10.1002/psp4.13099) — see §2.6 for the peer-reviewed validation.

### 9.5 — thejdubb02/my-glp-shot (OSS counterpart of myglpshot.com)

[Repo](https://github.com/thejdubb02/my-glp-shot). Promoted from Tier-3 (UX-only, §10) to Tier-2 (code teardown) after Marc surfaced the source repo 2026-05-14.

**Stack.** Vanilla HTML / CSS / JavaScript PWA (no framework), Chart.js for visualization, IndexedDB for local storage, Web Crypto API (AES-256-GCM, PBKDF2-SHA-256) for client-side encryption. Backend: Python 3.11 + Flask + SQLite, Docker-containerized, deployed on Hetzner VPS behind Cloudflare. The **entire clinical data model lives client-side**; the Flask backend stores only opaque encrypted blobs (`sync_blobs.ciphertext`) for cross-device sync. Repo size 22 MB, default branch `main`, single contributor, 0 stars at probe time.

**License — critical finding.** The repository's `license` field on the GitHub API is `null` ([api.github.com/repos/thejdubb02/my-glp-shot](https://api.github.com/repos/thejdubb02/my-glp-shot)). No `LICENSE` or `LICENSE.md` file is committed to the root or any subdirectory. The README claims "open-source" but does not specify a license. **Under US/EU copyright law, code published on a public repository without an explicit license is "all rights reserved" by default** — *not* in the public domain, *not* MIT, *not* portable. Marc's directive said "MIT/Apache-2.0 → port; AGPL → pattern-inspiration only" — the actual answer is **stricter than AGPL: read-only inspiration, no porting of any kind**.

**Backend data model** (Flask + SQLite, `api/app.py`). Only auth and opaque sync — *no clinical schema on the server.* Tables: `users` (auth + Stripe billing), `sync_blobs` (per-user encrypted ciphertext, iv, updated_at), `share_links` (doctor-share tokens with iv + ciphertext + TTL), `sessions`, `password_resets`, `stripe_events`, `legacy_blobs`, `admin_audit`. Endpoints: `/api/me/sync` GET/PUT/DELETE for the encrypted blob, `/api/share` for time-limited doctor links, `/api/import/parse` for Gemini-LLM screenshot import, `/api/billing/*` for Stripe. **The server never sees medication, dose, site, or side-effect values.**

**Client-side data model** (extracted from `web/app/app.js`, 300 KB, line numbers approximate).

```javascript
// MED_PRESETS — drug catalog (~line 1350)
const MED_PRESETS = [
  { id: 'tirzepatide',  name: 'Tirzepatide',  halfLifeDays: 5,    defaultDose: 5,    cadenceDays: 7, brands: ['Mounjaro', 'Zepbound'] },
  { id: 'semaglutide',  name: 'Semaglutide',  halfLifeDays: 7,    defaultDose: 1,    cadenceDays: 7, brands: ['Ozempic', 'Wegovy'] },
  { id: 'liraglutide',  name: 'Liraglutide',  halfLifeDays: 0.55, defaultDose: 1.8,  cadenceDays: 1, brands: ['Saxenda', 'Victoza'] },
  { id: 'dulaglutide',  name: 'Dulaglutide',  halfLifeDays: 5,    defaultDose: 1.5,  cadenceDays: 7, brands: ['Trulicity'] },
  { id: 'exenatide-er', name: 'Exenatide ER', halfLifeDays: 14,   defaultDose: 2,    cadenceDays: 7, brands: ['Bydureon'] },
  { id: 'exenatide',    name: 'Exenatide',    halfLifeDays: 0.1,  defaultDose: 0.01, cadenceDays: 1, brands: ['Byetta'] },
  { id: 'retatrutide',  name: 'Retatrutide',  halfLifeDays: 6,    defaultDose: 4,    cadenceDays: 7, brands: [] },
];
```

**Drug-list scope.** Seven agonists: tirzepatide, semaglutide, liraglutide, dulaglutide, exenatide-ER, exenatide, retatrutide. Half-lives stored as days only (single number, not min/max); HealthLog's planned §8.1 schema captures more (Tmax range, V, Ka, F, protein binding, steady-state). **Retatrutide is included** despite no EMA approval — HealthLog's posture in §8.2 ("deliberately omitted until EMA approval; including it implies endorsement of unauthorised use") is the more defensible call.

**Half-life cross-check vs EMA / psp4.13099.** Tirzepatide 5 d — agrees with EMA (≈ 5 d) and psp4.13099 (5.4 d). Semaglutide 7 d — agrees with EMA (≈ 1 week / 168 h). Liraglutide 0.55 d = 13.2 h — agrees with EMA (≈ 13 h). Dulaglutide 5 d — agrees with EMA (≈ 5 d). Exenatide-ER 14 d — matches Bydureon SmPC (terminal t½ ~2 weeks). Exenatide 0.1 d = 2.4 h — matches Byetta SmPC (~2.4 h). Retatrutide 6 d — phase-2 trial data ([NCT04881760](https://clinicaltrials.gov/study/NCT04881760)), no regulatory authority since not approved. **All approved-drug half-lives in my-glp-shot agree with EMA / FDA labels** — this validates the EMA-sourced numbers in HealthLog's planned reference layer.

**Injection-site enumeration** (`CANONICAL_SITES`, ~line 1300).

```javascript
const CANONICAL_SITES = [
  'Abdomen — Upper Left',  'Abdomen — Upper Right',
  'Abdomen — Lower Left',  'Abdomen — Lower Right',
  'Thigh — Left',          'Thigh — Right',
  'Upper arm — Left',      'Upper arm — Right',
];
```

8 canonical zones with abdomen split into 4 quadrants — **matches HealthLog W4d's 4-zone abdomen + thigh + arm picker** (sibling research §1, phase-W4d-tests report). No algorithmic divergence; HealthLog's least-recently-used recommender is equivalent design intent. No advantage in porting; HealthLog ships parity here.

**Side-effect vocabulary** (`SIDE_EFFECTS` + `SE_GROUPS` + `SE_LEVELS`, ~line 1260). 21 entries grouped across 5 categories (`digestive`, `energy`, `mood`, `glp1`, `other`) with 4-level severity (none / mild / moderate / severe). See §3.4 below for full comparison vs the EMA categorical list.

**PK / drug-level math** (the curve myglpshot.com advertises).

```javascript
const decay = Math.log(2) / halfLife;
levelNow += (s.dose || 0) * Math.exp(-decay * days);
```

Single-exponential decay only — **one-compartment, instantaneous-absorption, no Ka, no Vd, no F**. Simpler than HealthLog's planned §2.2 one-compartment Bateman (which includes Ka, F, V) and dramatically simpler than the journal-of-record two-compartment model (§2.6). For the qualitative "shot phase" chip this is *sufficient*; for a research-view curve it is *not as defensible* as the Bateman / two-compartment alternatives. HealthLog's planned approach is the more rigorous of the two.

**Plateau detection** (algorithm extracted from info-dialog body and code). 4+ weight entries in last 28 days AND total change < 1 lb AND no dose increase during window → plateau. **HealthLog's W4d plateau detection should be cross-checked**: confirm the window length (HealthLog 28 d?), the change threshold (1 lb ≈ 0.45 kg — adjust for metric), and the dose-stability requirement. The latter is the key clinical insight: plateau-on-stable-dose is the actionable signal, plateau-during-titration is not. If HealthLog's algorithm conflates the two, this is a v1.4.26 bugfix candidate.

**Reconstitution / mixing calculator** (info-dialog `mixing-calc`, ~line 560).

```
concentration_mg_per_mL = vial_mg / water_mL
draw_volume_mL          = your_dose_mg / concentration_mg_per_mL
units_on_U100_syringe   = draw_volume_mL × 100
doses_per_vial          = floor(vial_mg / your_dose_mg)
```

This is the **mixing calculator for compounded peptides** flagged in §10 as the brightest MDR line — included verbatim in my-glp-shot. HealthLog's N2 ("never build mixing calculator") is the correct call; that the OSS reference ships it does not change the regulatory analysis for EU-distributed apps.

**Storage / shelf-life.** Not present in the OSS code. HealthLog's planned R4 (pen / vial inventory with EMA §6.3 30-day countdown) is *not* duplicated here; HealthLog will be the more clinically faithful tracker on this surface.

**Dose-escalation tables.** Not present — doses are stored as free-form numeric fields with no titration ladder. HealthLog's planned R2 (display EMA titration schedule) is unique to HealthLog among the OSS landscape.

**Privacy posture.** my-glp-shot's E2EE architecture is genuinely strong — server-side blobs are opaque, key derivation is PBKDF2-SHA-256 client-side, share-links carry their own iv + ciphertext. HealthLog's "self-hosted" posture is equally strong (clinical data never leaves the user's server) but architecturally different (server reads plaintext within its own trust boundary). Neither is strictly better; the my-glp-shot pattern is worth studying if HealthLog ever ships a hosted multi-tenant variant. For self-hosted v1.4.x, the existing design stands.

**Portability verdict — final.** Code: not portable (no license). Schema shape: not portable (no license). Constants table values (half-lives in days for approved drugs): the *values themselves* are not copyrightable facts — they are physical constants published in EMA / FDA labels and the psp4.13099 paper, and HealthLog should source them directly from those primary regulatory documents (already the §1.1 plan). **Verdict: read the my-glp-shot data model and `MED_PRESETS` shape for inspiration; build HealthLog's reference table from EMA EPARs and psp4.13099 directly — more authoritative anyway, and licence-clean.**

### 9.6 — my-glp-shot clean-room feature inventory (deep-dive)

**Legal posture.** my-glp-shot has no LICENSE file (re-confirmed via `https://api.github.com/repos/thejdubb02/my-glp-shot` → `license: null`). Per N11 the orchestrator has already ruled out any code-porting. This subsection documents FEATURES, DATA SHAPES, and ALGORITHMS in our own words — the same posture one would take when reading a competitor's published patent: claims and mechanisms are describable, source text is not. No prose below is copied from the repo; column names / endpoint paths / numeric defaults are reported as facts (not protected by copyright in the EU / US).

#### 9.6.1 — Architecture overview (file-tree map)

The repo is a monorepo with five top-level functional units. **`api/`** holds the Flask backend (single 67 KB `app.py` plus a thin Dockerfile and a 90-byte requirements list — Flask, bcrypt, stripe). **`web/app/`** holds the PWA frontend — a 62 KB `index.html`, a 300 KB monolithic `app.js`, a 44 KB `styles.css`, a 3.4 KB service worker, a 1.4 KB web manifest, a bundled Chart.js, plus 32 achievement-badge WebP icons and a small static-page subset (`privacy.html`, `terms.html`, `reset.html`, `view.html` — the doctor-share recipient page). **`web/admin/`** is the operator console (~22 KB JS, 9.8 KB CSS, 4.8 KB HTML — listed users, metrics, audit log). **`web/landing/`** is the marketing site (52 KB `index.html`, seven vs-competitor comparison pages, glossary, security disclosure page, sitemap). **`scripts/`** contains nine Python and JS utilities — backup, restore, premium grant/revoke, admin promotion, achievement-art generator, OG-image generator, smoke tests, theme-contrast checker, weekly audit. **`docs/`** holds three internal markdown plans (`MORNING_BRIEFING.md`, `launch-plans.md`, `visitor-experience-improvement-plan.md`) — a useful look at the founder's roadmap thinking.

The build chain is deliberately absent: no bundler, no transpiler, no package.json in `web/app/`. The 300 KB `app.js` ships as-is and is served by nginx. Service-worker cache-busting is done by versioned cache keys (`mglp-v<hash>`). The product is intentionally simple to reason about and operate; HealthLog (Next.js + Prisma + Postgres) is the opposite architectural choice. **Mapping for HealthLog:** the no-framework PWA pattern is interesting historically but **not** something to retrofit — HealthLog's Next.js / RSC / Prisma stack ships richer surfaces with less long-term maintenance than a 300 KB hand-rolled SPA. Skip.

#### 9.6.2 — Drug data foundation (Category A)

The drug catalog (`MED_PRESETS`) is the only EMA-shaped object in the codebase. Per row it carries: an internal id, a generic name, a half-life in whole or fractional days, a default starting dose in milligrams, a cadence in days, and a brand-name list (e.g. `Mounjaro`, `Zepbound` for tirzepatide). Seven entries: tirzepatide (5 d / 5 mg / weekly), semaglutide (7 d / 1 mg / weekly), liraglutide (0.55 d ≈ 13.2 h / 1.8 mg / daily), dulaglutide (5 d / 1.5 mg / weekly), exenatide-ER (14 d / 2 mg / weekly), exenatide-IR (0.1 d ≈ 2.4 h / 0.01 mg / daily), retatrutide (6 d / 4 mg / weekly).

**What's missing vs HealthLog's planned §1.1 schema:** no Tmax range, no Ka, no V (volume of distribution), no F (bioavailability), no protein binding, no steady-state-time, no min/max half-life, no titration ladder, no EMA EPAR section reference, no on-label vs off-label flag, no SUKDEX / WHO ATC code, no contraindication list, no in-use-stability days (the EMA §6.3 30-day window that HealthLog R4 will surface). **What's worth borrowing as shape inspiration:** the `brands` array (one generic mapped to many brand names — Ozempic/Wegovy, Mounjaro/Zepbound). HealthLog should adopt the same one-to-many pattern so the brand label switches without forking the underlying record.

**What's worth borrowing as default values:** none — all seven half-lives are correct *as facts* and identical to the EMA EPAR numbers HealthLog will already pull from `Section 1`. The values themselves are physical constants, not copyrightable; no portability issue.

**What HealthLog must NOT do:** include retatrutide. EMA has not approved it as of 2026-05; my-glp-shot's inclusion implies endorsement of unauthorised use (HealthLog's N7).

**Mapping:** W19a Static EMA drug knowledge layer — schema is already richer than my-glp-shot's. Build as planned; my-glp-shot validates the half-life numbers but adds no new fields.

#### 9.6.3 — Injection-site rotation (Category B)

**The site list.** Eight canonical zones: four abdomen quadrants (upper-left, upper-right, lower-left, lower-right), two thighs (left, right), two upper arms (left, right). Custom user-added sites are supported (up to ten, max 60 chars each — e.g. "Glute", "Outer thigh", "Left flank"). Legacy entries from a pre-quadrant-split version of the app (bare "Abdomen — Left/Right") are remapped to the corresponding lower quadrant for continuity — a one-time data migration encoded in the loader.

**The algorithm.** Least-recently-used over the eight canonical sites. For each site, the algorithm finds the most-recent shot logged at that site and selects the site with the oldest timestamp (or never-used). No distance-from-last-injection, no rest-period-by-site-type — pure recency.

**The visualisation.** A body diagram (SVG) with eight named circles, each coloured by recency: **orange** = used this week (rest), **teal** = 1-2 weeks ago, **light teal** = 2+ weeks ago (fresh), **unfilled** = never used. Tapping any circle selects it as the next site, so the recommendation can be overridden manually.

**Cross-check vs HealthLog W4d.** HealthLog already ships a four-zone-abdomen-plus-thigh-plus-arm picker per the W4d tests-report. The my-glp-shot algorithm is functionally identical to HealthLog's planned LRU recommender. **No advantage in porting** — HealthLog ships parity here, and the colour-by-recency body-diagram pattern is a legitimate UX inspiration (already in the W4d plan). **Possible enhancement:** my-glp-shot allows the user to *override* the recommendation by tapping any site, which makes the recommendation feel like guidance rather than constraint. HealthLog's injection-site picker should support the same tap-to-override pattern if it does not already.

**Mapping:** W4d (already shipped) — no new work. Consider a v1.4.26 polish phase if the colour-by-recency body diagram is not yet on the W4d surface.

#### 9.6.4 — Side-effect logbook (Category C)

**Vocabulary.** Twenty-one symptoms grouped across five categories. **Digestive** (nine): nausea, heartburn, indigestion, stomach pain, constipation, diarrhea, reflux/GERD, sulfur burps, metallic taste. **Energy & temperature** (five): fatigue, chills, hot flashes, night sweats, sleep disruption. **Mood** (four): low mood, anxiety, irritability, mood swings. **GLP-1 specific** (one): food noise returned. **Other** (three): headache, injection site reaction, hair loss.

**Severity scale.** Four-tier: none / mild / moderate / severe (`SE_LEVELS`).

**Capture timing.** **Per shot, not per day.** Side effects are attached to each shot record as a nested object keyed by symptom id. There is no separate side-effect time-series independent of injections — meaning a user who experiences nausea on day 4 post-shot must back-fill that into the day-0 shot record, or log a new "off-cycle" shot record placeholder.

**Visualisation.** A 30-day summary card in the Insights tab; specific algorithm not visible in the extracted prose but the data shape is straightforward — group by symptom, count per severity, render as bars or tags.

**Cross-check vs HealthLog.** HealthLog's existing mood + side-effect tagging architecture (the `mood` time-series + `feeling_tags`) is **better** in two ways: (1) it captures side effects daily, independent of injection events, so day-4-post-shot nausea is captured at its actual onset; (2) it captures intensity on a continuous mood scale rather than a 4-tier discrete one. **What's worth borrowing:** the 21-entry symptom vocabulary itself, particularly the five categories — HealthLog's current side-effect tag set may not cover all 21 (`sulfur burps`, `metallic taste`, `food noise returned`, `injection site reaction` are notably GLP-1-specific). The vocabulary *content* (the list of symptom names) cross-references EMA EPAR §4.8 (undesirable effects) — same regulatory ground truth HealthLog is already sourcing — so taxonomy convergence is incidental, not derivative.

**Mapping:** **W19d Side-effect taxonomy expansion** (new sub-wave) — audit HealthLog's existing `feeling_tags` vs EMA EPAR §4.8 + my-glp-shot's 21-entry list, add the missing GLP-1-specific tags (sulfur burps, metallic taste, food noise returned, injection-site reaction). Keep the existing daily-capture model — do NOT collapse to per-shot capture. Coach should be able to surface "you've logged nausea 3 days post-shot, 4 weeks in a row" — which requires daily timing.

#### 9.6.5 — Pen / vial inventory (Category D)

**Data shape.** A `supplies` object store with: id, type (vial / pen), total mg, volume mL (vials only), pharmacy/source string, batch/lot number, cost, date opened, expiration date.

**Doses-remaining computation.** Total mg of supply divided by the user's per-shot dose, decremented as shots are logged against the supply. A progress bar visualises the depletion.

**Expiration alert.** A warning surfaces when a pen is within **7 days of expiring** or has gone past expiration.

**30-day in-use window.** **NOT IMPLEMENTED.** This is a clinically significant omission. Per EMA Mounjaro EPAR §6.3 (shelf life), an opened KwikPen is stable for a maximum of 30 days at refrigerator or room-temperature conditions; using it beyond that window risks degraded efficacy. my-glp-shot tracks the expiry date stamped on the box but not the post-opening countdown. HealthLog's planned R4 (pen/vial inventory with EMA §6.3 30-day countdown) is therefore the **more clinically faithful** design — and on a surface where the OSS reference is *weaker*, not stronger.

**Cost capture.** Cost is stored on the supply record (one-time entry when the pen/vial is added) and separately on ad-hoc expense records (copays, pharmacy fees, labs, insurance, shipping).

**Cross-check vs HealthLog.** HealthLog has no inventory tracking today (per the v1.4.25 W19 backlog). The my-glp-shot data shape is a sensible starting point, but HealthLog must add the post-opening 30-day in-use clock per EMA EPAR §6.3 and parallel rules for Ozempic (also 56 days for in-use), Wegovy, Saxenda, Trulicity. Each drug has its own in-use stability window — HealthLog's W19a drug-knowledge layer must carry these as fields, and W19b inventory must consume them.

**Mapping:** **W19b Pen inventory** (already approved) — schema = my-glp-shot's eight fields plus `inUseUntil` computed from `openedAt + product.inUseStabilityDays`. Alert thresholds: 7-day pre-expiration banner *and* 5-day pre-in-use-window banner. Refrigeration-vs-room-temp toggle if EMA distinguishes (Mounjaro KwikPen does — refrigerator extends in-use stability).

#### 9.6.6 — Reminder + cadence visualisation (Category E)

**Shot reminders.** A boolean toggle + a lead-time selector. From the index.html extraction the lead-time options are: at-time, 30 min, 1 hour, 3 hours, 12 hours, 1 day before. Reminders fire via the browser `Notification` API (PWA-only — no native push because no iOS push for PWAs).

**Daily check-in reminders.** Four categories, each with its own enable toggle and time picker (`HH:MM` in user timezone): (1) Weight ⚖️ "Quick daily weigh-in keeps your chart honest", (2) Mood & appetite 😊 "Tap to log mood, appetite, and food-noise for today", (3) Side effects 🩺 "Logging helps spot patterns", (4) Body measurements 📏 "Time to log waist, hips, and any other tracked sites".

**.ics calendar export.** An `downloadICS()` button on the settings page generates an iCalendar file with `VEVENT` entries — likely one per upcoming scheduled shot (computed from last-shot + cadence-in-days, projected forward N occurrences). The user imports it into Apple/Google/Outlook calendar for redundant, native reminders that survive even if the PWA is uninstalled.

**Notification permission.** Requested explicitly via `Notification.requestPermission()` before any reminder can fire. A "Test notification" button lets the user verify permission status without waiting for a real reminder.

**Cadence visualisation.** The home tab carries a **countdown ring** (circular progress) showing time-to-next-shot computed from last-shot + cadence. There is no full-page calendar heatmap (GitHub-grid style); the level chart in Insights is the closest the app comes to a longitudinal dose-cadence view.

**Cross-check vs HealthLog.** HealthLog has no shot reminders today; the v1.4.25 W4d component tests cover the picker but not scheduling. HealthLog's planned roadmap includes W19/W20 reminders. **Borrow worth-having:** the four-category daily check-in model, the lead-time selector dropdown, the .ics export (a sneakily good fallback for users who turn browser notifications off). **Do not borrow:** browser-Notification-only delivery — HealthLog's v1.5 iOS app will have native APNs (per v1.4.23 outcome memory), so the design should be channel-agnostic from day one (server-side reminder records + per-channel renderer).

**Mapping:** **W19e Reminder + cadence visualisation** (new sub-wave) — server-side reminder records (drug-id, type, lead-time, channel preferences), browser-Notification renderer for v1.4.x, APNs renderer in v1.5, .ics export as a third channel, countdown-ring widget on the dashboard hero.

#### 9.6.7 — Drug-level chart (Category F)

**The math.** One-compartment instantaneous-absorption exponential decay. `levelNow = Σ_over_past_shots dose × exp(-ln(2) × days_since / halfLife)`. No Ka (absorption rate), no F (bioavailability), no V (distribution volume), no two-compartment redistribution. Each past shot contributes independently; doses superpose linearly. If a shot's stored half-life snapshot exists (added in v0.45.2), it's used; otherwise the user's current settings half-life is used (which means changing the half-life retroactively rewrites the whole curve).

**The disclaimer.** A clickable info dialog on the chart card states explicitly it is "not a clinical measurement" but rather "a learning tool to help you visualize the rhythm of your dosing". Half-lives are noted as published typical values (tirzepatide ≈ 5 d, semaglutide ≈ 7 d), customizable in settings. The calculation is framed as **descriptive, not predictive**.

**Cross-check vs HealthLog Section 2.** HealthLog's planned curve options are: (R8.a) one-compartment Bateman (Ka + half-life + F), which is **better** than my-glp-shot because absorption-phase rise is modelled, not flat-step; (R8.b) two-compartment per psp4.13099 (Schneck & Urva 2024), which is more clinically rigorous but adds complexity. my-glp-shot is the *minimum* viable curve. HealthLog should ship R8.a as default and offer R8.b under `User.researchMode` per the existing N4-N11 envelope.

**Y-axis treatment.** my-glp-shot shows relative concentration (no mg/L absolute) — the implicit unit is "dose-equivalent active fraction remaining". This is a defensible choice: avoiding absolute mg/L is one less hook for misinterpretation as a clinical measurement.

**Mapping:** **W19c Drug-level chart** (already approved) — implement R8.a Bateman by default; gate R8.b two-compartment behind researchMode; copy the "not a clinical measurement" disclaimer *concept* (write your own copy). Y-axis as relative concentration, not absolute mg/L.

#### 9.6.8 — Mounjaro / tirzepatide-specific (Category G)

**No special tirzepatide affordances.** my-glp-shot treats tirzepatide as just another row in `MED_PRESETS`. There is no titration ladder (2.5 → 5 → 7.5 → 10 → 12.5 → 15 mg over six 4-week steps), no KwikPen-form-factor field (single-dose pen vs multi-dose vial vs auto-injector), no refrigeration-vs-room-temp metadata, no Eli-Lilly-specific dosing-cup or auto-injector visualisation. The user types in their dose in mg and the app stores it.

**This is a gap, not a feature.** HealthLog's planned R2 (display EMA titration schedule as informational, not prescriptive) is unique among the open-source landscape. EMA EPAR §4.2 (posology) defines the titration: start at 2.5 mg once weekly for 4 weeks → 5 mg weekly for 4 weeks → 7.5 mg if needed → up to 15 mg max. HealthLog showing this as a passive reference card ("standard titration is 2.5→5→7.5→10→12.5→15; discuss escalation with your clinician") is informational, not decision support — outside MDR.

**Cross-check vs HealthLog.** my-glp-shot ships an unenforced Holding-Steady achievement (last 4 shots same dose), which gestures at titration awareness but doesn't *educate* the user about what the schedule looks like. HealthLog's planned passive-display approach is better.

**Mapping:** **W19a** drug knowledge layer carries titration-schedule fields; **W19f** (new) titration-reference card surfaces them on the medication detail page. No autonomous escalation prompts (N1).

#### 9.6.9 — Multi-drug support (Category H)

my-glp-shot supports seven agonists (see 9.6.2). HealthLog's planned scope is **EMA-approved only**: tirzepatide (Mounjaro, Zepbound), semaglutide injectable (Ozempic, Wegovy) + oral (Rybelsus), liraglutide (Saxenda, Victoza), dulaglutide (Trulicity), exenatide-ER (Bydureon), exenatide-IR (Byetta). **Retatrutide is excluded** — no EMA approval, including it would imply endorsement of unauthorised use (N7).

**Oral semaglutide (Rybelsus).** my-glp-shot omits this. It's a pill, daily, with a fasted-dose-then-30-min-wait-before-food requirement — very different from injectable cadence and rotation modelling, but EMA-approved and used by patients who cannot tolerate injection. HealthLog should support it explicitly: the "shot" terminology and injection-site picker would be hidden for oral routes; the level-curve math is identical (the absorption phase is fasted-state pharmacokinetics, but the elimination half-life is the same as injectable semaglutide).

**Drug-administration route field.** Implied by the above: HealthLog's drug schema needs a `route` enum (injection-subcutaneous, oral-pill, oral-solution) so the UI can render the appropriate logging surface — site picker for SC, just dose + time for oral.

**Mapping:** **W19a** drug knowledge layer — add `route` enum, ensure Rybelsus is in the catalog as `oral`. **W4d** injection-site picker — hide for non-injection routes. Update the W4 home tab logging surface to switch between site picker (injection) and pill-time picker (oral) based on the active drug's route.

#### 9.6.10 — Doctor share-out (Category I)

**The mechanism.** A POST `/api/share` creates a 24-hour-TTL share-link record (`share_links` table: token, user_id, iv, ciphertext, created_at, expires_at, views, label). The ciphertext carries an encrypted snapshot of the user's selected data sections. The token is a 32-char hex. The recipient opens `view.html?token=<token>#<key>` — the decryption key is in the URL fragment (which is never sent to the server). The view page decrypts in the browser and renders a read-only dashboard.

**Selectable sections.** Per the share modal: shots, weights, measurements, labs, moods, appetites, supplies, expenses. Date range: 30 / 90 / 180 / 365 days or all-time. Optional 120-char label (e.g. "Pre-op cardiology consult — Dr Schmidt").

**View counter and revoke.** Each access increments `views`. The owner can revoke a link explicitly via DELETE `/api/share/<token>`.

**PDF export.** A separate flow from the share-link mechanism. PDF export uses the browser's print-to-PDF capability after rendering a print-styled summary page. Sections: shots, weights, measurements, labs, moods, appetites, side-effects. Targets ~90-day window by default.

**Cross-check vs HealthLog.** HealthLog already has a doctor report (per the v1.4.25 roadmap memories — "doctor-report which already has GLP-1 section"). The my-glp-shot pattern is interesting in three respects: (1) **time-limited encrypted shares** for clinicians who don't want to install an app — HealthLog's doctor report is presumably a PDF download today; a self-hosted equivalent of `/share/<token>` with TTL would let clinicians open a read-only browser view without uploading a file; (2) **selectable data sections** rather than all-or-nothing; (3) **view counter** for the patient to know if the clinician actually opened it. The encryption-key-in-fragment trick is elegant for an E2EE multi-tenant SaaS but **not necessary** for self-hosted HealthLog (server-side trust boundary is acceptable).

**Mapping:** **W19g Doctor-share TTL link** (new sub-wave) — self-hosted equivalent of `/api/share/<token>` with 24/48/72-hour TTL options, selectable sections, view counter. Encryption-in-URL-fragment NOT needed (self-hosted). PDF export continues as the primary clinician artifact; the TTL link is a complementary live-data alternative.

#### 9.6.11 — Compliance metrics (Category J)

**Streaks.** Consecutive weeks with a shot logged near the scheduled cadence. The threshold for "near" is implicit (likely ±1-2 days from the expected next-shot date). Achievement tiers: 2 / 4 / 8 / 12 / 26 / 52 / 104 weeks.

**Weeks on track.** Total weeks elapsed since first logged shot, regardless of misses. A pure age metric, displayed in the hero stats.

**Shot count.** Cumulative total. Achievement tiers: 1 (first), 3, 10, 25, 50, 100, 200, 500.

**Weight-loss tiers.** Computed as `start_weight − latest_weight` (start auto-detected from first weight entry if not explicitly set). Achievement tiers: 2 / 5 / 10 / 15 / 25 / 40 / 50 / 75 / 100 lb. **This is a US-pounds-only schema** — would need metric-aware tiers for HealthLog (1 / 2 / 5 / 10 / 15 / 20 / 25 / 35 / 50 kg).

**Engagement metrics.** Mood-entry streaks (7-day, 30-day). Weight-entry counts (10, 50).

**Comeback achievement.** Triggered when a user resumes after an extended gap. Exact threshold not surfaced.

**Cross-check vs HealthLog.** HealthLog already ships a Health Score and Daily Briefing with compliance dimensions (per v1.4.20 memories). The my-glp-shot tile-by-tile achievement system is gamification-heavy in a way HealthLog has *deliberately* avoided (Marc's directive: medical-grade, professional, no AI mention, no infantilizing). **Direct adoption is a no.** **What's worth borrowing:** the *underlying compliance metrics themselves* — on-cadence streak, total-shots, weeks-on-track — surfaced as compact dashboard chips, **not** as celebratory badges with WebP art. The Health Score can already roll up on-cadence into its dimensions; a "Streak: 4 weeks" chip on the GLP-1 detail page is the lightest possible surface.

**Mapping:** **W19h Compliance metrics chips** (new sub-wave) — calculate streak, weeks-on-track, total-shots; surface as monochrome chips on the GLP-1 detail page. Feed streak into Health Score dimensions. **No gamified badges.**

#### 9.6.12 — Data export / import (Category K)

**JSON export.** Top-level keys: shots, weights, settings, moods, supplies, measurements, labs, expenses, appetites, foodNoise, cycles, medChanges. Each is the raw IndexedDB store dumped to JSON. This is a complete back-up suitable for archival or for migrating to another my-glp-shot install.

**CSV export.** Per-category CSV files (shots.csv, weights.csv, etc.) for spreadsheet workflows.

**Smart import.** A cross-tracker format detector. Mentioned competitors recognised: Shotsy, Glippy, MyFitnessPal. Detection heuristics are implicit (presumably column-name / file-structure patterns).

**LLM import.** `/api/import/parse` accepts up to 1.5 MB of arbitrary text (screenshots transcribed via paste, freeform notes, CSV) and forwards it in ≤120 KB chunks to Google Gemini 2.5 Flash. Gemini returns structured shots and weights; the server deduplicates across chunks and caps at 5,000 entries each. The user prompts by pasting text into a textarea; the app does the LLM round-trip and shows a preview of the parsed entries before commit.

**Cross-check vs HealthLog.** HealthLog already ships measurement / medication / mood CSV exports (per the file-tree status: `src/app/api/export/measurements.csv/`, etc.). The my-glp-shot full-JSON-backup pattern is a stronger archival format than per-category CSV — HealthLog's `full-backup.json` route (also in status) is the equivalent. **What's worth borrowing:** the LLM-import-from-paste pattern is a quick win for migration. A "paste your old tracker's export here" textarea that calls Coach (HealthLog's existing LLM surface) to parse it would reduce friction for users moving from Shotsy / Glippy / Jabby. **Caveat:** this must go through HealthLog's existing Coach provenance system (no new LLM endpoint) and the parsed entries must be shown for user confirmation before commit, not silently inserted.

**Mapping:** **W19i Migration paste-import** (new sub-wave, optional) — leverage Coach to parse pasted text into structured measurement + medication entries; preview before commit. Defer past v1.4.25 if scope is tight; the manual CSV import already covers determined users.

#### 9.6.13 — Onboarding (Category L) — cross-link to W14b

**Current my-glp-shot onboarding.** Auth gate first (signup / sign-in), with a "Skip for now" escape hatch into local-only mode. Once authenticated, the user lands on a tab-active home view with the countdown card and daily-logging sections — **no guided setup**. Their own internal plan (`docs/visitor-experience-improvement-plan.md`) flags this as a top-tier UX problem and proposes a 3-screen wizard (medication, last-shot date, weight) for Week 3-4 of their roadmap. They explicitly call out empty home tab as "no guided setup, time-to-first-value requires ~30 seconds and 5 taps just to log a shot".

**What the proposed 3-screen wizard does.**
1. Screen 1: pick medication (preset dropdown — tirzepatide, semaglutide, …).
2. Screen 2: enter date of last shot (so the countdown ring and level curve have an anchor).
3. Screen 3: enter current weight (so the weight chart has a starting point).

After these three screens, the home view has a meaningful countdown ring (computed from last-shot + cadence), a populated level curve, and a starting weight point on the chart. This collapses time-to-first-value from minutes to seconds.

**Cross-check vs HealthLog W14b.** HealthLog's onboarding rebuild (W14b is in the v1.4.25 roadmap per the file-tree planning artifacts) should adopt the same minimum-data-to-populate-home pattern. The three screens for a GLP-1 user are: medication preset → date of most-recent injection → current weight. For a non-GLP-1 user, the analogue is: primary tracking goal (blood pressure / weight / mood / blood-glucose) → first reference reading → first goal/target. The pattern generalises.

**Mapping:** **W14b onboarding rebuild** — informed by this finding, the medication-aware 3-screen wizard is the right minimum-data shape. Extend with a privacy/sync screen at the end (HealthLog is self-hosted, but a "what gets shared with Coach / what stays local" screen would surface the boundary explicitly).

#### 9.6.14 — Things my-glp-shot got WRONG (don't replicate)

**1. Mixing calculator for compounded peptides.** A `concentration = vial_mg / water_mL; units = (dose_mg / concentration) × 100` calculator. This is dose calculation — the brightest MDR Class IIa line in EU. HealthLog's N2 is correct. my-glp-shot is a US-distributed product targeting "compound peptide" users (grey-market compounded GLP-1s outside FDA-approved supply chains) and the calculator is core to that audience. HealthLog's EU audience is different and the regulatory exposure is asymmetric. **Do not build.**

**2. Weight-loss benchmark overlays on user's own chart.** SURMOUNT-1, STEP-1, SCALE clinical-trial curves overlaid on the user's actual weight chart, anchored to their first-shot date. Visually appealing, but constructs a *false comparison*: trial cohorts had structured diet + lifestyle interventions, double-blinded conditions, and known compliance. Overlaying them on a self-reported home log invites the user to feel "behind" or "ahead" relative to clinical results, which is psychologically harmful when the user is statistically guaranteed to be missing one or more of the structured-trial controls. **Consider an "evidence band" instead** — render the trial result as a static reference range in a separate Insights card with the explicit framing "trial-cohort outcomes for context, not a target".

**3. Retatrutide in the drug catalog.** No EMA approval as of 2026-05. Inclusion implies endorsement of unauthorised use. HealthLog N7 is correct.

**4. Per-shot side-effect capture (instead of daily).** Pinning side effects to injection events means delayed-onset symptoms (nausea on day 4 post-shot is common with tirzepatide) get retroactively encoded into day-0 records. HealthLog's daily mood + tag model is better.

**5. Plain weight in pounds only.** No metric support visible in the achievement tiers. HealthLog is German-locale-first and must support kg as a first-class unit, not a UI translation of an underlying pounds-storage.

**6. Browser-Notification-only reminder channel.** No native push, no email fallback, no .ics-only fallback for users who disable notifications. HealthLog should be channel-agnostic from day one.

**7. Gamified achievement badges (32 WebP icons).** Marc directive (per memories: "feedback_marc_voice_english", "medical-grade, professional") rules out the celebratory-badge UX. The *metrics underneath* are useful; the cute-art presentation is not.

**8. Authentication wall as first impression.** Even with the "Skip for now" escape, leading with a sign-in form contradicts "no-account-required" privacy positioning. HealthLog is self-hosted so this is structurally different, but the same principle applies: surface meaningful content first, sign-in second.

**9. No 30-day in-use stability tracking.** As noted in 9.6.5. Per EMA EPAR §6.3, this is clinically relevant — using a pen beyond its 30-day post-opening window risks degraded efficacy.

**10. No dose-titration ladder display.** Tirzepatide / semaglutide / dulaglutide all have EMA-defined titration schedules; my-glp-shot's `MED_PRESETS` carries only a starting dose. HealthLog's planned R2 fills the gap.

#### 9.6.15 — Final pick list

For each feature: **BUILD-IN-v1.4.25**, **DEFER-v1.4.26**, **DEFER-v1.5+**, or **SKIP**.

| # | Feature | Verdict | Sub-wave | Rationale |
|---|---------|---------|----------|-----------|
| 1 | Drug catalog schema (with `brands` one-to-many) | BUILD-IN-v1.4.25 | W19a (extend) | Already approved; absorb the `brands` shape |
| 2 | Drug `route` enum (injection / oral) | BUILD-IN-v1.4.25 | W19a | Required for Rybelsus support |
| 3 | EMA-approved drug list (6 drugs, no retatrutide) | BUILD-IN-v1.4.25 | W19a | Confirms HealthLog N7 |
| 4 | Pen / vial inventory with EMA 30-day in-use clock | BUILD-IN-v1.4.25 | W19b | Already approved; my-glp-shot is *weaker* here |
| 5 | Drug-level chart (R8.a Bateman default, R8.b two-comp gated) | BUILD-IN-v1.4.25 | W19c | Already approved |
| 6 | Side-effect taxonomy expansion (21 entries, 5 categories) | BUILD-IN-v1.4.25 | **W19d (new)** | Audit + add GLP-1-specific tags |
| 7 | Reminder + cadence visualisation (.ics + countdown ring) | DEFER-v1.4.26 | **W19e (new)** | Channel-agnostic, browser-Notification + APNs |
| 8 | Titration-ladder reference card (EMA passive display) | DEFER-v1.4.26 | **W19f (new)** | R2 from main research |
| 9 | Doctor-share TTL link (selectable sections, view counter) | DEFER-v1.4.26 | **W19g (new)** | Complements existing PDF report |
| 10 | Compliance-metrics chips (streak, weeks-on-track, total) | DEFER-v1.4.26 | **W19h (new)** | Feed Health Score; no badges |
| 11 | LLM migration paste-import via Coach | DEFER-v1.4.26 | **W19i (new)** | Optional; reduces tracker-switch friction |
| 12 | Onboarding 3-screen wizard | BUILD-IN-v1.4.25 | W14b (existing) | Already in plan; my-glp-shot validates the shape |
| 13 | Tap-to-override site recommendation on body diagram | BUILD-IN-v1.4.25 | W4d (polish) | If not already shipped |
| 14 | Colour-by-recency body-diagram | BUILD-IN-v1.4.25 | W4d (polish) | If not already shipped |
| 15 | Trial-cohort evidence band (Insights, not overlay) | DEFER-v1.5+ | new | Carefully framed, separate card |
| 16 | Weight-loss benchmark *overlay* on user chart | SKIP | — | Psychologically harmful; misleading comparison |
| 17 | Mixing / reconstitution calculator | SKIP | — | MDR brightest line; N2 |
| 18 | Autonomous dose escalation | SKIP | — | MDR; N1 |
| 19 | Weight-loss projection | SKIP | — | MDR; N4; my-glp-shot doesn't ship this either |
| 20 | Retatrutide tracking | SKIP | — | No EMA approval; N7 |
| 21 | Per-shot side-effect capture (instead of daily) | SKIP | — | Daily model is better |
| 22 | Gamified achievement badges (WebP art) | SKIP | — | Marc-voice directive; metrics without theatre |
| 23 | Browser-Notification-only reminders | SKIP | — | Channel-agnostic from v1.5 |
| 24 | Encryption-key-in-URL-fragment (E2EE share) | SKIP | — | Not needed for self-hosted |
| 25 | Vanilla-JS no-framework rebuild | SKIP | — | Architectural mismatch |

**Six new sub-waves proposed for the W19 series:**
- **W19d** Side-effect taxonomy expansion (audit + add GLP-1-specific tags)
- **W19e** Reminder + cadence visualisation (.ics export, countdown ring, channel-agnostic schema)
- **W19f** Titration-ladder reference card (EMA passive display)
- **W19g** Doctor-share TTL link (selectable sections, view counter, complements PDF)
- **W19h** Compliance metrics chips (streak, weeks-on-track, total-shots, no badges)
- **W19i** LLM migration paste-import via Coach (optional)

Three already-approved sub-waves are confirmed by this teardown:
- **W19a** Drug knowledge layer — extend with `brands` array + `route` enum + `inUseStabilityDays`
- **W19b** Pen / vial inventory — my-glp-shot validates schema; HealthLog adds in-use clock
- **W19c** Drug-level chart — my-glp-shot validates the qualitative-curve pattern; HealthLog ships better math (Bateman default, two-comp gated)

---

## Section 10 — Closed-source apps analysed (Tier 3)

Six apps. For each: catalog → one feature worth borrowing → one UX pattern → one thing HealthLog beats (or must not copy).

**Shotsy** ([shotsyapp.com](https://shotsyapp.com/)). iOS + Android, free with premium. Dose tracking, weekly reminders, zone-level injection-site rotation, side-effect logging, weight tracking, calories + protein + water tracking, **medication-level chart with peak-time visualization**, PDF export, Apple Health import, Apple Watch app. **Borrow:** the medication-level chart (§2). **UX pattern:** color-coded weight-loss trend lines by dose stage — subtle color shifts as the user steps 2.5 → 5 → 7.5 mg; visualizes dose-vs-outcome without causal claim. **HealthLog beats:** narrower scope — no nutrition tracking dilution.

**My GLP Shot** ([myglpshot.com](https://myglpshot.com/#features) — source repo [thejdubb02/my-glp-shot](https://github.com/thejdubb02/my-glp-shot), full teardown in §9.5). PWA on iOS / Android / desktop, free + premium tier. Dose logging, calendar-heatmap dose history, **active medication-level chart with half-life decay** (single-exponential only, §9.5), plateau alerts (28-day / <1 lb / no-dose-increase rule, §9.5), waist/hips + A1c tracking (premium), **mixing calculator** for compounded peptides ("how many units to draw"), AES-256-GCM E2E encryption. **Repo has no LICENSE file → all rights reserved → no porting.** **Borrow as pattern only:** calendar-heatmap dose history (GitHub year-grid style); plateau-detection rule (clinically sound, validate HealthLog W4d against it). **UX pattern:** plateau alerts as structured chip, not just Coach narrative. **HealthLog must not copy:** mixing calculator — dose-calculation, brightest MDR line.

**Glapp** ([glapp.io](https://glapp.io/)). iOS + web, free. Injection logging, weight tracking, side-effect log (nausea / constipation / diarrhea / fatigue with pattern recognition), reminders, **shot-phase tracking ("rise / peak / fade")**, drug-concentration visualization, dose-titration guidance, missed-dose guide, **vial/pen tracking with expiration alerts**, progress reports, clinical-trial comparison, **peer-outcome benchmarking**, **AI-powered Q&A**. **Borrow:** pen/vial expiration countdown — directly from EMA §6.3 (see R4). **UX pattern:** "shot phase" chip — one-word qualitative state more useful at a glance than a curve. **HealthLog beats:** peer-outcome benchmarking is HealthLog's anti-pattern (cross-user comparison); open-Q&A LLM risks hallucination, HealthLog's Coach is snapshot-grounded.

**Jabby** ([getjabby.com](https://getjabby.com/)). iOS only, free. Dose tracking, reminders, site rotation, side-effect log with severity rating, weight + Apple Health sync, **AI weight-loss forecasting**, BMI tracking, PDF reports. **Borrow:** severity slider on side-effect logging (§3.3, optional). **UX pattern:** Apple HealthKit sync (already on HealthLog's v1.5 iOS roadmap). **HealthLog beats / rejects:** AI weight-loss forecasting (§7).

**MyTherapy** ([mytherapyapp.com/glp1-apps](https://www.mytherapyapp.com/glp1-apps)). iOS + Android, free. Injection reminders with titration-schedule awareness, site-rotation diagram, weight journal, symptom log, doctor reports. Notable: explicitly no calorie counting — same scope discipline as HealthLog. **Borrow:** "dose-escalation reminder" framing (passive, "standard schedule allows escalation, discuss with clinician" — §4.3). **UX pattern:** the "we don't track food" stance is itself a feature. **HealthLog beats:** more current design language.

Mounjaro Simulator and InjectionLog covered in §9.2 and sibling research §1 respectively.

---

## Section 11 — Regulatory / safety (HWG + EMA + medical-device line)

### 11.1 EU MDR — when an app becomes a medical device

[MDCG 2021-24](https://health.ec.europa.eu/system/files/2021-10/mdcg_2021-24_en_0.pdf) sets the classification framework; intended purpose is decisive. Triggering verbs per [Voelker Gruppe](https://www.voelker-gruppe.com/kompetenzen/medizinrecht/beitraege/ce-marking-medical-apps): "to alarm, to analyze, to calculate, to detect, to diagnose, to interpret, to measure, to control, to surveil." Apps that modify data with diagnostic / therapeutic intent, perform decision-guiding functions, or calculate dose are medical devices and need CE marking.

HealthLog is a data-tracking and visualization tool; the Coach delivers educational narrative with explicit refusal of dose-recommendation requests. The features in this report split:

- **Display public regulatory data** — not medical device. Library function.
- **Drug-level estimate from public PK parameters** — borderline. "Estimate" framing, opt-in, no individual prediction, no dose suggestion off the curve. Mounjaro Simulator's "educational only" disclaimer is the convention.
- **Dose calculation, weight-loss projection, drug-drug interaction check** — all medical-device. Do not build.
- **Side-effect logging + severity charts** — not medical device.

### 11.2 Heilmittelwerbegesetz (HWG)

[HWG](https://www.gesetze-im-internet.de/heilmwerbg/HWG.pdf) regulates advertising for medicinal products. The app must not advertise a specific drug (§3a unauthorised indications, §3 misleading claims). Listing supported drugs is functional description, not advertising. Displaying EMA-authorised product information is permitted with clear attribution ("Source: EMA-authorized product information for [drug name]"). Promotional language ("most effective…") is off-limits; neutral description is fine.

### 11.3 Right user-facing framing

Every clinical surface (titration schedule, side-effect list, contraindications, storage) gets the same footer:

> "Source: EMA-authorized product information for [drug name], [section] (last reviewed: [EMA review date]). For your individual treatment, follow your clinician's instructions."

Attributes authority to EMA, allows user verification by clicking through, defers individual decisions, avoids "we recommend / you should."

### 11.4 GROUND RULE 9 — extension for v1.4.26

Current rule (PROMPT_VERSION 4.25.0) refuses dose recommendations. Additions for v1.4.26: **no projection** (future weight, future side-effect course, future dose timing); **no drug-level interpretation** (if snapshot includes estimates from §2, Coach must not reason from them); **no DDI inference** (warfarin + Mounjaro → only "discuss with your clinician"); **no tapering / discontinuation advice**. PROMPT_VERSION bumps to 4.26.0.

### 11.5 Data-residency

GLP-1 data is GDPR Art. 9 special category. HealthLog is self-hosted; clinical data never leaves the user's server. Positioning advantage vs Shotsy (Firebase / iCloud), Glapp (encrypted cloud), Jabby (iCloud). Verify the doctor-report PDF flow does not silently route through a third-party PDF service.

---

## Section 12 — Recommendations

### 12.1 v1.4.26 bucket — pull-in, low-risk, high-value

| # | Item | Effort / Risk |
|---|---|---|
| **R1** | Static EMA-derived drug reference TS module (§8.1) — tirzepatide / semaglutide injectable / semaglutide weight-mgmt / liraglutide. Foundation for every other surface; no prediction, no recommendation; EMA citations baked in. | M / low |
| **R2** | Display EMA titration schedule on the GLP-1 medication card, current step highlighted, footer cites EPAR section. "Discuss with your clinician" framing keeps it informational. | S / low |
| **R3** | Side-effect logbook with EMA-categorical vocabulary — extend MoodEntry tags with `glp1.*` namespace; 10–12 EMA "very common" + "common" entries; optional 3-level severity. | M / low |
| **R4** | Pen / vial inventory tile (`MedicationInventoryItem` with `dosesRemaining`, `dosesPerPen`, `firstUseAt`, `expiresOn`). Decrements per intake. 30-day in-use countdown per EMA §6.3. | M / medium (migration) |
| **R5** | Coach refusal extension (GROUND RULE 9 v2) — no projection, no drug-level interpretation, no DDI inference, no taper advice. PROMPT_VERSION 4.26.0. Must ship alongside any new clinical data in the snapshot. | S / medium |
| **R6** | Multi-prompt weekly-cadence reminders (window start + mid + end), per-medication toggle. | M / low |
| **R7** | "Shot phase" chip on the GLP-1 dashboard tile — qualitative state (rising / peak / fading), no number. Reads PK parameters from R1. | S / low |
| **R7b** | Cross-validate HealthLog W4d plateau detection against the my-glp-shot rule (4+ weight entries in last 28 d AND total change < 1 lb / 0.45 kg AND no dose increase during window; §9.5). Confirm HealthLog distinguishes plateau-on-stable-dose (actionable) from plateau-during-titration (not actionable). | S / low |

### 12.2 v1.5 bucket — defer

- **R8** Estimated drug-level research-view chart (full Bateman; §2). Requires `User.researchMode` flag, undismissable disclaimer, and R5 shipped first.
- **R9** Recency heatmap colouring on injection-site picker.
- **R10** "Do not use" exclude-zone toggle.
- **R11** Promote symptom tags to `SymptomLog` table if v1.4.26 demand surfaces severity-over-time charts.
- **R12** Calendar heatmap dose-history (myglpshot pattern).
- **R13** CSV import schema compatibility with Shotsy (ecosystem migration).
- **R14** Dulaglutide (Trulicity) data layer.
- **R15** Plateau-detection structured chip (algorithm already shipped W4d).
- **R16** Streak / consecutive-weeks tile element.

### 12.3 Never-build bucket — regulatory or safety risk too high

- **N1** Autonomous dose-escalation recommendation ("consider 7.5 mg next week"). MDR decision-support trigger.
- **N2** Mixing calculator for compounded peptides ("draw N units"). Dose calculation — brightest MDR line.
- **N3** Drug-drug interaction checker. Clinical decision support, MDR-regulated.
- **N4** Weight-loss projection. Prediction → MDR; psychologically harmful when missed.
- **N5** Peer-outcome benchmarking across users. Cross-account data sharing; HealthLog's anti-pattern.
- **N6** Open-Q&A LLM on GLP-1 content (Glapp pattern). Hallucination risk on clinical material; HealthLog's Coach is snapshot-grounded.
- **N7** Retatrutide tracking before EMA approval. Implies endorsement of unauthorised use.
- **N8** Photo upload (pre/post). Privacy hot zone per Marc directive.
- **N9** Insurance / pharmacy / coupon integration. Commercial entanglement; HWG.
- **N10** Telemedicine / prescribing pipeline. Out of scope.
- **N11** Import / port / vendor any code, schema, or curated dataset from `thejdubb02/my-glp-shot`. Repository has no LICENSE file (GitHub API `license: null`) → all rights reserved by default → not portable. Read for inspiration only (§9.5). Source HealthLog's reference layer from EMA EPARs and psp4.13099 (§2.6) — more authoritative and licence-clean.

### 12.4 The one regulatory line not to cross

**HealthLog displays and stores; it does not calculate, predict, or advise on dose.** The moment a feature crosses from "show the user EMA-authorized data + their own measured data" into "tell the user what dose to take, when to escalate, how their level will look next week, or what side-effect to expect at a specific time," HealthLog enters EU MDR Class I or higher and the entire architecture must change (notified body, technical documentation, post-market surveillance, CE mark). The line is sharp; the design discipline is to stay decisively on the safe side.

---

## Sources

**Tier 1 — clinical / regulatory.** EMA Mounjaro EPAR [EN](https://www.ema.europa.eu/en/documents/product-information/mounjaro-epar-product-information_en.pdf) / [DE](https://www.ema.europa.eu/de/documents/product-information/mounjaro-epar-product-information_de.pdf); [Ozempic EPAR](https://www.ema.europa.eu/en/documents/product-information/ozempic-epar-product-information_en.pdf); [Wegovy EPAR](https://www.ema.europa.eu/en/documents/product-information/wegovy-epar-product-information_en.pdf); [Saxenda EPAR](https://www.ema.europa.eu/en/documents/product-information/saxenda-epar-product-information_en.pdf); [Mounjaro EPAR landing](https://www.ema.europa.eu/en/medicines/human/EPAR/mounjaro); **Schneck K, Urva S. "Population pharmacokinetics of the GIP/GLP receptor agonist tirzepatide." *CPT Pharmacometrics Syst Pharmacol* 2024;13(3):494–503. [DOI 10.1002/psp4.13099](https://doi.org/10.1002/psp4.13099)** — open-access mirror [PMC10962491](https://pmc.ncbi.nlm.nih.gov/articles/PMC10962491/), [pubmed 38356317](https://pubmed.ncbi.nlm.nih.gov/38356317/); FDA Clinical Pharmacology Review [215866Orig1s000](https://www.accessdata.fda.gov/drugsatfda_docs/nda/2022/215866Orig1s000ClinPharmR.pdf) and [217806Orig1s000](https://www.accessdata.fda.gov/drugsatfda_docs/nda/2024/217806Orig1s000ClinPharmR.pdf).

**Tier 2 — open-source tools.** [monkeydriven/mounjaro_calc](https://github.com/monkeydriven/mounjaro_calc); [Mounjaro Blood Level Simulator](https://mounjaro-simulator.github.io/); [peytoncchen/PK-Visualization](https://github.com/peytoncchen/PK-Visualization); [thejdubb02/my-glp-shot](https://github.com/thejdubb02/my-glp-shot) — *no LICENSE; read-only inspiration, §9.5*.

**Tier 3 — closed-source apps.** [Shotsy](https://shotsyapp.com/), [My GLP Shot](https://myglpshot.com/#features), [Glapp](https://glapp.io/), [Jabby](https://getjabby.com/), [MyTherapy GLP-1](https://www.mytherapyapp.com/glp1-apps), [Shotwise](https://shotwise.app/faq), [InjectionLog](https://injectionlog.com/).

**Regulatory background.** [MDCG 2021-24](https://health.ec.europa.eu/system/files/2021-10/mdcg_2021-24_en_0.pdf); [Voelker Gruppe — CE marking for medical apps](https://www.voelker-gruppe.com/kompetenzen/medizinrecht/beitraege/ce-marking-medical-apps); [BfArM Medizinprodukte FAQ](https://www.bfarm.de/DE/Medizinprodukte/_FAQ/Klassifizierung-Abgrenzung/faq-liste.html); [HWG](https://www.gesetze-im-internet.de/heilmwerbg/HWG.pdf); [BMG Marktzugang Medizinprodukte](https://www.bundesgesundheitsministerium.de/themen/gesundheitswesen/medizinprodukte/marktzugangsvoraussetzungen).

**Internal.** Prior research: [`glp1-injection-tracking.md`](./glp1-injection-tracking.md) — foundational landscape. v1.4.25 W4d delivery: see `.planning/phase-W4d-tests-v1425-glp1-component-tests-report.md`.
