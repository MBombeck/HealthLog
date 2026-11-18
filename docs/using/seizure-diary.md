# Seizure diary

The seizure diary (module `seizures`, off by default) records seizures for a
person with epilepsy, typically logged by a parent or carer. The full guide
with sources lives on the documentation site under "Keep a seizure diary";
this page is the in-repo summary for contributors.

## Data

- `SeizureTypeProfile`: the family's name for a type (encrypted), the ILAE
  2025 type (`SeizureIlaeType`; the class is derived, the 2017 name is a
  label), usual duration, the plan text (encrypted) and an as-needed rescue
  medication with dose and route. Archived types keep their events.
- `SeizureEvent`: onset and its precision, duration and its source (null when
  nobody timed it, never zero), `count` for tallies, certainty, sleep state,
  responsiveness and recall, semiology, triggers, post-ictal state, injuries,
  emergency care, witness, who logged it (`loggedByUserId`, deliberately not
  a foreign key) and four encrypted free-text fields.
- `SeizureRescueDose`: each dose, with the intake it wrote on the medication.
- `SeizureDiarySettings`: the record's cluster rule (default 2 in 24 hours).

Mapping tables (ILAE, SNOMED CT, LOINC answers, Trinka's t1) are in
`src/lib/seizures/ilae.ts`. Clusters, seizure-free runs, monthly tables,
duration flags, the timer threshold and the LOINC summaries are derived at
read time in `src/lib/seizures/derive.ts`; nothing derived is stored.

## Rules worth keeping

- Recording a seizure or a rescue dose is a delegated WRITE in the `illness`
  share section; editing, deleting, types and the rule are MANAGE.
- A rescue dose that names a medication writes an intake through
  `recordIntake`; the medication must be as-needed and tracked, so no
  compliance figure moves. Deleting the dose or the seizure undoes the intake.
- The doctor report's overlays read their source only when that source's own
  leaf is in the report (`SeizureOverlayAdmission`).
- Copy never diagnoses, never scores a risk and never says it is safe to wait.
  The threshold panel appears only after the threshold; the emergency
  guidance is always visible.
- The ketogenic diet ratio is not drawn on the report chart: blood ketones
  (#1367) store no prescribed ratio to mark.
- A cluster needs at least two entries in the window. A tally row (a
  `count` above 1, say five absences logged at once) is one entry: its
  seizures count in every total and in the report, but it is no cluster by
  itself and sends no cluster notification; it joins a cluster once another
  entry shares its window, weighted by its count.
- `SEIZURE_CLUSTER` is off by default and fires once per cluster, on the
  write that forms it, only when someone other than the person logged it and
  only when the seizure is not back-filled (`src/lib/seizures/cluster-notify.ts`).
  On a managed profile it fans out to the guardians.
- The timeline's `seizures` lane draws one point per day, owned by the
  `seizures` module and shared under `illness`.
