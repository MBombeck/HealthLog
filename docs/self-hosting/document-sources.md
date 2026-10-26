# Document picker — Paperless-ngx and Papra

People who keep their paperwork in Paperless-ngx or Papra can search it from
HealthLog and import the documents they pick: under "Link a document" on a
visit, a vaccination or a condition, and from the Documents page. They search
by document name, narrow by tag and date, tick what they want, and HealthLog
fetches those files and stores its own encrypted copy, exactly as if they had
been uploaded.

The picker is off until the operator names the instances HealthLog may
contact.

## Turning it on

List the origins in the server environment:

```env
DOCUMENT_SOURCE_ORIGINS="https://paperless.example.com,http://papra.lan:1221"
```

The variable is on the `docker-compose.yml` whitelist, so setting it in `.env`
is enough; restart the app container afterwards. Unset or empty, the settings
card and every import button stay hidden and the routes answer 404.

Each entry is one `scheme://host[:port]`, the grammar
`NOTIFICATION_PRIVATE_ORIGINS` uses (see [notifications](notifications.md)):

- only `http` and `https`; scheme, host and port must match what a person
  enters (`https://paperless.example.com:8443` and
  `https://paperless.example.com` are two different entries);
- no path, query, credentials, wildcard or CIDR; a person may still enter a
  base address with a path (`https://example.com/paperless`) as long as its
  origin is listed;
- the unspecified address, link-local and the cloud-metadata range can never
  be listed, and a listed name that resolves there is refused when HealthLog
  connects;
- a malformed entry is logged once at startup, reduced to scheme and host, and
  grants nothing; the valid entries beside it keep working.

Unlike the notification list, this list is the whole decision: an origin
that is not listed is refused even when it is a public address. Removing an
entry cuts off the connections that point at it on their next request; people
can still delete their stored connection.

## What each person sets up

Settings → Integrations → Document archives:

- **Paperless-ngx:** the base address and an API token (Paperless-ngx: My
  Profile → API token). Paperless-ngx 2.16 or later (API version 9).
- **Papra:** the base address, the organization id (from the Papra address
  bar, `org_` followed by 24 letters and digits) and an API key with
  `documents:read` and `tags:read`. The connection test reads the tags too,
  so a key without `tags:read` is refused at save.

HealthLog tests the connection before saving it. A saved token is only ever
sent to the address it was saved for: changing the address to another origin
asks for the token again. The token is stored
encrypted (AES-256-GCM, rotated with the other keys by
`scripts/rotate-encryption-key.ts`) and is never shown again, not even in
part.

## What leaves the server, and when

Only requests the person starts: a search, the tag list for the filter, a
connection test, and one download per picked document. There is no background
sync and no polling. Every request goes to the listed origin only, with
redirects refused, a 10-second limit for searches and 60 seconds for a file,
and a size cap on every answer (1 MiB for a search page, the vault's per-file
limit for a document).

## Limits and rules

- Name search on Paperless-ngx uses its own title filter. On a Paperless-ngx
  that stores its data in SQLite, that filter ignores upper and lower case
  only for plain ASCII letters: searching `röntgen` does not find `Röntgen`.
  That is Paperless-ngx's behaviour, not HealthLog's; PostgreSQL-backed
  Paperless does not have it.
- A document deleted in HealthLog is recognised by its content during the
  30-day undo window, so the same file from another archive is not stored
  again; after the purge only its ids are remembered.

- Imports count against the person's normal upload allowance (60 an hour) and
  storage quota.
- A document that is already in HealthLog is not stored twice. Each import is
  keyed by system, instance (the archive's origin) and document id, so the
  same id on two Paperless-ngx instances is two documents; a key imported
  before v1.39.3 carries no instance and matches any instance. These are the
  same rules the document token and `scripts/import-documents.mjs` follow.
- A document the person deleted in HealthLog is never brought back by the
  document token or the import script, however often they re-send it. The
  person can bring it back themselves: from Recently deleted on the Documents
  page for 30 days, or by picking it again in the picker, which says "In Recently
  deleted" or "Deleted in HealthLog" on such a row. Picking one still in
  Recently deleted restores that same document; picking one already removed
  for good imports it again.
- A picked document follows the person's own automatic AI reading setting.
- Only the owner of a record can connect an archive or import from it. People
  with shared access to a record, whatever their level, do not see the picker.
- Connections are not part of backups. After a restore on another server,
  each person reconnects (one form); the imported documents themselves are in
  the backup with the rest of the vault.
- Delete all data and account deletion remove the connection and its token.
- A stored connection stays visible under Settings, read-only, when this
  variable is unset or the person switched Documents off, so it can still be
  removed.
