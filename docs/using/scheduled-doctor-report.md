# Scheduled doctor report

Under **Settings**, **Health record**, the **Scheduled doctor report** card
(also linked from the top of **Documents**, where the reports land)
files the doctor report into your documents on its own, once a month,
quarter or year has ended. It is off until you turn it on, and it sends no
notification: the PDF is simply there, in the documents and in anything
that reads them.

- **How often**: every month, every quarter or every year. The period is
  the calendar month, quarter or year on your own clock, in the timezone of
  your profile.
- **What each report covers**: the period that ended, or the last 90 days or
  the last 12 months up to its end.
- **What it contains**: what you selected for the export on the same page.
  Change the selection there and the next report follows it. With nothing
  selected, nothing is filed and the card says so.

Within the hour after a period ends, the report for it is rendered and
stored as a document of the kind _Doctor report_, dated the last day of the
period and titled with the period (`Doctor report 2026-10`). Turning the
schedule on files the period that ended most recently on the next run.

## Once and only once

Each report carries the key `REPORT_SCHEDULE` / `<cadence>:<period>`, for
example `MONTHLY:2026-10`. A run that finds the key files nothing, so a
retry or a restored backup never files a period twice. If you delete a
report, the key is remembered and that period is not filed again.

## When a report is not filed

- The doctor report or the documents module is off: nothing runs, and the
  period is filed once both are on again.
- The report does not fit the document size limit or your storage quota:
  the card says so, and the next period tries again.
- Something else fails: the card says so, and the next hourly run tries
  again.
- An account waiting for deletion is never read.

Automatic AI reading of the document is held back: the report is HealthLog's
own text. You can still ask for a summary from the document itself.

## For scripts

`GET`, `PUT` and `DELETE /api/settings/report-schedule` read, set
(`{ "cadence": "MONTHLY", "window": "PERIOD" }`) and remove the schedule of
your own record. The `GET` answer names the last period settled, how it
ended, and the period the next run files. A filed report lists in
`GET /api/documents/inbound` with `sourceSystem: "REPORT_SCHEDULE"`.
