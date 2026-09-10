# Sharing a health record with another account

Two accounts on the same instance can be connected so that one of them
can open the other's health record. A parent and an adult child, two
partners, somebody keeping an eye on a relative's blood pressure — the
case this exists for is a household, not an organisation.

Since v1.37.0 there is a second arrangement beside it: a **managed
profile**, a health record for somebody who has no account at all. That
half is described further down, under "Records with no login".

This page describes what these arrangements do, what they deliberately do
not do, and which of the instance's existing trust properties they leave
exactly as they were.

## The shape of it

One account **shares**; the other is **given access**. In the code and in
the settings copy these are the owner and the person they invited.

- The owner opens **Settings → Shared access** and invites somebody by
  the username or e-mail address that person signs in with. They need an
  account on this instance already; there is no invite-by-e-mail flow.
- **The invitation confers nothing.** Until the other person accepts it,
  it is an offer sitting in their own settings. Being handed read access
  to somebody's health record is not something the product imposes
  silently, and the acceptance — with its timestamp and the accepting IP —
  is what the row records.
- Once accepted, the record shows up in that person's user menu under
  "Open a record". Opening it reloads the app into the owner's record.
- A banner across the top of every page names whose record is open and
  what the access admits, with a button back to the person's own. It is
  loud on purpose: somebody who forgets they are switched will log their
  own reading into another person's record, and there is no undo for an
  entry that was never theirs.
- Either side can end it at any time. The owner withdraws access; the
  other person hands it back. Both are one click with no second factor
  and no typed confirmation — reducing access must never be harder than
  granting it was.

## What the other person can and cannot do

An invitation carries two answers: how much of the record it opens, and
what may be done inside it.

### How much of the record

Either the entire record, which is what sharing has always meant and what
every grant written before v1.37.0 carries, or a set of named sections
chosen when the invitation is written:

| Section           | What it covers                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Readings          | Weight, blood pressure, pulse, glucose, sleep, workouts and custom metrics                                                   |
| Medications       | The medication list, its schedules, doses taken, side effects and stock                                                      |
| Lab results       | Lab results and the analytes behind them                                                                                     |
| Health background | Allergies, family history, the facts in the health profile, visits and the practices behind them, and the vaccination record |
| Illness           | Illness episodes and the day logs kept under them                                                                            |
| Mood and mind     | Mood entries and the mental-health questionnaire history                                                                     |
| Cycle             | Cycle tracking                                                                                                               |
| Documents         | Everything in the document vault                                                                                             |

A section that was not shared is refused exactly the way a record nobody
shared is, so the shape of what was held back is not readable from
outside. Sections are route families and nothing finer: there is no row
filtering, no field filtering and no redaction inside a section that WAS
shared. The invitation screen says this in as many words, because a note
or a document name inside one section can be about any other.

Aggregate surfaces (the dashboard overview, the health score, the daily
digest, every insight) read across sections, so a grant naming sections
never opens one. A figure derived from part of a record reads as a figure
about the person, and it would not be one. Whole-record grants do not all
open them equally either: the daily digest and the dashboard's snapshot
answer at read, while the health score, the dashboard's summary and the
insights need manage.

A stored scope never grows. A section added by a later release is not in
a set somebody ticked before it existed.

### What may be done inside it

Three levels, fixed when the invitation is written. Raising one means
revoking and inviting again, because widening a grant in place would carry
a consent the other person never gave.

| Level  | Adds                                                                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read   | Read what the grant opens, and change nothing.                                                                                                                                                                                |
| Write  | Add entries: a reading, a lab result, an analyte, an illness entry, a side effect, a medication, marking a dose taken or skipped, a visit, a practice, and a vaccination dose. Editing, deleting and restoring stay with you. |
| Manage | Change and remove entries, including ones the owner wrote; record the health background; read the insights generated from the record. Always the entire record.                                                               |

Some entries are creates only **manage** reaches, and the split runs by
entry rather than by section: an allergy, a family-history entry, a mood
entry, a screener, a cycle day, a water entry and a preventive-care
reminder are all created at manage, in sections a write grant can
otherwise add to. Nothing in the document vault is writable at any level.

One entry needs two sections rather than a higher level. Planning the
booster a vaccination suggests files it as a preventive-care reminder,
which lives under Readings, so a grant that opens Health background alone
logs the dose and is refused the booster. Logging the dose is unaffected
either way, and the app does not offer the booster to a grant that cannot
plan it.

Offering **manage** asks the owner for a fresh second factor if they have
one enrolled, which makes it a browser-only act either way: a Bearer
caller is refused before anything else happens and told to use a browser.
Accepting it has no such restriction. Manage never carries a section
scope, because "they can do anything, but only to part of you" promises a
boundary an edit cannot keep.

Everything a manager does is written to the trail under their own name,
with a verb naming the act rather than a generic "made a change".

**Nothing about the account around the record.** This is the line the
whole feature is built on, and it is drawn on the server:

| Not reachable                                                                                | Why it would matter                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Password, passkeys, second factor, recovery codes                                            | Silent takeover, surviving any revocation                                |
| Sessions, trusted devices, sign-out-everywhere                                               | Ending or enumerating the owner's logins                                 |
| API tokens, the MCP connector                                                                | A durable credential that outlives the access                            |
| Connected services (Withings, Fitbit, WHOOP, Google Health, Polar, Oura, Strava, Nightscout) | Re-pointing a sync, or feeding somebody else's wearable into this record |
| Notification channels and push devices                                                       | The owner's health alerts redirected to another phone or chat            |
| Full exports, the encrypted archive, clinician share links                                   | A one-click copy of everything, or a new door that outlives the access   |
| Asking an AI provider anything                                                               | AI processing of the owner's data, under the owner's own consent         |
| Modules, thresholds, units, the record's language and timezone                               | Configuration of the account, not content of the record                  |
| Sharing itself                                                                               | Inviting somebody else, widening the access, or passing it on            |
| Locale, theme, dashboard layout                                                              | Presentation belongs to the person, not to the record                    |

One export is the exception, and it is deliberate: the doctor report
(`POST /api/export/health-record`) answers at manage on a whole-record
grant. It renders a prepared artefact from a selection the caller declares
rather than handing the record over whole, which is the difference the row
above is drawing. The full exports and the passphrase-encrypted archive
stay with the owner.

This table is about a grant between two accounts. A managed profile is
the one place where some of it is deliberately different, because a record
with no login has nobody else to keep its own configuration: see "Records
with no login" below for exactly which part of it a guardian may reach.

The last two rows are worth a sentence each. Sharing is not
transferable: somebody given access cannot invite a third person, cannot
raise their own level, and cannot hand it on. And display preferences
stay with the person at the keyboard, so reading somebody else's record
does not change your own theme, language or dashboard.

The AI row is the one that looks arbitrary and is not. Server-managed AI
features send the record's data to a provider under a consent the record's
OWNER gave, for their own use. Somebody else triggering that would create
a consent-shaped act the owner never made. So a manage grant can READ
insights that were already generated, and nothing a delegate does at any
level causes an outbound provider call or queues a generation job. The
owner's own path is unchanged and is the control that proves the
difference.

These are not checks that a page forgot to render. Every route in the
product refuses by default while a browser is acting on another account;
a route becomes reachable only by declaring it, and the set of declared
routes is frozen by a test.

## Revocation, and what it cannot undo

Ending access takes effect on the other person's **next request**, not at
their next login. The grant is checked against the database on every
single request, so there is no cached verdict to wait out. If their
browser is sitting inside the record when the owner ends it, the same
database transaction puts that browser back into its own account — they
land at home rather than on a wall of refusals.

What revocation cannot do is take back what was already seen. A person
who had read access could have read, remembered, screenshotted or written
down anything in the record. The product can close the door; it cannot
reach through it. Nothing in the interface implies otherwise, and neither
does this page.

Ending access never deletes the record of it. The row stays with the
dates and with who ended it, because "who had access, from when to when,
and who ended it" is a question a deleted row cannot answer. Re-inviting
the same person creates a new row beside the old one.

## Records with no login

A **managed profile** is a health record for somebody who does not sign
in: a child, or an adult who is cared for. It is a real account row with
no password, no passkey and no e-mail address, and it is never presented
as something to log in as.

- It is created from **Settings → Shared access**, under a fresh second
  factor. An account with no second factor enrolled is refused rather than
  waved through, because the act creates a permanent management
  relationship over a person who cannot object to it.
- Creation takes a display name, optionally a real date of birth, and the
  language and timezone the record's own days and reminders are measured
  in. A year on its own is never turned into the first of January. The
  language belongs to the record, not to the guardian reading it, so the
  guardian's own screens stay in their own language.
- The creator becomes the first **guardian** in the same transaction, over
  an ordinary accepted MANAGE grant with the profile as grantor. If either
  half fails, neither happens: there is no window in which the profile
  exists with nobody looking after it.
- A second guardian is invited and accepts exactly like any other
  invitation. An accepted guardian grant does not expire; the invitation
  token still can.
- **A managed profile can never be left guardian-less.** Revoking,
  handing back, deleting a guardian's own account and deleting the
  profile all take the same lock on the profile and re-check the count
  inside it, so two people cannot both leave at once. The last guardian is
  refused, with a message naming the two ways out: add another guardian,
  or delete the profile under a fresh second factor. Deleting the profile
  deletes everything recorded for it.
- A guardian may keep that record's settings: modules, units, thresholds,
  its language and timezone, and its notification preferences. Connected
  services are visible as a status only. Connect, callback, sync,
  credential, disconnect, resume and test are not guardian surfaces in
  this release, and their deep links land on the shared-record unavailable
  page rather than on a raw refusal.
- **Its reminders go to its guardians.** A record with no login has no
  channels of its own, so medication reminders, measurement reminders,
  safety-floor alerts and low-stock alerts fan out to every active
  guardian, in that guardian's own language and over the channels that
  guardian already configured. Nothing else fans out; every other event
  stays on the path it was already on. The payloads carry no take or skip
  action, on any channel, so a notification about somebody else's record
  cannot be acted on from a lock screen. One guardian suppressing
  server-side reminders on their own device does not suppress anybody
  else's.
- Delivery attempts record both the record the message is about and the
  person it was sent to, so the admin notification diagnostic can answer
  "who was this for" and "whose record was it about" separately.

There is no emancipation flow: no route, no control and no copy suggests
a managed profile can be turned into an ordinary account. The data model
leaves room for it (the credentials are nullable and the managed marker
can be cleared) and clearing that marker stops the notification fan-out,
but nothing in v1.37.0 exercises any of that.

## Seeing what happened

**Settings → Shared access** answers three questions for the owner, at
any time: who can open this record, since when, and when they last did.
Below that, a list of the days somebody else opened it and how many times
— one line per person per day, rather than a line per request.

That list is bounded by the instance's audit retention, and the page says
so with the actual number rather than a hardcoded one. The default is 365
days (`AUDIT_LOG_RETENTION_DAYS`); an operator who shortens it shortens
this view too, and the sentence under the heading changes to match. The
query is bounded to that window, so the sentence is the real limit of the
list rather than a caption over an unbounded one.

Two things the list does not claim, both worth reading before treating it
as an answer:

- **An empty list is not proof that nobody opened the record.** It means
  nobody did so within the window, and that any earlier row has been
  purged.
- **The list is capped.** It returns at most the hundred most recent rows
  inside the window; when it hits that ceiling it says so under the
  heading. A busy household can reach the cap in far less time than the
  retention window, and the oldest line on screen is then the oldest line
  shown, not the oldest that exists.

## What this does not change about the instance

Stated plainly, because a sharing feature is exactly the moment somebody
re-reads the trust model:

- **The operator could always read the database.** Anyone with server or
  database access, and anyone with an admin account on this instance, can
  reach health data directly. That was true before sharing existed and is
  unchanged by it. On a household instance the operator is usually one of
  the people using it; on an instance hosting other people, it is worth
  saying out loud.
- **Encryption at rest is instance-keyed, not per-user.** The encrypted
  columns are protected by the key in `ENCRYPTION_KEYS`, which belongs to
  the instance. Sharing does not weaken that, and it never did protect one
  account's data from the operator of the same instance.
- **AI processing stays under the record owner's consent**, because the AI
  surfaces are not part of what sharing covers.

## For operators

Nothing to configure. Sharing is available on every instance, needs no
environment variable, and does nothing until one account invites another.
The same is true of managed profiles.

Four operational notes:

- **Invitations disclose whether a username exists.** An invitation to a
  name nobody uses is refused with "no account with that name". That is
  deliberate: the alternative is a silent pending row that will never be
  accepted because the owner mistyped. The caller is already
  authenticated and the endpoint allows ten invitations an hour per
  account, which bounds how fast the surface could be walked.
- **Deleting an account** removes the grants it is party to. The audit
  rows naming that account as the one who opened somebody's record stay,
  and render as "a deleted account" — nulling them would turn "your
  daughter opened your record" into "you opened your record", which is
  worse than an unresolvable id. Deleting the last guardian's account is
  refused while the managed profile would survive it, so an account
  deletion cannot strand a record.
- **A managed profile is a user row and appears as one.** It is listed in
  the admin user list like any other account, with no e-mail address
  beside it and an internal username nobody is ever asked to type. No
  login path will accept it: there is no password hash to verify against
  and no address to look it up by.
- **The second-factor requirement is not the same on both features, and
  the difference is deliberate.** Creating a managed profile, deleting
  one and inviting a second guardian require a second factor
  unconditionally: an account with none enrolled is refused and told to
  set one up, because those acts create or end a permanent relationship
  over somebody who cannot object. Offering manage access on an ordinary
  invitation asks for a fresh factor only from an account that has one, so
  an instance where nobody has enrolled a factor can still use every level
  of ordinary sharing. All of them are browser-only either way.
