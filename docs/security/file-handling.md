# File handling

Every place HealthLog accepts a file: what it takes, how it tells what the
file is, how large it may be, how far an archive may expand, where the file
goes and how it comes back out. Rate limits for these routes are in
[limits](limits.md).

## Common rules

- **Content decides the type, not the name or the header.** Files are
  classified by their leading bytes. The `Content-Type` a client sends is
  ignored; an extension is consulted only to tell apart formats that share a
  container (a ZIP that is a `.docx`, a CFB file that is a `.doc`) and for
  plain text.
- **Sizes are checked while reading.** A declared `Content-Length` over the
  cap is refused at once, and the stream is counted as it arrives, so a client
  that lies is cut off at the cap (413).
- **No user-supplied path.** Temporary files are named from a random UUID in
  the system temp directory (`src/lib/multipart/stream-to-disk.ts`); archive
  members are streamed, never extracted to a path from the archive.
- **Nothing is written to a served folder.** Stored files live in the
  database, encrypted.
- **No antivirus scan.** See [Residual risk](#residual-risk).

## Uploads

| Feature                                                                 | Accepted                                                                                                                                                                                                                                      | Max size                                                               | Expansion limits                                                                                                                                                                       | Kept                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Document vault (`POST /api/documents/inbound`, document sources import) | Class A: PDF, JPEG, PNG, WebP, GIF. Class B: `.docx`, `.xlsx`, `.pptx`, `.doc`, `.xls`, `.ppt`, RTF, TIFF, HEIC, `.txt`, `.md`, `.csv`, `.xml`, `.json` (text must have no NUL byte in its first 8 KiB). Everything else is refused with 415. | 25 MiB by default, an admin can raise it to 100 MiB; 1 GiB per account | A ZIP is taken only as an Office document; generic archives are refused                                                                                                                | `InboundDocument.contentEncrypted`, AES-256-GCM, written in the same transaction as the quota check |
| Avatar (`POST /api/user/avatar`)                                        | JPEG, PNG, WebP; at most 2048 × 2048, read from the header without decoding                                                                                                                                                                   | 2 MiB                                                                  | n/a                                                                                                                                                                                    | `User.avatarBytes`, not encrypted                                                                   |
| Lab report scan (`POST /api/labs/ocr/extract`)                          | PDF, JPEG, PNG, WebP                                                                                                                                                                                                                          | 12 MiB                                                                 | n/a                                                                                                                                                                                    | not stored; held in memory for the read, then dropped                                               |
| Supplement label (`/api/medications/[id]/ingredients/extract`)          | as lab scan                                                                                                                                                                                                                                   | 10 MiB                                                                 | n/a                                                                                                                                                                                    | not stored                                                                                          |
| Apple Health export                                                     | ZIP with `export.xml`; encrypted members and methods other than stored and deflate refused; unsafe member names refused; XML read by a streaming parser in strict mode                                                                        | 1.5 GiB                                                                | `export.xml` at most 8 GiB and 200 × its compressed size; at most 200,000 entries and a 64 MiB central directory; ECG, route and clinical members each capped in count, size and total | temporary file, deleted after the import                                                            |
| Health Connect export (upload or WebDAV folder)                         | ZIP holding the Health Connect SQLite database; opened read-only, immutable, untrusted schema, views refused, schema version checked                                                                                                          | 1 GiB                                                                  | database at most 4 GiB and 200 × compressed                                                                                                                                            | temporary file                                                                                      |
| Gadgetbridge                                                            | SQLite database, opened as above                                                                                                                                                                                                              | 512 MiB                                                                | n/a                                                                                                                                                                                    | temporary file                                                                                      |
| FHIR bundle                                                             | JSON whose `resourceType` is `Bundle`                                                                                                                                                                                                         | 32 MiB                                                                 | at most 50,000 entries                                                                                                                                                                 | temporary file                                                                                      |
| FIT activity file                                                       | FIT by its signature, or one FIT inside a gzip or a ZIP of at most 16 entries; one wrapping layer                                                                                                                                             | 10 MiB                                                                 | 8 MiB decompressed                                                                                                                                                                     | temporary file                                                                                      |
| CSV and JSON imports (measurements, labs, medications, dose history)    | `text/csv` or `text/plain`, or JSON; parsed strictly                                                                                                                                                                                          | 16 MiB                                                                 | row caps (10,000; labs 20,000; medications 500; dose history 30,000)                                                                                                                   | not stored; rows are written                                                                        |
| Account copy upload (admin, `POST /api/admin/backups/upload`)           | HealthLog backup JSON, raw or gzip (by signature); schema-checked while streaming, a newer schema version refused                                                                                                                             | 10 MiB as a form upload, 512 MiB raw                                   | gzip at most 100 × the bytes read so far, never less than 256 MiB nor more than 4 GiB                                                                                                  | encrypted as it arrives into a stored copy; restoring is a separate, fresh-proof action             |

Staged imports (the Apple Health, Health Connect, Gadgetbridge, FHIR and FIT
rows) do not check the type at upload: the file is streamed to a temporary
file with its SHA-256, and the worker's parser accepts or refuses it. The
temporary file is removed on every path except a queued job, whose worker
removes it when it finishes. With a web/worker split the staging directory
must be a shared volume ([`self-hosting/scaling.md`](../self-hosting/scaling.md#apple-health-import-staging-shared-volume-required-for-a-split)).

## Refused outright

In the document vault: executables by signature (PE, ELF, Mach-O), and the
extensions `exe`, `dll`, `bat`, `cmd`, `sh`, `ps1`, `js`, `mjs`, `jar`, `apk`,
`html`, `htm`, `xhtml`, `svg`, `zip`, `7z`, `rar`, `tar`, `gz`, `iso`, `img`,
`dmg`, whatever their content (`src/lib/documents/upload-policy.ts`). A file
the classifier cannot identify is refused, not stored as unknown.

## Serving files back

| Route                                                      | How                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document original (`/api/documents/inbound/[id]/original`) | Class A with its true type and `inline`; Class B as `application/octet-stream` and `attachment`. Always `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, and a CSP of `default-src 'none'`. The file name is cleaned (control characters, quotes and slashes removed, 120 characters) and sent with an RFC 5987 `filename*`. A file that fails to decrypt is a 500, never ciphertext. |
| Document through a share link (`/c/<token>/d/[id]`)        | The same, and EXIF, XMP and GPS data are removed from JPEG, PNG and WebP on the way out                                                                                                                                                                                                                                                                                                                     |
| Thumbnail                                                  | Always a server-rendered JPEG (a PDF is rendered from at most 10 pages, 20 megapixels each), `inline`, `nosniff`, `no-store`                                                                                                                                                                                                                                                                                |
| Avatar (`/api/user/avatar/[id]`)                           | The detected image type, `nosniff`, private cache                                                                                                                                                                                                                                                                                                                                                           |
| Exports and admin backup downloads                         | `attachment`, server-generated file names                                                                                                                                                                                                                                                                                                                                                                   |

No uploaded file is ever served as HTML or script: the only inline types are
PDF and raster images, under a CSP that allows nothing to load.

## Residual risk

There is no virus scanner. A document holding malware (a macro in an Office
file, an exploit in a PDF or image) is stored and handed back as it came in.
What limits the harm: executables and active formats are refused, every
non-passive type is served only as a download, inline types render under
`default-src 'none'` with `nosniff`, nothing is executed or opened on the
server except by the parsers named above (PDF text and rendering, OCR, the
import parsers), and a document reaches other people only through a share link
or a grant the owner made. A file is as safe to open as the device and the
application that opens it; operators who accept documents from people they do
not trust should scan the downloads on the receiving device.
