# Patient record import (FHIR Bundle)

Many patient portals let you download your record as a **FHIR R4 Bundle**,
one JSON file. HealthLog reads that file and puts each part where it
belongs: lab results into Labs, vital signs into the measurement timeline,
conditions, vaccinations, medications and visits into their own sections.

## 1. Export from the portal

Look for an export or download option that names **FHIR**, **FHIR R4** or
**JSON**. The result is a file whose top level reads
`"resourceType": "Bundle"`. A C-CDA or CCD document (XML) is a different
format and is not read; see the plan at the end of this page.

## 2. Upload to HealthLog

Open **Settings → Export & Import** and choose the file on the **Patient
record (FHIR)** card. The endpoint is `POST /api/import/fhir-bundle`
(`multipart/form-data`, field `file`):

- at most **32 MB** and **50 000 entries**;
- five uploads a minute per account, one import per account at a time;
- the same bytes again return the earlier job.

`GET /api/import/fhir-bundle/status` answers the latest job.

## 3. What becomes what

| FHIR resource                         | HealthLog                                                                                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Observation`, category `laboratory`  | A lab result, through the same mapping as Apple Health's Health Records: marker matching by LOINC and name, unit normalisation, panel names, reference ranges. Preliminary, cancelled and entered-in-error results are skipped.   |
| `Observation`, category `vital-signs` | A measurement: weight, heart rate, resting heart rate, oxygen saturation, respiratory rate, body temperature, BMI, body fat, blood pressure (the panel or its two codes). A unit HealthLog does not list is refused, not guessed. |
| `Condition`                           | An illness entry with its onset and, when stated, its end. Refuted and entered-in-error conditions are skipped.                                                                                                                   |
| `Immunization`                        | A vaccination, as the portal names the vaccine, with lot and dose number. Only completed doses.                                                                                                                                   |
| `MedicationStatement`                 | A medication, active or ended per its status and period. No schedule and no reminders: an import says what was taken, it does not start reminding anybody.                                                                        |
| `Encounter`                           | A visit, with its date, status and kind (emergency, hospital, procedure, preventive or other) and its reason, encrypted like every visit reason.                                                                                  |

Everything else (`Patient`, `Practitioner`, `DiagnosticReport`,
`Procedure`, …) is counted under **Not imported** by type.

## 4. Running it again

Every resource is matched by the server it came from (the base of the
entry's `fullUrl`) and its own `id`. Importing the same Bundle again, or a
newer export from the same portal, writes nothing twice. A record you
deleted in HealthLog is not brought back by a later import.

## 5. Limits and safety

- The file is parsed as untrusted JSON; every field is checked before it is
  used, and free text is cut to a bounded length.
- A run has a ten-minute budget; a run that reaches it keeps what it wrote
  and fails with "time limit", and uploading the same file again continues.
- The file is deleted when the job ends. The result lists counts and closed
  reasons only; the audit log records the upload's size and hash.

## C-CDA: not read, and the plan

C-CDA is an XML document format with a large template library; a reader
that does it justice is a project of its own rather than a mapping table.
The plan, when it is built: parse with the streaming XML reader the Apple
Health import already uses, map the Results, Vital Signs, Problems,
Immunizations, Medications and Encounters sections by their template ids
onto the same writers this page describes, and key each entry on its
`id/@root` and `id/@extension` the way this import keys on FHIR ids. Until
then, a portal that offers both formats should be exported as FHIR.
