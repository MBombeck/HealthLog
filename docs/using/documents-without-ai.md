# Reading documents without AI

A document in the vault is read on your own server, with no AI provider and
nothing sent anywhere. That covers making it searchable and reading the
values of a lab report into the review.

## What the server reads by itself

- **A PDF with a text layer**, which is what most labs and practices send,
  is read from that layer in milliseconds.
- **A scanned PDF or a photo** (JPEG, PNG, WebP) is read by text recognition
  (OCR) on the server. The pages are rendered and each page is read by
  Tesseract, the same engine the lab scan uses in the browser, here running
  inside the server's document reader. The first 10 pages are read. A page
  takes a second or two on a current desktop processor and up to about
  a minute on a Raspberry Pi 4. It happens in the background after the
  upload, so the document is filed straight away and becomes searchable a
  little later.

The image carries language data for every app language. A scan is read in
German and English, which lab reports often mix, and in the language your
account is set to when that is another one: a Russian or Korean scan is read
when the account uses Russian or Korean. A PDF with a text layer is read in
every language.

When a scan cannot be read, the document says why under its preview: no
text was found, or the text recognition did not finish (it took too long,
needed too much memory, or failed). Admin > System status has a "Text
recognition for scans" line in the setup check. It says which languages
this server reads and how many scans it could not read in the last seven
days, which is usually the first sign of a machine that is too slow or
short of memory.

## Lab values for review

A document filed as a lab result, or one whose text reads like a lab report,
has its values read into the review after it is indexed. Without AI they
are read by rule: one value per table row, as labs print them:

```
Natrium        141     mmol/l     135 - 145
Kreatinin      1,08 H  mg/dl      0,70 - 1,20
TSH            2,31    0,27-4,20  mU/l
```

The name, the value (a number, a bound such as `< 0,5`, or a word such as
`negativ`), the unit and the printed range are kept as printed. A flag the
lab printed (H, L, +, arrows) is left out and never turned into "high" or
"low", no code is added, and no unit is converted. A row counts when its
name is a marker HealthLog knows in any of its languages, or when it has a
recognised unit and a range. Rows the reader is unsure about arrive marked
for checking: a unit repaired from a typical OCR misreading (`Tsd/pl` read
for `Tsd/µl`), a number like `1.080` in a report that does not show which
decimal mark it uses, or a value without a unit.

Nothing is saved until you confirm it on the review, the same review an AI
read fills.

With AI turned on and allowed to read documents, the AI reads the values
instead, from the same text. When it may not (switched off, "local only",
no provider, the day's budget used up) or the read fails, the values are
read by rule. On a stored lab result with nothing staged, **Read values
without AI** runs the same read by hand; it is there whatever the AI
settings say. The API route is `POST /api/documents/inbound/{id}/lab-values`.

An import held back from reading (`aiRead=defer`) is indexed, including by
OCR, but its values are only read when you ask for it.

## What it does not do

Of two lab tables printed side by side, only the left one is read, and on
a PDF text layer, which keeps no column gaps, its range can pick up text
from the right one; those rows need a careful look. Values printed below
their names, on a line of their own, are not read. Handwriting is not read.
Larger OCR models such as PaddleOCR or MinerU, which need Python and a much
larger image, are not part of the image.
