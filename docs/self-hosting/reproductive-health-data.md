# Reproductive-health data on your own server

HealthLog's cycle tracking stores menstrual, fertility, and related
reproductive-health data the same way it stores every other metric: in
the PostgreSQL database that runs on the host you control, encrypted at
rest for the intent-revealing fields. This page explains what that
arrangement does and does not change about who can reach that data, in
plain terms and without overstating the protection.

## What self-hosting changes

A consumer cycle-tracking app runs on the vendor's servers. Your
reproductive-health data lives in their database, under their keys, in
their jurisdiction. If that vendor receives a subpoena, a civil
discovery request, or a law-enforcement demand it judges valid, the
vendor — not you — decides how to respond, and it holds the data and the
keys needed to comply. Several vendors state in their own privacy
policies that they comply with valid legal process; that is a factual
description of where the data sits, not an accusation.

Self-hosting removes that vendor from the picture. There is no cloud
account holding your cycle data, no vendor key escrow, and no third
party that can be served process to hand over data it does not have. The
honest framing is narrow and worth stating precisely:

> Self-hosting means there is no cloud vendor to subpoena for your
> reproductive-health data. It does **not** make the data
> unreachable.

The encryption-at-rest layer is real: the intent-revealing day-log
fields (free-text notes always; pregnancy, contraception, and
sexual-activity fields by default for this category) are encrypted with
AES-256-GCM under a key you supply via `ENCRYPTION_KEYS`, and the
application fails closed rather than ever writing those fields in
plaintext. Flow, basal body temperature, ovulation-test results,
cervical-mucus observations, and the cycle dates stay in plaintext
because the prediction and correlation engines read them; they are
health observations, not the disclosure-sensitive intent fields.

## The residual threat (read this part)

Self-hosting moves the data onto a box you own. That box can still be
reached:

- **Physical or legal seizure of your own host.** If the machine
  running PostgreSQL — your VPS, your home server, your NAS — is seized,
  imaged, or compelled, the data is on it. Encryption at rest protects
  against a stolen disk or a leaked backup only while the key is _not_
  also available; if the host is running, or the key is stored next to
  the data, that protection is gone.
- **Your hosting provider.** A VPS provider can snapshot your disk and
  can be served process the same way a SaaS vendor can. Self-hosting on
  rented infrastructure narrows the set of parties who hold your data;
  it does not reduce it to zero.
- **Your own backups.** Off-host backups (the optional S3 export, or any
  `pg_dump` you take) carry the same data. Encrypt them, control where
  they land, and treat them as part of the same threat surface.
- **The device that talks to the server.** A phone or laptop with a
  live session, a cached PWA, or the native client holds data locally
  too. Protecting the server does nothing for an unlocked device.

The promise is therefore specific: **no cloud vendor to subpoena**, not
**data nobody can ever reach**. If your threat model includes seizure of
your own infrastructure, encryption at rest plus a key you keep off the
host is the floor, and the threat-model note below covers the rest.

## Public record

The reason this distinction matters is documented in public legal
record, not speculation:

- In 2021 the U.S. Federal Trade Commission settled with the maker of a
  period- and fertility-tracking app over allegations that it shared
  users' health data with third-party analytics and advertising
  services despite privacy promises. The settlement is public record.
- In 2025 a federal jury found that the same app's maker violated a
  California privacy statute over the sharing of menstrual-tracking
  data; the verdict and the underlying class action are public record.

These are cited as factual public record to explain _why_ the
"who holds the data" question is the one that matters for this category.
HealthLog makes no claim about any other product's current practices.

## What deleting actually does

Worth knowing before you rely on it, because "deleted" means two
different things depending on which button you press.

- **Deleting one cycle or day-log entry** hides it. Every read filters
  it out and it is gone from the app, from exports, and from the doctor
  report. The row itself stays in PostgreSQL as a tombstone, which is
  what lets a phone that was offline at delete time learn that the entry
  went away. A nightly job removes a tombstone 75 days after the delete
  (the same horizon as the sync feed's); until then, or until one of the
  two actions below, the row stays. A start that was folded into a later
  cycle stays for as long as that cycle does, because deleting the later
  cycle gives it back.
- **Settings → Advanced → Delete all data** removes the rows, tombstones
  included. Everything the account owns goes except what you sign in
  with; the confirmation dialog lists it. Before it does, it keeps a copy
  of the account on the server for the deletion grace window (14 days by
  default), so a mistaken wipe can be restored; the copy is erased when
  the window ends.
- **Deleting the account** locks it at once and erases it, with every
  record, when the grace window ends. Until then an admin can undo it.

`ACCOUNT_DELETION_GRACE_DAYS=0` makes both immediate again, without the
copy and without an undo.

Three consequences follow, and they matter for the seizure threat model
above. A host imaged while a per-entry deletion is the only deletion you
have performed still holds that entry; so does a host imaged inside the
grace window. A backup taken before any of these actions still holds
whatever it captured, because a backup is a copy of a moment: the nightly
database dumps keep a deleted record until they age out (`DB_BACKUP_KEEP`
nights on the server, and your bucket's lifecycle rule for `database/`).
And after the move to Postgres 18 the old `pgdata` volume is a full copy
of the database from that day until you remove it. If your reason for
deleting is that the data must not be recoverable from the machine, set
the grace window to 0 or wait it out, remove the old volume, and let the
dumps age out or delete them
([backup-restore.md](../ops/backup-restore.md)).

## Practical hardening

If reproductive-health privacy is the reason you self-host, the
operator-side steps that matter most:

- Keep `ENCRYPTION_KEYS` off the host that runs PostgreSQL where your
  threat model allows it (an injected secret at boot, not a file next to
  the database). See `docs/ops/encryption-key-rotation.md`.
- Turn off any integration you do not need. The fewer outbound paths,
  the smaller the surface.
- Encrypt and control your backups. The off-host backup feature uses
  AES-GCM; the destination bucket and its access are yours to lock down.
- Use the in-app **discreet notifications** toggle so cycle reminders
  never name the event on a lock screen, and the **client-managed
  reminders** path if you want the device, not the server, to own those
  notifications.
- Lock the devices that hold a live session.

See also the [threat-model note](../security/cycle-data-threat-model.md)
for a compact "protects against / does not protect against" summary.
