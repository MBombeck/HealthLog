# Importing documents from Paperless-ngx or Papra

HealthLog's document vault can take documents from another document system
without you uploading them one by one. There are two ways in, and both use
the same kind of credential: a **document token**.

- **Paperless-ngx** can send each newly tagged document to HealthLog by
  itself, through a workflow. Good for new documents as they arrive.
- The **import script** copies documents from Paperless-ngx or Papra in one
  go. Good for the archive you already have, and, run on a schedule, for
  keeping Papra in step.

HealthLog never holds a password or token for Paperless-ngx or Papra. They
push into HealthLog; HealthLog does not reach into them.

## 1. Turn on Documents and create a document token

1. In HealthLog, turn on **Documents** under **Settings → Modules** if you
   have not already. Uploads are refused while the vault is off.
2. Open **Settings → API & Tokens → Document tokens**, give the token a name (for
   example "Paperless workflow"), and select **Create**.
3. Copy the token (it starts with `hlk_`). It is shown once.

A document token can add documents to your own vault and do nothing else. It
cannot list, open, download, change or delete a document, cannot use the AI
features, and cannot create another token. When it uploads a file it gets
back only whether the file was stored, not the title or anything else about
your vault. You can revoke it at any time under **Settings → API & Tokens →
API Tokens**. It expires after a year unless you revoke it sooner.

## 2. New documents from Paperless-ngx (workflow)

This needs Paperless-ngx 3.0 or later, the first release with the
`{{doc_id}}` placeholder. In Paperless-ngx, open **Workflows** and add one:

- **Triggers:** add _Document Added_ and _Document Updated_. On each, set
  the filter to "has any of these tags" and pick the tag you use for health
  documents, for example `HealthLog`.
- **Action:** _Webhook_.
  - **Webhook url:** `https://<your HealthLog address>/api/documents/inbound`.
    Use the address HealthLog is served at: Paperless does not follow
    redirects.
  - **Use parameters for webhook body:** on. **Send webhook payload as
    JSON:** off. **Webhook params:**

    | Name           | Value                                                |
    | -------------- | ---------------------------------------------------- |
    | `title`        | `{{doc_title}}`                                      |
    | `documentDate` | `{{created_year}}-{{created_month}}-{{created_day}}` |
    | `sourceSystem` | `PAPERLESS`                                          |
    | `sourceId`     | `{{doc_id}}`                                         |

  - **Include document:** on. Paperless then sends the original file along
    with the parameters, which is exactly what HealthLog expects.
  - **Webhook headers:** `Authorization` = `Bearer hlk_…` (your document
    token).

Optionally add a parameter `kind` with one of `DOCTOR_REPORT`,
`DISCHARGE_LETTER`, `LAB_RESULT`, `IMAGING`, `PRESCRIPTION`, `REFERRAL`,
`INSURANCE`, `VACCINATION` or `OTHER` if the workflow only ever sends one
kind of document. Without it, documents are filed as _Other_ and you can
change the type in HealthLog.

Tagging a document again, or editing it in Paperless, fires the workflow
again. HealthLog recognises the Paperless document id and answers "already
stored", so no second copy is made, and if you delete the document in
HealthLog, a later re-send does not bring it back. Each re-send still carries
the whole file, so it counts towards the token's hourly upload limit (see
For operators below).

**What the workflow is not for.** Paperless gives up on a webhook after
three quick retries and does not retry at all when a request takes longer
than five seconds. If you tag hundreds of documents at once, most of those
webhooks arrive while HealthLog is still asking them to slow down, and
Paperless drops them. Use the import script below for the existing archive
and let the workflow handle what comes after.

## 3. The archive: the import script

The script is a single file, `scripts/import-documents.mjs` in the
HealthLog repository. It works with Paperless-ngx 2.16 or later (API
version 9) and current Papra releases. It needs Node 22 and nothing else, and it runs on any
machine that can reach both systems. Download it:

```sh
curl -O https://raw.githubusercontent.com/MBombeck/HealthLog/main/scripts/import-documents.mjs
```

Tokens go in environment variables, never on the command line:

```sh
export HEALTHLOG_TOKEN=hlk_…          # the document token
export PAPERLESS_TOKEN=…              # Paperless: My Profile → API auth token
export PAPRA_TOKEN=…                  # Papra: an API key with documents:read and tags:read
```

**Paperless-ngx:**

```sh
node import-documents.mjs paperless \
  --paperless-url https://paperless.example \
  --healthlog-url https://health.example \
  --tag HealthLog
```

**Papra** (the organization id is in the Papra address bar,
`/organizations/<id>/…`):

```sh
node import-documents.mjs papra \
  --papra-url https://papra.example \
  --papra-org <organization id> \
  --healthlog-url https://health.example \
  --tag Health
```

No Node on the machine? Run it in a throwaway container:

```sh
docker run --rm -it -v "$PWD:/w" -w /w \
  -e HEALTHLOG_TOKEN -e PAPERLESS_TOKEN \
  node:22-alpine node import-documents.mjs paperless …
```

Options:

- `--tag <name>` copies only documents with that tag. Recommended; without
  it the script copies everything the source token can see.
- `--since YYYY-MM-DD` copies only documents dated on or after that day.
- `--kind LAB_RESULT` files everything as one type. `--kind-map
"Befund=DOCTOR_REPORT,Labor=LAB_RESULT"` picks the type by Paperless
  document type or by Papra tag; anything unmatched gets `--kind`, or
  _Other_.
- `--dry-run` lists what would be copied, with sizes and a total, and sends
  nothing. Worth running first. It only talks to the source, so it needs no
  HealthLog token and also lists documents HealthLog already has.
- `--ai-read` lets HealthLog read the documents with AI as they arrive (see
  below). Off by default.

What it does:

- It copies one document at a time and keeps only one file in memory.
- It sends the original file (for Paperless, the original rather than the
  archived PDF), the title, the document date, and the source id.
- The document date is the date the source has for the document. When the
  source has none, the script uses the day the document was added there, and
  lists those documents in its summary so you can correct the date.
- Running it again is safe. Before downloading a document the script asks
  HealthLog whether it already has it, so documents already there are
  neither downloaded nor sent again, and a re-run over a large archive is
  quick. Documents you deleted in HealthLog stay deleted, also after they
  are removed for good. The same goes for a file you had already uploaded
  by hand: the import recognises it by its content (sending it once to
  compare), and if you delete it later, the import leaves it deleted. An
  interrupted run simply picks up where it stopped.
- When HealthLog asks it to slow down, it waits as long as HealthLog says
  and carries on. By default a document token may send 120 uploads an hour,
  so an archive of a thousand documents takes a night. Every upload that
  sends a file counts, including one HealthLog answers as already stored.
  Documents the script recognises by asking first are not uploaded and do
  not count; those questions draw on a separate allowance of 5,000 an hour
  per token. When that allowance is spent, the script waits for it like it
  waits for the upload limit. Uploads you make yourself in the web app or on
  your phone are counted separately and are not held up.
- At the end it prints how many documents were imported, how many were
  already there, how many you had deleted, and every document it skipped
  with the reason. It exits with `0` when everything went through, `3` when
  some documents were skipped, `1` when it had to stop (for example a
  refused token, the vault switched off, or storage full), and `2` for a
  mistake in the command.

### AI reading of imported documents

If you have turned on automatic AI reading of documents, HealthLog normally
reads each new document with your AI provider as it arrives. For an import
the script holds that back, so a whole archive does not turn into a
thousand AI requests at once. Imported documents still get a preview and
are searchable by their text where the file has a text layer.

HealthLog remembers that these documents were held back: turning on
automatic AI reading later does not send them to your AI provider either.
To have a document read, open it and choose **Read with AI** or **Generate
summary**; either ends the hold for that document. **Index all for search**
leaves held-back documents alone, so a scan without a text layer stays
unsearchable until you read it this way. Pass `--ai-read` if you do want
every imported document read as it arrives.

The Paperless workflow does not hold AI reading back unless you add the
parameter `aiRead` with the value `defer`: otherwise new documents are
treated like any other upload.

### Keeping Papra in step

Papra's webhooks only say that something changed, not what the file is, and
cannot carry a token, so Papra cannot post into HealthLog directly. Run the
script on a schedule instead, for example nightly with cron:

```cron
15 3 * * * cd /opt/healthlog-import && HEALTHLOG_TOKEN=hlk_… PAPRA_TOKEN=… node import-documents.mjs papra --papra-url https://papra.example --papra-org <id> --healthlog-url https://health.example --tag Health --since 2026-01-01 >> import.log 2>&1
```

Documents already copied are recognised and skipped, so a nightly run only
adds what is new. `--since` keeps each run short.

## Storage

HealthLog keeps its own encrypted copy of each document, so an imported
archive takes space in both systems. The preview, text search, lab import,
the doctor report and sharing all need the file itself, which is why
HealthLog does not link to documents stored elsewhere.

The default storage limit is 1 GB per person, counting deleted documents
until they are removed for good 30 days later. Run the script with
`--dry-run` to see how much an import needs. An admin can raise the limit in
the admin area, for everyone or for one account. If storage runs out during
an import, the script stops and says so; raise the limit and run it again.

## Source ids

Documents are recognised by the pair of source system and document id:
`PAPERLESS` plus the Paperless document id, `PAPRA` plus the Papra document
id. Anything else is sent as `OTHER`, and `OTHER` is one shared set of ids
per account: if you push documents from two other systems, make sure their
ids cannot collide, for example by prefixing them (`nextcloud-123`,
`scanner-123`).

The same file sent under a different id is stored once, and HealthLog
remembers the extra id for it, up to 20 extra ids per document. A 21st is
refused with `409` (`documents.inbound.sourceAliasLimit`) and nothing is
stored or remembered; the script lists such a document as skipped.

## For operators

`DOCUMENT_UPLOAD_LIMIT_PER_HOUR` sets how many uploads one document token
may send per hour (default `120`, clamped to 1–1000). Every upload that
sends a file counts, duplicates included. It applies to
document tokens only; uploads from the web app and the phone keep their own
limit of 60 per hour per person. Raise it to let a large import finish
faster; the storage limit still applies. The variable is on the
`docker-compose.yml` whitelist, so setting it in `.env` is enough.
