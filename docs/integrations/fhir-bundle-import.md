# Patient record import (FHIR Bundle)

Many patient portals let you download your record as a **FHIR R4 Bundle**,
one JSON file. HealthLog reads that file and puts each part where it
belongs: lab results into Labs, vital signs into the measurement timeline,
conditions, vaccinations, medications and visits into their own sections.

## 1. Export from the portal

Look for an export or download option that names **FHIR**, **FHIR R4** or
**JSON**. The result is a file whose top level reads
`"resourceType": "Bundle"`. A C-CDA or CCD document (XML) is a different
format and is not read; see the end of this page.

## 2. Upload to HealthLog

Open **Settings > Export & import** and choose the file on the **Patient
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
`Procedure` and so on) is counted under **Not imported** by type.

A time that the export writes without a zone offset is read on the clock of
the time zone set in your HealthLog profile.

## 4. Running it again

Every resource is matched by the server it came from (the base of the
entry's `fullUrl`) and its own `id`. An entry named by `urn:uuid:` or
`urn:oid:` names no server; its `id` is unique on its own and is matched
alone. Importing the same Bundle again, or a newer export from the same
portal, writes nothing twice. In 1.49.0 a `urn:uuid:` entry was matched by
the Bundle's own `id`; a record imported that way is still recognised in
its next export and adopted under the new match. A record you
deleted in HealthLog is not brought back by a later import.

The list of what was already imported travels in both kinds of backup
(the portable export and the disaster-recovery copy), so importing the same
Bundle again after a restore, on this server or a new one, also adds
nothing.

## 5. Limits and safety

- The file is parsed as untrusted JSON; every field is checked before it is
  used, and free text is cut to a bounded length.
- A run has a ten-minute budget; a run that reaches it keeps what it wrote
  and fails with "time limit", and uploading the same file again continues.
- The file is deleted when the job ends. The result lists counts and closed
  reasons only; the audit log records the upload's size and hash.

## C-CDA is not read

A C-CDA or CCD document (XML) is not read. A portal that offers both
formats should be exported as FHIR.
