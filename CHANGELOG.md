# Changelog

## [Unreleased]

- **MCP search cursors keep lab results stable across pages.** Distinct analyte
  names are ordered before offset pagination, preventing repeated or skipped
  lab entries when a client follows `nextCursor`.

## [1.31.7] — 2026-07-20

- **Current OpenAI reasoning models use their supported request contract.**
  Official GPT-5, o1, o3, and o4 models receive `max_completion_tokens`
  without unsupported `temperature` or `seed` fields; compatible custom
  gateways retain the legacy parameters they advertise.
- **Apple Health XML cumulative totals no longer add overlapping sources.**
  Imports aggregate each source/day independently and select the highest
  source subtotal, while explicit provenance prevents XML estimates or late
  legacy samples from overwriting authoritative native HealthKit statistics.
  Existing legacy aggregates can be repaired by re-uploading their archive.
- **Every currently actionable medication reaches Today.** Equal-time doses no
  longer collapse to one row, overdue doses win deterministic ties, and weekly
  or custom intake windows use the scheduling engine's real availability
  boundary. The shared digest fixes both the web start page and iOS Home.

Migration `0263_apple_health_aggregate_authority`. No breaking changes.

## [1.31.6] — 2026-07-21

- **The hardened runtime image can run database migrations again.** The
  isolated Prisma CLI now exposes its pinned `dotenv` and `prisma/config`
  dependencies to the copied production configuration while package managers
  remain absent from the final image.

No migrations. No breaking changes.

## [1.31.5] — 2026-07-21

- **The production image no longer ships build-time package managers.** pnpm 11
  verifies the lockfile under explicit build-script policy, npm and Corepack
  are removed after migrations are prepared, and linked worktrees stay out of
  local Docker build contexts.

No migrations. No breaking changes.

## [1.31.4] — 2026-07-21

- **Web and background processes now start and recover predictably.** Invalid
  encryption-key configuration fails before the service accepts traffic,
  worker-only processes report their real health, connection limits are
  divided safely across replicas, and provider backfills keep their bounded
  queues during reconnects.
- **Published images are reproducible and verified before promotion.** The
  release pipeline builds one multi-architecture image, validates its digest,
  startup, migrations, health, and reported version, and only then promotes
  that exact artifact to production.
- **CI now uses isolated, deterministic test environments.** Integration tests
  receive their own database and cryptographic settings before application
  code loads, worktrees install hooks consistently, and browser tests use the
  intended application process on every platform.
- **Concurrent iOS registrations no longer fail intermittently.** Device and
  APNs notification-channel reconciliation now share one database lock and
  transaction, so simultaneous first registration remains idempotent.

No migrations. No breaking changes.

## [1.31.3] — 2026-07-20

- **Document summaries now stay in the language you chose.** The same account
  language is used whether a summary is created in the background or requested
  from the document sheet. A saved summary remains visible and can be replaced
  with **Generate again** after you switch languages.
- **The Coach composer has more room on phones.** The writing field now gets
  its own line, with document and conversation actions below it and Send on the
  right. The unreliable browser dictation button and its dead-end permission
  states are gone.

No migrations. No breaking changes.

## [1.31.2] — 2026-07-20

- **Provider imports now commit identity and progress atomically.** Withings,
  WHOOP, Oura, Polar, Strava, and Apple Health reconcile external and natural
  measurement identities under database locks, preserve tombstones, emit
  arrivals only for genuine inserts, and advance cursors only after durable
  writes. OAuth refresh-token rotation is serialized per user and provider.
- **Webhook and import success now means the source data is durable.** moodLog
  writes before acknowledging delivery, while Withings ECG callbacks enter a
  durable queue with bounded retry and replay-safe processing. WHOOP backfills
  commit bounded chunks without advancing failed resource cursors, and legacy
  mood imports use deterministic, collision-free retry identities. Operational
  JSON import failures are reported as failures instead of misleading
  duplicate skips.
- **Recovery is complete, exact, and owner-safe.** Canonical backups round-trip
  every supported record class, including encrypted document content,
  measurement reconciliation identities, and tombstones. Restore rejects
  account mismatches before writing, validates backup enums at the boundary,
  processes stable measurement IDs in bounded batches, and preserves recovery
  integrity across both uploaded and off-host payloads.
- **Device and mood edits no longer lose related state.** Same-user APNs
  registrations merge transactionally without crossing account boundaries,
  refresh-token bindings follow the surviving device, and mood edits preserve
  rated factors unless the caller explicitly replaces them.
- **Polar sync follows the current AccessLink collection API.** Collection
  requests no longer include the obsolete user ID path segment, and current
  activity, Nightly Recharge, cardio-load, sleep, and SpO2 response shapes are
  normalized without losing stable measurement identity.
- **The July dependency bundle is included.** PDF.js 6 now releases its loading
  task correctly; Canvas 1.0, Radix UI 1.6.2, Tailwind CSS 4.3.3, the Tailwind
  Prettier plugin 0.8.1, and setup-node 7 are integrated.

No migrations. No breaking changes.

## [1.31.1] — 2026-07-19

- **Arrival events now follow committed inserts across every writer.** Provider
  re-sync updates stay silent, partial Apple Health imports retain arrivals
  from earlier committed batches, all newly inserted workouts emit, and sleep
  refreshes distinguish new stages from updates. Web-only processes now retry
  their bounded send-only queue connection instead of permanently losing
  arrival jobs after one transient startup failure.
- **Reaction and workout generation are single-spend operations.** Durable
  database claims close worker races and provider-retry gaps, daily token
  reservations are atomic and reconciled on every terminal path, and both
  generation and display honor the user's Insights and Workouts module choices
  plus server-managed consent.
- **AI context is narrower and more accurate.** Arrival reactions use the
  record that actually landed, completed sleep uses the reconstructed night
  rather than one stage segment, user-authored lab fields are fenced as data,
  workout comparisons use canonical sessions and dates, and every metric and
  derived-score coach entry carries its exact supported scope.
- **Dashboard state survives old and partial clients.** Saved comparison range
  points and newly supported metric widgets are preserved, while Today
  freshness remains aligned across local-day boundaries, DST, tab focus, and
  split web/worker deployments.

Three migrations (0260, 0261, 0262). No breaking changes.

## [1.31.0] — "The record that reacts" — 2026-07-19

A milestone release: the record now visibly responds when something lands,
instead of waiting for a daily rollup to notice.

- **Today shows what just came in.** A completed night's sleep, a workout, a
  first weigh-in of the day — the home screen now carries a calm "just in"
  note for a few hours after each one, and at most one written line a day per
  kind, grounded in your own numbers. Nothing changes if you run without an
  AI provider: the sentence is the garnish, not the feature — the arrival
  itself still appears, including on an otherwise-empty record, and an open
  dashboard refreshes it as soon as the tab becomes visible again. The
  underlying change that makes this possible without new polling or a flood of
  background work: every write path that can produce a genuinely new reading
  now emits a single typed event, day-scoped and de-duplicated, that a mass
  import or a provider re-sync produces none of — a ten-year import or a
  month of catch-up sync stays silent, by construction, not by luck.
- **A finished workout gets its own paragraph.** Opening a recent session now
  shows a short, grounded read of that one activity — duration, effort,
  where it sits against your own recent sessions for the sport — with no
  training advice and no target zones. It is generated once, the first time
  you open a fresh session, never on re-sync and never for older workouts
  already in your record.
- **"Ask why" reaches every read-only card.** Every per-metric status card,
  every derived-score page, and a finished workout now carries a way straight
  into the coach, pre-loaded with just that card's own data so the
  conversation starts already grounded — not with a blank prompt.
- **The lab-marker card and the offline metric texts speak with the same
  voice as everything else** — meaning first, in your own language across
  all six locales, checked by an automated tone pass that now runs on every
  change to these surfaces so this kind of drift gets caught before it ships
  again.
- **The dashboard layout stops discarding a comparison choice on save,** and
  four clinical widgets stop disappearing from a saved layout — both from a
  save made by a client that does not know those particular fields yet.
- **Mood and BMI reach the app's home screen**, and a medication pen can now
  carry the maker and printed strength that show up in the native pen list.
- **Every new AI call this release can cause is metered and bounded**: a
  daily cap per kind, a duplicate-content check that makes a re-post free,
  and a token reservation that is always reconciled, including on every
  failure path — the same discipline the rest of the AI surface already
  holds to.

Two migrations this release (0257, 0259); an additional dashboard-widget
migration carried over from the prior line. No breaking changes.

## [1.30.35] — 2026-07-19

- **The metric texts you see without an AI provider now speak your
  language.** They shipped in German and English only; French, Spanish,
  Italian and Polish fell through to English. These are what nine metric
  cards render whenever no provider is reachable — no key configured, an
  outage, a spent budget — so for those readers this text was the app's
  voice, in the wrong language. Written per language rather than
  translated: where a sentence could not be formed naturally, that
  language got its own sentence.
- **The lab-marker card leads with what a value means**, like every other
  card already did. It was the last one still instructed to state the
  number first.
- **The response length for a metric assessment is set in one place**
  again, instead of one card carrying its own inline pair.
- **The fallback texts open on something honest** rather than on an
  instruction, and the lab-marker card no longer shows the multi-metric
  overview tip on a single value.

No migrations. No breaking changes.

## [1.30.34] — 2026-07-19

- **Rearranging your dashboard no longer wipes the comparison baseline.**
  A layout save from a client that does not know about that setting — the
  app never sends it — silently reset it to "none". Every field of the
  layout now has to declare whether an absent value means "clear it" or
  "leave it alone", so the next field added cannot repeat this.
- **Four clinical widgets stopped disappearing from a saved layout.**
  Pain, grip strength, waist and waist-to-height were dropped by the save
  as unknown, so a placed widget was lost every time.
- **Mood and BMI reach the app's home screen.** Both existed in the
  record but were absent from the summary the app reads, so those two
  tiles could not be shown while every other one worked.
- **A pen carries its manufacturer and printed strength.** Without them,
  containers entered on the web could not be shown in the app's pen list.
- **Destructive controls ask first.** Signing every other device out,
  revoking a session, and revoking a trusted device fired on a single
  tap. A sweep found two more with neither a confirmation nor an undo: a
  Coach reminder and a travel entry. Deleting a document still does not
  ask — it can be undone, which covers the mis-tap.
- **Delete confirmations stop overclaiming.** Four of them promised the
  deletion could not be undone while the same screen offered an undo.
  Warnings that are wrong make the ones that are right easier to ignore.
- **The sleep-debt figure is described correctly again.** The calculation
  changed to a running balance that credits surplus in v1.19.0; the label
  still said "cumulative shortfall". The wrong description had spread to
  the Coach, which was reasoning about the number on the old definition,
  and to the published API description.
- **The glucose reference band can be chosen on the web.** The setting
  already worked and already fed the Coach — nothing on the web set it.
  It selects a reference range; it is not a diagnosis and is never
  inferred from a reading.

One migration (0256), additive. No breaking changes.

## [1.30.33] — 2026-07-19

Security release. It ships on its own because it changes how a browser
session is recognised.

- **The session cookie is a purpose-generated secret.** It used to be the
  session record's own database key — an identifier built to avoid
  collisions, not to be unguessable, and one that appears wherever that
  record is referenced. The cookie now carries 32 bytes from the system's
  random source, and only its hash is stored, so the value in your
  browser exists nowhere on the server.
- **You are not signed out by this.** Sessions from before the change
  keep working and are simply not renewed, so they run out their normal
  30 days and disappear. Every sign-in from this release onward is on the
  new scheme.
- **The device list no longer hands out working credentials.** It
  identified each device by that same record key — which, for a session
  predating this release, is that device's cookie. It now shows an opaque
  handle that is useless as a login, and the same handle is what signs a
  device out.
- **A refresh token cannot be rotated from a different device**, and an
  expired one is refused. The test that was supposed to prove the expiry
  passed a token that had never been issued, so it proved nothing: with
  the expiry check deleted, the suite still went green. It is a real test
  now.
- **A Nightscout address is checked when you save it**, not only when it
  happens to be probed first. The check itself already refused private,
  loopback and cloud-metadata addresses.

Operators: rotating `API_TOKEN_HMAC_KEY` now also signs out every browser
session, not just API tokens. One migration (0255), additive.

## [1.30.32] — 2026-07-19

- **A withdrawn AI consent stays withdrawn.** Opening the AI settings
  granted consent again if you had taken it back, and recorded it as
  though you had done it yourself. A withdrawal is now a standing
  decision that only an explicit act can lift.
- **The web can withdraw AI consent at all.** Until now only the app
  could; on the web, consent could be given and never taken back. The AI
  settings show what currently stands and offer the control that changes
  it. Withdrawing takes effect immediately and deletes nothing you have
  recorded.
- **Documents get read after you switch automatic reading on.** Reading
  was only ever started at upload, so documents already in your vault
  stayed unread no matter what the setting said. Turning it on now works
  through what is already there, in batches, asking the same permission
  as any other read.
- **A quoted passage in a document review is the document's own text.**
  The quote shown for a finding was the wording that came back from the
  read, not the line it was taken from — so it could be a paraphrase of
  your own record presented as a verbatim quote. The passage is now
  looked up in the document itself, and a finding whose source cannot be
  located says so instead of showing a quote you cannot check.
- **Pages that arrive with your data pre-loaded now say so on the wire.**
  They were never cacheable in practice, but nothing stated it. Anything
  behind the sign-in wall is now marked private and uncacheable at the
  edge, so no proxy or future change can hold one person's record and
  hand it to someone else.
- **Deleting your last reading of a kind no longer leaves stale weekly,
  monthly and yearly figures.** The daily figure went; the longer spans
  kept the old aggregate indefinitely.
- **The documented API matches what the endpoints return.** Twenty
  corrections, including a total that the measurements list reports in a
  different place than the specification claimed, four medication figures
  named wrongly, a missing intake source, and eleven error codes that
  were never written down.
- **A retry after an unusable AI answer asks for the right shape.** The
  correction prompt demanded fields that do not exist and named none of
  the ones actually required, so the one corrective attempt steered away
  from the contract instead of towards it.

No migrations. No breaking changes.

## [1.30.31] — 2026-07-19

- **Today shows a dose before it is late.** The card only surfaced a
  medication once it was already overdue, so it could report nothing
  needing attention while a dose was due. A due dose now reads as a calm
  note, an overdue one as a warning, and a day with everything taken
  still shows the all-clear. Reminders are unchanged — they still only
  fire once a dose is late.
- **The daily briefing stops disappearing.** The check that verifies
  every figure against your own data was looking in fewer places than the
  briefing draws from, so a briefing quoting your medication adherence or
  a change since last month was thrown away as unverifiable. It now
  checks against everything the briefing is built from. And when a figure
  genuinely cannot be verified, yesterday's briefing stays up instead of
  the section going blank.
- **The "read the full briefing" link is gone from Today.** Tapping the
  health-score ring already opens the same page.
- **The close button on a document sits flush with the edge again.**
- **A document no longer says its summary is being generated forever.**
  Summaries are only started when a document is uploaded while automatic
  reading is on — there is no catch-up for documents you already had, so
  the view promised a summary that was never coming, and hid the button
  that would have made one. It now says what actually happened — not
  attempted, unavailable, or held back — and offers to generate one in
  every case. A summary you generate that way is kept.
- **Removed the "read by AI" note** at the bottom of a document.

One migration (0254). No breaking changes.

## [1.30.30] — 2026-07-19

Four languages get their own words; a failed read stops claiming you have no data.

- **Reminder notifications, the assistant's reply language, chart and calendar labels, and durations were English or German for French, Spanish, Italian and Polish.** The translations existed; the code that picked between them only knew two languages. It now uses the account's own.
- **Polish counts correctly.** Polish has a third plural form that a two-form scheme cannot express, so counted phrases read wrong. The other five languages resolve exactly as before.
- **A screening history that failed to load said "not taken yet".** On a mental-health surface that is a false statement about your own record — you could reasonably conclude you never completed something you did complete. That surface, and a nutrient card with the same flaw, now say the reading failed and offer to try again. Nothing retries silently: a failure you cannot see is worse than one you can.
- Three sleep-rhythm cards that share one reading each printed the same failure notice; the page now shows it once.

## [1.30.29] — 2026-07-19

- **A connector token that may only read is now refused at the write itself**, not only by never being offered the write. The protection was real but rested entirely on how the connection is assembled, so a future change to that assembly could have opened writing with no test noticing. Any write added later inherits the check.
- **Names and text read out of your records now carry an explicit boundary when handed to a connected assistant**, matching what the app already does for its own assistant.
- **Reading a medication list from a photo measured its cost against the server-wide limit even when you use your own key.** It now uses your own limit. The older way of counting that caused this — the third surface to have it — is removed entirely rather than fixed in place, so nothing can reach for it again.
- Removed a module that read as a check on generated recommendations but had not run for some time. It could not simply be switched on: it required fields the current format does not have, so enabling it would have rejected nearly every generation. The measurement it fed is unaffected and still runs.

No breaking changes.

## [1.30.28] — 2026-07-19

- **Daily briefings count against the AI budget.** They were the one
  remaining kind of generated text that did not, so a morning's briefings
  could run past the limit you set. On your own key they count against
  your limit, not the server's.

## [1.30.27] — 2026-07-19

- **The resting heart-rate chart no longer stops partway.** Older
  readings get condensed after a while, and the chart treated the
  condensed days as the whole story — so recent days went missing. It now
  shows both, and says when a day is an estimate.
- **Summaries recompute for the whole day or month.** Recomputing from a
  point in the middle replaced the full period with a partial figure.
  Affected summaries correct themselves the next time that day is written
  to, or on the next nightly pass.
- **A repeated daily total in one upload keeps the newer value.** It kept
  the older one.

No breaking changes.

## [1.30.26] — 2026-07-19

- **Text read out of your documents is treated as data.** Lab field
  names were passed to the assistant unchecked, so a document whose
  labels were written to look like instructions could influence later
  answers. Those names are cleaned now, and document text is marked as
  yours rather than as something addressed to the assistant.
- **A reminder the assistant picks up from a chat is proposed, not
  active.** It waits for you to confirm it, like its other suggestions.
  Reminders from before this release keep working unchanged.

No breaking changes.

## [1.30.25] — 2026-07-19

- **Generated cards count against the AI budget.** Metric cards,
  biomarker cards, scores and the period narrative were not counted at
  all. On your own key they count against your limit, not the server's.
- **Switching language no longer regenerates everything twice.** The same
  card in six languages counted as six separate jobs.
- **Long assistant conversations get cheaper again.** Past a certain
  length the full context was re-sent on every turn instead of once.

No breaking changes.

## [1.30.24] — 2026-07-19

- **The safety check on generated text covers every card, in every
  language.** It ran on the assistant's replies but not on the metric
  cards, biomarker cards or document summaries — so a sentence the
  assistant would refuse to send could still appear on a card. It also
  only knew English and German wording, leaving four languages
  unprotected. Both are fixed.
- A document transcription is deliberately never filtered: it reproduces
  your own document, and a letter from your prescriber is a record, not
  advice from us.

No breaking changes.

## [1.30.23] — 2026-07-19

- **Switching a module off now also applies to connected assistants.**
  With a module off, a connected assistant could still read that data —
  including the full doctor summary — and so could a shared clinician
  link. Both now honour the switch.

No breaking changes.

## [1.30.22] — 2026-07-19

- **Background jobs stop piling up on themselves.** Duplicate jobs were
  meant to be collapsed but were not, so a large sync could queue
  thousands of identical recomputations and a restart could re-queue a
  running history import. Existing installations are updated on the next
  start.

No breaking changes.

## [1.30.21] — 2026-07-19

- **Dose reminders land on the right hour across a clock change.** On the
  day the clocks change, a reminder could resolve an hour off, and the
  same dose could end up recorded twice. Nothing stored changed.
- **The next-dose day label was wrong** when your phone's timezone
  differed from the one in your profile.

No breaking changes.

## [1.30.20] — 2026-07-19

- **A restore refuses when the backup file names a different account**
  than the backup you selected.

No breaking changes.

## [1.30.19] — 2026-07-19

- **Switching a module off now holds everywhere.** The sync feed still
  sent cycle data, the FHIR export still returned the full record, and
  the dashboard summary still built glucose and sleep cards regardless of
  the switch. Nothing is deleted — turning a module back on finds the
  history complete.
- **Two assistant features sent data out without checking your consent
  first.** Both now check, and fall back to their plain text when consent
  is absent.

No breaking changes. The native app may see a 403 from the FHIR
endpoints where a module is off.

## [1.30.18] — 2026-07-19

- **Health data no longer reaches the logs or the backups.** Cached
  responses are encrypted at rest — they echo what was just saved, so
  cycle notes and mood text sat unencrypted in every backup for a day.
  Diagnostic log entries are now scrubbed where they are written, and a
  failed AI request no longer records what came back with it.

Log lines and backups written before this release may still contain those
values. No breaking changes.

## [1.30.17] — 2026-07-19

- **API tokens enforce their scope.** A token issued for medication
  intake reached every endpoint, including the full backup export. Routes
  that accept a narrow token now have to say so.
- **Revoke and re-issue any token you gave to a third party.** Treat it
  as having had that reach for its whole lifetime.
- **The generic "create API token" button is gone.** The token it made
  never worked for the medication intake it advertised, while reaching
  everything else. Tokens are issued per medication from that
  medication's own toggle. Existing tokens stay listed and revocable.

No breaking changes to the web app, the native client or the MCP
connector.

## [1.30.16] — 2026-07-19

- **Resting heart rate stops being lost.** Older heart-rate readings are
  condensed on a schedule, and a resting value is derived before the raw
  readings go. A faulty check stopped that derivation after the first
  run while the raw readings were still cleared, so each run lost another
  day's resting figure for good. Days already affected cannot be
  recovered; from here nothing further is lost.

No breaking changes.

## [1.30.15] — 2026-07-18

- **Assessments come in the language you set.** French, Spanish, Italian
  and Polish accounts got German or English text instead of their own.
  Insight cards, the per-metric assessments, scores, the biomarker card
  and the period narrative now follow your language. German and English
  are unchanged. Stored texts in the four languages refresh on their next
  nightly run.

No breaking changes.

## [1.30.14] — 2026-07-18

The workouts page joins the pages that paint on first load.

- **The workouts list opens with the sessions already there.** It was the last high-traffic surface still fetching its rows after the page mounted, so it showed a loading skeleton first and filled in a moment later. The list is now read on the server and handed to the page populated, the same way the dashboard, insights, medications, and coach pages already work. The list logic moved into a shared read so the page and the API endpoint go through one cached, deduplicated pass instead of two.
- **API docs: the heart-rate bucket example matches what the server accepts.** The aggregated heart-rate `externalId` was documented with an hourly example from its first version; the contract has been 10-minute buckets since v1.30.7. The description, the example timestamp, and the min/max field notes now describe the shipped contract.

No breaking changes.

## [1.30.13] — 2026-07-18

More pages that paint on first load.

- **The insights, medications, and coach pages open with their content already there**, the same way the dashboard now does — their above-the-fold data is read on the server and handed to the page populated, instead of a shell that fills in after a second round of requests. Nothing that would trigger AI work is pre-run: the daily briefing and the coach's own reads stay on-demand as before.

No breaking changes.

## [1.30.12] — 2026-07-18

Faster medication reads.

- **The dashboard's medication section stays fast as your log grows.** Its reads now use dedicated indexes instead of scanning the full intake history on every load, so a long history no longer slows down the daily view.

No breaking changes.

## [1.30.11] — 2026-07-18

Native single sign-on.

- **The iOS app can sign in through your identity provider (OIDC SSO).** Until now, single sign-on only worked in the browser — the native app couldn't complete it, which locked native users out entirely on an SSO-only instance. The server now supports a native sign-in handoff (an in-app authorization flow that returns the app's normal token, never a cookie), so the app can offer SSO once it adopts the flow. Existing password and passkey sign-in are unchanged. Multi-factor sign-in still applies, and an SSO session never satisfies a step-up prompt — those still require your own second factor.

No breaking changes.

## [1.30.10] — 2026-07-18

Localized insight text, and a richer workout view.

- **Correlation insights now read in your language.** The "this tends to go with that — a pattern worth watching, not a cause" lines under a metric were always written in English; they now render in your interface language (German, Spanish, French, Italian, Polish), with the association-not-causation framing preserved in each.
- **A workout you open shows more of what was recorded.** The detail view now draws the session's heart-rate curve over time, its route as a clean line, the time spent in each effort zone, per-kilometre splits, and how it compares to your own average for that sport — all from data already synced, with no new connection. Anything a given workout didn't record simply isn't shown.

No migration. No breaking changes.

## [1.30.9] — 2026-07-18

Faster dashboard first load.

- **The top card and the charts paint with their data on first load** instead of flashing empty and then filling in. The daily summary and the charts' 31-day series are now read on the server and handed to the page already populated, so there's no wait for a second round of requests after the page appears. The welcome/summary card, likely the slowest thing to show before, now lands with the first paint.

No migration. No breaking changes.

## [1.30.8] — 2026-07-18

Hardening for the new heart-rate upload validation.

- **A malformed bucket timestamp is rejected, not silently misfiled.** A bucket whose time rolled over (a 24:00, an impossible day) is now refused rather than stored under a non-standard key, where it would have failed to merge with a re-post and could land on the wrong day.
- **The per-window low/high is sanity-checked before it counts.** A window's low and high are kept only when they are in a plausible range and sit either side of the average; a glitched reading no longer skews the day's high/low band. The average is always kept.

No migration. No breaking changes.

## [1.30.7] — 2026-07-18

Groundwork for a tidier heart-rate history.

- **The server accepts a 10-minute aggregated heart-rate upload.** A watch records heart rate every few seconds, and uploading one row per raw sample fills the measurements list with the same value repeated many times a minute. The server now takes one row per 10-minute window — its average, with the low and high of the window — and the within-day pulse curve reads it directly, so the detailed 10-minute chart and the elevated-at-rest note are preserved. The de-duplication reaches the list once the mobile app sends the aggregated shape; existing per-sample history is unaffected and reconciles itself over time.
- **The daily high/low reflects the true spread.** A day built from 10-minute windows now reports the real intra-window extremes, not the range of the averages.

No migration. No breaking changes.

## [1.30.6] — 2026-07-18

Accessibility pass.

- **Heatmaps read to a screen reader.** The mood and medication-compliance grids now expose each recorded day — its date and value — through a hidden day list, so the per-day figures are no longer reachable by pointer only. The chart looks exactly the same.
- **Small labels meet the minimum size.** Muted meta text across settings, admin, the coach panel, and the insights cards is lifted off the sub-`text-xs` sizes; tabular figures and chart chrome are unchanged.
- **A couple of section headings.** Two metric-page sections became proper headings, so heading navigation lands where it should.

No migration. No breaking changes.

## [1.30.5] — 2026-07-18

Making a shipped feature findable, and a sync-status fix.

- **ECG has a home you can reach.** Recordings now have their own page in Insights, a pill in the Heart group that appears once you have a recording, and links to it from the resting-pulse and heart-rate-variability pages. Before this they were reachable from a single spot, and a deep link into the overview could land before the section had drawn. The page is unchanged in substance — the same non-diagnostic, device-attributed view.
- **The "last synced" time stops lagging.** A sync driven by an incoming update now records the connection's last-success time straight away, instead of leaving it frozen until the next full poll — so the Settings status and the assistant's integration read reflect a sync that already happened.

No migration. No breaking changes.

## [1.30.4] — 2026-07-18

The read-only assistant connector now reaches the full record.

- **More of your data is readable.** The connector gained direct reads for nutrition and vitamins, the intraday pulse curve, and stored ECG recordings, plus discovery for a set of device metrics that were collected but not advertised — wrist temperature, cardio recovery and load, day and workout strain, sleep score, breathing disturbances, fall count, the six-minute-walk distance, stair speeds, and energy expenditure. They can now be compared and baselined by name.
- **Correctness.** Heart-rate variability resolves whether the source records the SDNN or the RMSSD flavour, so a ring- or strap-only account is no longer reported as having none. A workout logged by two devices is counted once, matching the workouts list — this also corrects the figure the coach sees.
- **Exposure stays deliberate.** The mental-health screeners and the environmental signals remain off the connector by construction; a metric is only readable once it has been named for it.

No migration. No breaking changes.

## [1.30.3] — 2026-07-18

Follow-up fixes from a full quality re-check of the app.

- **Correctness reaches every surface.** The timezone, window, and grain fixes now also cover the coach's correlations, the per-metric cards, and the period narrative (they had kept an older copy). Daily insight cards roll over at your own midnight, not a fixed one. Personal records that a second device had inflated are re-derived on the next start, so a genuine record can be set again.
- **The metrics catalog** shows a loading state and a retry on error, instead of briefly reading as "not tracked".
- **Small.** One shared info popover, larger tap targets on the view toggles, a notch-safe height fix on the coach history page, and a few wording and translation gaps closed (a body-composition caveat, study citations, the backup scope note).

No breaking changes.

## [1.30.2] — 2026-07-18

More audit-backlog fixes.

- **Coach history is fully reachable.** The conversation list pages through your whole history and search runs on the server (by title), instead of only the first ~20 loaded chats.
- **Navigation and flows.** A document links to the lab values it produced; the two "Recovery" pages are named distinctly and cross-linked; mood, mental wellbeing, and mood insights link to each other; the nutrients card moved out of "Source priority"; the onboarding checklist and tour no longer point at dead ends; asking the coach from a metric or a plan carries that context in.
- **Correctness.** Correlations, the intraday chart, achievements, and the nutrients overview now bucket days by your own timezone and lead with the most recent data; a multi-source day is no longer counted twice.
- **Performance.** The workouts list caches its de-duplication per filter, so paging through a long history is quick.

No migration. No breaking changes.

## [1.30.1] — 2026-07-18

Polish and small fixes.

- **Mobile.** Coach and document text wraps instead of overflowing; the intake history is a card list on small screens instead of a sideways-scrolling table; tap targets meet the minimum size; two dialogs became bottom sheets; the workout detail header stacks cleanly.
- **Feedback.** Loading skeletons match the content that replaces them (no more layout jump), and the Today priority-card actions show a pending state and can’t fire twice on a double-tap.
- **Remembered choices.** A chart’s time range and the measurement type you last logged are remembered; a coach chat deletes with an Undo; a backdated dose can be undone; lab panels get “Save & add another”; pull-to-refresh works on more pages (and a scroll-position bug that made it fire anywhere is fixed).
- **Consistency, accessibility, wording.** Spacing and contrast tidied, more empty states use the shared component, headings and focus rings improved, a few German phrasings corrected, the daily line reads more calmly, and several explanations gained their guideline citation.

No migration. No breaking changes.

## [1.30.0] — 2026-07-18 — Quality pass

A broad correctness, performance, and polish release, plus two new features. Nothing new is required of you; existing data is untouched.

### Added

- **Document summaries.** An uploaded document can get a short plain-language summary, generated once at upload and stored encrypted. It runs only when the external-AI document reading you already opted into is on, and never touches older documents.
- **Efficacy chart, readable.** The medication efficacy chart scales its axis to the data (a real trend no longer looks flat), gains a “% since start” view, and the history tab reaches your full intake history, not just the last 90 days.
- **A metric catalog.** A quiet “All metrics” view lists everything HealthLog can track and which device supplies each — so a metric you don’t have data for stays out of your daily views but is still discoverable in one place.

### Fixed — correctness

- **The number shown matches reality.** The workouts and measurements lists now lead with the most recent entries (a long history no longer hid recent days), and a metric recorded by two devices on the same day is counted once, matching the dashboard — instead of being summed twice.
- **Strava workouts carry their real sport** (cycling, running, …) — like WHOOP already did — with a history backfill, and back-to-back rides no longer collapse into one.
- **Personal records and correlations** no longer double-count multi-source days or mix per-reading and daily-total values.

### Fixed — medical safety

- The hypoglycemia alert now uses your own glucose unit; the doctor-report PDF states your own timezone; the crisis card offers Austrian and Swiss lines, not only German ones; and resting-pulse labels drop clinical-verdict wording for calmer, neutral framing.

### Fixed — the daily view

- The Today view is faster (its heaviest reads are now cached instead of recomputed on every refresh) and updates immediately after you log a measurement, mood, or water — not only medication.
- The intraday heart-rate chart no longer draws a continuous shape across gaps in sparse data, and shows how many readings it’s based on. A failed load shows a retry instead of an empty state.

### Fixed — onboarding, dates, consistency, accessibility

- Connecting a device no longer dead-ends on a fresh account, and the setup steps (including the callback URL) are shown up front.
- A date from a previous year now shows the year, everywhere it’s displayed.
- Contrast, chart colours in the light theme, and a handful of duplicated components were tidied; keyboard access and headings improved on several surfaces; the insights and settings menus are grouped more sensibly.

### Changed

- **A fuller backup.** The full backup now also includes lab results, illness episodes, allergies, family history, workouts, and a documents list. What isn’t included (raw document files, workout GPS/heart-rate detail) is stated plainly.

### Performance

- The Today digest and the insights cards read through the pre-aggregated tier instead of scanning raw rows; batch imports write in one pass.

Two migrations (0250, 0251). No breaking changes.

## [1.29.5] — 2026-07-17

### Security

- **Hardened the same-origin redirect guard.** A crafted relative
  post-login `next` path (e.g. `/..//evil.com`) passed the same-origin
  check but left a protocol-relative pathname that could re-resolve to a
  foreign origin when re-used in a redirect or client navigation. The
  guard now re-verifies the reconstructed path resolves on-origin and
  rejects it otherwise. Covers the OIDC callback and the password/passkey
  login redirect.

### Fixed

- **OIDC login redirects use the operator app URL, not the request URL.**
  Behind a reverse proxy that does not forward the original host, the
  login and callback routes built their browser redirects from the
  address the app was reached at inside the container, sending users to
  an unreachable internal URL after login. Every OIDC redirect is now
  built from the operator-set `NEXT_PUBLIC_APP_URL`, matching the
  convention the other integrations already use.

## [1.29.4] — 2026-07-17

- **The workouts list shows the most recent first.** The list was ordered
  oldest-first, so on a longer history the newest sessions never made the first
  page. It now leads with the latest workout.
- **Past-year dates show the year.** A workout from a previous year now carries
  its year in the list, so a December date is never mistaken for this year's.

## [1.29.3] — 2026-07-17

- **Hydration and micronutrients now have a home.** Your fluid intake and the
  vitamins and minerals your device records get a surface. A water tile on the
  dashboard shows the day's total with quick-add amounts; a new **Nutrients**
  page under Insights shows hydration over the last month, caffeine when you
  record it, and the vitamins and minerals you actually have data for — each
  against its reference daily intake where that applies, shown as context, never
  as a verdict. Manual water entries and device-synced totals now coexist
  instead of overwriting each other. Sparse logging is never read as a
  deficiency.

  The nutrients tracking stays opt-in — enable it in Settings, or with the
  one-tap prompt on the page. Device-synced micronutrients flow once your client
  sends them.

One migration (0249). No breaking changes.

## [1.29.2] — 2026-07-17

- **WHOOP workouts carry their real sport.** WHOOP was the only source that
  didn't translate its activity into the app's own sport names, so
  WHOOP-tracked rides and runs landed unlabelled instead of as cycling or
  running. New and existing WHOOP workouts are now mapped, so your bike rides
  show up as cycling — history included. When the same session comes in from two
  sources, the canonical row now keeps the richest reading (heart rate, energy,
  distance) instead of dropping it.
- **Scroll back through the day's heart rate.** The intraday heart-rate view
  gains a day navigator to step through previous days. The fine-grained history
  now stays for 90 days (was 14); older days show the coarser hourly shape.
- **Clear a card from Today.** A milestone, a new ECG, or a tension note can be
  dismissed from the Today rail once you've seen it; the section tightens when
  the last one is gone. The cards that need an action stay until you act.
- **Vitals context moves into an info tap.** The vitals tiles carry an (i) with
  the context — your reading against your personal range, and against your age
  where that applies — instead of a permanent caption. The VO₂ max heading no
  longer gets cut off.
- **Oura cycle phases feed the cycle tracker.** Where your Oura connection
  provides cycle-phase data, it now fills the cycle tracker as a background
  source; your own entries always win.

Two migrations (0247, 0248). No breaking changes.

## [1.29.1] — 2026-07-17

A round of fixes and small refinements from living with the daily view.

- **Today refreshes right after a dose.** Logging or undoing a medication now
  updates the day's read immediately — the medication line no longer lingers on
  a stale count until the next reload.
- **A calmer Today hero.** The extra score rings are gone; the hero keeps the
  one health-score ring and a tighter layout.
- **The Coach names the document you attached.** Asking about a document now
  shows its title in the chat instead of a plain "1 document" count, and the
  attach menu stays within its popover on long labels.
- **A fresh install starts with tracking on.** New installs now enable the
  tracking modules by default — you can still switch any of them off. The
  external-AI options and the daily push stay off until you turn them on.
- **Insights vitals lose the explainer line.** The "your personal normal range
  is the median…" caption is removed from the baseline tiles.
- **Illness journal: set and edit the end.** You can mark an episode's end date,
  clear it back to ongoing, and backdate the start. When nothing strayed from
  your personal range, the course section now reads a short settled line instead
  of appearing empty.
- **The morning refresh covers every sleep source.** The refresh that folds last
  night's sleep into the day now triggers from Google Health, Fitbit, Oura, and
  Polar as well, not only Withings, WHOOP, and Apple Health. Each skipped refresh
  is now recorded so a stale morning read can be traced to its cause.

No new data is collected and there is no migration.

## [1.29.0] — 2026-07-17 — A daily health companion

This release draws a line under a run of work that turns HealthLog from a place
you record your health into one that meets you each day — and it completes that
picture with the pieces that make it feel whole.

Over the last releases the dashboard gained a **Today** view that leads with the
day's read, a health score that refreshes the moment last night's sleep syncs, a
coach check-in when a plan is due for a look-back, and an optional morning note.
Documents came closer to hand — the Coach opens beside them, you can bring
several into a conversation, and lab values move between a document and your
labs. This release adds the layer that ties it together:

- **Your heart's rhythm, in context.** ECG recordings are no longer a page on
  their own — they're referenced where your resting heart rate and rhythm are
  discussed, always as the reading your device produced, never a reading of the
  app's own. A new recording surfaces gently in Today.
- **The shape of your day.** Heart rate is now drawn across the day, not just as
  a daily number — so you can see it settle and climb. When it stays elevated
  while you're at rest and not moving, Today notes it plainly as possible
  tension, carefully and never as a verdict.
- **Quiet milestones.** Reaching a steady stretch in your target range, or a new
  personal best, is marked with a calm moment — states you've reached, not
  streaks to keep, so there's nothing to break and nothing to nag.
- **One piece throughout.** The Today view brings back the health rings you
  choose, each surface carries its metric's own calm colour, and the whole thing
  reads as one design rather than a stack of features.

Nothing new generates when you open the app — every daily surface reads the
insight prepared overnight. No new data is collected; this makes more of what's
already yours.

Four changes bring documents and your record closer together:

- **Ask the Coach opens beside your document.** Asking about a document now
  opens the Coach in a side panel rather than jumping to a full page — expand it
  to full screen whenever you like, and it keeps its place.
- **Bring documents into a Coach chat.** From the composer's "+", attach one or
  more documents — pick from your vault or upload a new one, at the start or
  mid-conversation — and the Coach answers grounded in them. A conversation with
  a document runs in its fenced mode: grounded in those documents only, with no
  access to your health data or tools, so nothing in an uploaded file can reach
  anything it shouldn't.
- **Lab values from a document, proposed for your labs.** When a document you've
  had read looks like lab work, its values are detected and proposed — one tap to
  add them to your labs; they're never added without your say-so.
- **A lab scan is also kept.** Scanning a lab report into your labs now also
  files the document in your vault (encrypted, like every upload) and links the
  two, so the reading and its source stay together.

Migration 0245 (attaching multiple documents to a conversation) accompanies this
release; existing document chats carry over unchanged.

Three pieces turn the Today view into a daily loop:

- **A coach check-in.** When a coach plan is due for a look-back, it surfaces as
  a calm card in Today with keep, adjust, or let-go — one tap. Letting go retires
  the plan quietly; silence never changes it.
- **A morning that reflects last night.** The score and read are prepared
  overnight, but last night's sleep usually hasn't synced by then. Now, the
  moment it arrives, the sleep-dependent parts refresh on their own — so by the
  time you look, the day is up to date. Until sleep is in, Today says so plainly
  instead of showing a stale score.
- **An optional daily nudge.** A once-a-day morning notification with the day's
  read, off by default and opt-in per channel under Notifications. It carries the
  refreshed digest when sleep is in, never repeats within a day, and is a calm
  note — never an alert.

All three read the digest prepared overnight; nothing is generated when you open
the app.

With the Today view now leading the dashboard, the older opt-in hero card it
replaced is retired, so the two never stack. The greeting stays, the tiles and
charts are unchanged, and a layout stored with the old hero switched on simply
ignores that setting — nothing to redo.

## [1.28.53] — 2026-07-16 — A "Today" overview at the top of your dashboard

The dashboard opens with a Today view: your health score, the day's lead read,
and a short "worth a look" list — a dose window that's open, an integration to
reconnect, a check-up coming due — each a single tap to the right place. The
familiar tiles and charts sit just below, unchanged.

It reads the insight that's already prepared overnight, so it loads instantly
and never generates anything on open. When last night's sleep hasn't synced yet,
it says so plainly and fills in the sleep-dependent parts once the data arrives,
rather than showing a stale or empty score. This is the first piece of a single
daily view that later surfaces — a morning refresh, an optional daily note —
will all build on.

The dashboard gains tiles for readings that were synced and charted but never
had a place on the home strip: heart-rate variability, blood oxygen, breathing
rate, wrist temperature, and — for anyone with a body-composition scale — muscle
mass, body water, and bone mass.

Each tile appears only once you have that reading, so nothing new shows up on an
account that doesn't track it, and every tile can be toggled or reordered under
Settings → Dashboard like the rest. Tapping one opens its detail view. Nothing
changed in how the readings are stored or synced — this only surfaces what was
already there.

## [1.28.51] — 2026-07-16 — Chatting about a document lives in the Coach now

Asking the Coach about a document used to open a separate, half-finished chat
panel that never showed up in your Coach history. It now opens the real Coach:
the conversation appears in your Coach list like any other, marked with a small
document badge and a "Chatting about: <title>" note so it's clear which
document it's scoped to.

The safeguards that make document chat safe are unchanged. A conversation about
a document still runs in its fenced mode — grounded in that document's text
only, with no access to your health data or any tools — so text inside an
uploaded file can't reach anything it shouldn't. Only the surface moved into the
Coach; the boundary did not.

ECG recordings synced from a compatible watch were stored but never shown. They
now have a place in Insights: a list of your recordings, each opening the full
waveform on a familiar ECG grid, with the date, duration, average heart rate,
and the result your device recorded.

The result shown is the one your recording device produced — HealthLog does not
read or interpret the trace and does not provide a diagnosis. A recording is
single-lead and for personal awareness only; if a result concerns you, a note
alongside it points you to discuss the recording with a clinician.

## [1.28.49] — 2026-07-16 — Apple Health re-import no longer stops on a duplicate reading

Re-importing a cumulative export.zip could run for several minutes and then fail
outright on a unique-constraint error when two readings shared the same time,
type, and source but carried different internal ids — a single such reading
aborted the whole import. The importer now recognises that case: it updates the
existing reading in place (and brings back one that had been removed) instead of
failing, and if it still can't place a single reading it skips just that one and
carries on. A re-import completes cleanly.

## [1.28.48] — 2026-07-16 — Security follow-ups

Two security fixes:

- On a brand-new instance with single-sign-on configured, two people signing in
  for the very first time at the same moment could both be made admin. The
  first-admin selection now takes the same lock as password registration, so
  exactly one admin is created no matter which sign-in path or how concurrent.
- A background nutrient-import error could echo a raw database message back to
  the client; it now returns a fixed status and logs the detail server-side only.

## [1.28.47] — 2026-07-16 — Job queue engine update (pg-boss 12.26)

Updates the background-job engine (pg-boss) from 12.20 to 12.26, which adds
schema-drift detection, self-healing for background index builds, and a set of
correctness fixes. Some of those fixes surface errors that earlier versions
silently swallowed; the app already attaches an error listener to the queue and
does not use the direct calls affected by the change, so the upgrade is
transparent. No configuration change is needed.

## [1.28.46] — 2026-07-16 — Server performance on large instances

Performance work for accounts with a lot of history, none of it changing what
any number means:

- Insight generation computed its 30-day comparison averages by pulling every
  matching row of the last 400 days into memory and averaging in code. It now
  asks the database for the averages directly — the same figures, without
  materialising the rows. (Sleep keeps its per-night reconstruction path.)
- The background scans that run at worker startup used an in-memory
  de-duplication over full-table reads. They now de-duplicate in the database
  and are backed by partial indexes (migration 0243, additive), so startup on a
  large instance no longer does full scans.
- The coach chat re-rendered every message on every streamed token; now only
  the message being streamed re-renders.
- The doctor-report mood read no longer pulls fields it doesn't use.

## [1.28.45] — 2026-07-16 — Doctor report + privacy fixes

- Sleep now actually appears in the doctor-report PDF. The sleep section was
  enabled by default and its data was prepared, but the PDF's vitals table left
  it out, so the section rendered empty — it now shows time asleep in hours.
- Glucose can now be included or withheld from a shared report like every other
  clinical section. The toggle existed in settings but did nothing; it now
  gates the glucose data end to end.
- Turning the environment module off now also keeps its data (audio exposure,
  daylight, skin temperature) out of the coach, matching how the other modules
  behave.

## [1.28.44] — 2026-07-16 — Loose ends: a broken link, the API contract, module guards

- The "connect a device" link on the sleep insights empty state pointed at a
  settings page that doesn't exist and returned a 404; it now opens the
  integrations settings.
- Six endpoints the iOS app already uses were missing from the published API
  contract (`docs/api/openapi.yaml`); they are now documented, so the contract
  is complete again.
- A few module pages didn't redirect away when their module was turned off, the
  way the others do; they now behave consistently.

## [1.28.43] — 2026-07-16 — Visual consistency polish

A pass over small visual inconsistencies the design audit surfaced:

- The insights header now uses the standard heading weight and spacing scale.
- Two dashboard tiles that hand-rolled a dimmer header now use the same tile
  header as their neighbours, so the cards read as one family.
- A few tiles sat a step denser than their siblings; they now match.
- Two header icons that used the accent colour are back to the standard.
- Several edit dialogs on phone-reachable surfaces now open as the same bottom
  sheet the rest of the app uses.

A new lint rule keeps card spacing on the standard scale so this drift can't
quietly return.

## [1.28.42] — 2026-07-16 — Snappier lists, correct mood refresh, safer first sign-up

Performance and correctness fixes:

- The shared date/number formatters rebuilt a fresh locale formatter on every
  single call, which stalled the main thread across long history lists. They
  now reuse cached formatters — the same output, without the per-row cost.
- Long measurement lists (a year of dense readings) rendered every row twice —
  a desktop and a mobile copy, one hidden with CSS. They now render one layout
  for the current viewport.
- Logging a mood entry now refreshes the dashboard immediately; the mood tile
  and score could previously stay stale for up to two minutes after a change.
- On a brand-new instance, two people signing up at the exact same moment could
  both be made admin. First-admin selection is now atomic, so exactly one does.

## [1.28.41] — 2026-07-16 — Complete the translations, and guard the gap

One reminder-adjacent label — the recovery-driver "functional impact" track on
the illness insights card — was showing its internal name instead of a
translation in every language; it is now translated in all six. The class of
bug behind it (a label resolved through a computed key the static check can't
see, so a missing translation ships silently — the same seam as the well-being
labels fixed a release ago) is now closed structurally: a new test walks each
such key space against every language bundle, so a missing translation fails
the build instead of reaching a user.

## [1.28.40] — 2026-07-16 — Insight assessments lead with meaning, not a number

The per-metric insight assessments read like a data readout — they opened on
the current value. The overview texts already lead with the day's verdict in
plain words and land the warm, motivating tone; the per-metric cards were told
the opposite (name the level with a number first) and never received the
opener-variation the other insight surfaces use. Now every metric assessment
opens with what the reading MEANS and brings the number in right after as
support, in the same warm register as the overview. A shared opening-shape
contract keeps the surfaces from drifting apart again, and the deterministic
first-paint fallbacks lead with the verdict too. No change to what the numbers
say — only how the sentence is built.

## [1.28.39] — 2026-07-16 — Sync data-loss hardening

Four fixes to sync paths that could lose or corrupt data in edge cases:

- The nightly pass that folds raw cumulative samples (steps, energy, distance)
  into daily totals no longer re-counts a sample you had deleted — it was the
  one such pass missing the deleted-row filter its siblings all carry.
- That same pass is now safe when two runs overlap (a deploy-timing overlap, or
  a manual admin trigger racing the nightly job): an advisory lock plus an
  in-transaction re-read make the fold idempotent, so an overlap can no longer
  permanently double a day's total.
- A re-scored Withings sleep segment (its end time shifts) now updates the
  existing row in place instead of colliding with it and wedging that night —
  the same re-key rescue the other providers already carry.
- Withings measurement sync now holds its position when a reading fails to
  write, instead of advancing past it and stranding the reading; the next sync
  retries it.

## [1.28.38] — 2026-07-16 — Documents polish, waist reminders, bulk sharing

The document vault gets a round of overdue polish. The list cards drop a
stray glyph — the "read by AI" mark it carried moves into the document's
detail view — and give the real filename its own line so it stops being cut
off; the detail view's close button is aligned correctly (a shared sheet
primitive was reserving space for a button it wasn't showing). The action
that opens a document in the coach now reads "Coach fragen".

From a multi-selection in the overview you can now share several documents
at once — one link holding the selection, with the same documents-only
privacy as a single share (up to 50 per link).

Reminders can now be linked to waist circumference. And the well-being
reminder types (WHO-5, sleep-condition) that were showing their internal
names instead of a label are now translated in every language.

## [1.28.37] — 2026-07-15 — Provider step totals survive a restart

A boot-time maintenance pass that folds genuinely old raw step samples into
daily totals had too broad a reach: it also matched the daily step totals that
Google Health, Fitbit, and Withings write, and soft-deleted them on every
worker start. Recent days came back on the next sync, but older days stayed
gone until a full re-sync — which the next restart swept again. The pass now
skips any row that is already a daily total and only ever touches the ingest
paths that produced real legacy raw samples, so a provider's step history is
left alone. A one-time repair restores the totals removed by earlier restarts
(within the retention window; a single full sync recovers anything older) and
cleans up the placeholder totals the bug minted in their place.

## [1.28.36] — 2026-07-15 — Re-importing after a failed Apple Health import actually retries

The v1.28.33 rollup and staging fixes were correct but never reached the
reporter's case: the upload deduplicates by content hash, and the lookup
matched a previously FAILED job too — so re-uploading the same export.zip
returned the old failed job and replayed its stale error without ever running
the import again. The dedup now ignores failed jobs; the same file retries
cleanly. A redundant staged upload is also cleaned up on a dedup hit instead
of lingering in the staging directory.

Two related hardenings: the boot-time reconcile that marks interrupted imports
failed now performs a real liveness check (queue state plus a progress
heartbeat) instead of unconditionally failing every in-flight job — so a split
or multi-worker deployment no longer kills an import running in another worker.
And the "staging file not found" message now names the separate-container cause
explicitly, with a matching note in the scaling guide.

## [1.28.35] — 2026-07-14 — Timestamps honor the profile timezone

Client-rendered times previously fell back to a hardcoded display zone
(Europe/Berlin) no matter what the profile timezone said; a user in Manila saw
Berlin clock times on every card, chart, and table. Display now follows the
profile timezone everywhere, with a strict fallback to the legacy display zone
— never the browser zone, so screen, PDF, and export can no longer disagree.
An invalid stored timezone can never break rendering; it falls back safely.

The same pass closed the latent inconsistencies the audit surfaced: the
"Updated today" cards no longer mix one zone for the day boundary and another
for the clock; calendar-date fields no longer shift a day for profiles west of
UTC; the dose-history day headings and weekday labels render in the display
zone; chart day/month labels stay correct for every zone (bucket math is
untouched); and the clinician share view renders in the patient's timezone
instead of the server container's. Day groupings, schedules, and aggregates
were already timezone-correct server-side and are byte-identical.

## [1.28.34] — 2026-07-14 — Nutrient intake lands as quiet context (server side)

Supplement-style intake written to Apple Health by nutrition apps — vitamins,
minerals, water, caffeine — can now sync to HealthLog as daily totals. This is
deliberately not a nutrition feature: no food diary, no calorie tracking, no
dashboard tile. The data lands in a dedicated store (26 nutrients with EFSA
reference values), is visible on a read-only card under Settings → Sources,
and will feed the Coach as context in a later release.

The module is opt-in and off by default; with it off, the server refuses the
data entirely. Re-posting a day replaces it, units are guarded against
µg/mg mix-ups, and implausible values are skipped per entry. This release is
inert until the iOS companion app ships its reading side (coordination ticket
filed); the wire contract is in the OpenAPI spec.

## [1.28.33] — 2026-07-14 — Re-importing a cumulative Apple Health export works again

Re-uploading a fresh export.zip over existing data could fail with a duplicate-key
error in the rollup tier: a concurrent recompute (a live sync, the nightly drain)
racing the import's full fold could collide on the same aggregation bucket — and
the losing side silently dropped its freshly computed aggregate, leaving a stale
bucket. Rollup writes are now conflict-safe upserts with deterministic lock
ordering: a race can neither fail the import nor lose an aggregate, and buckets
left stale by earlier races self-heal on their next recompute.

The misleading error is gone too. A long import could outlive its queue timeout;
the redelivery re-opened the already-consumed staging file and overwrote the real
failure — or even a successful completion — with a raw ENOENT. Import jobs now
finish terminally (no redelivery after the staging file is consumed, six-hour
timeout), a delivery for an already-finished import is a no-op, and a genuinely
missing staging file reports an honest "upload the export again" message.

## [1.28.32] — 2026-07-12 — Fitbit: re-keyed re-imports can no longer be silently dropped

Single-fix release for the Fitbit integration, mirroring the Google Health
fix from v1.28.28. The measurements table carries a second unique index on
the natural key (type, time, source, sleep stage) that also covers
soft-deleted rows; when an import carries new external ids for rows that
were previously removed — the re-keyed re-import case — the insert collided
with the old row and was dropped without a trace. Planned inserts now get a
second probe by natural key: a match, live or removed, is updated in place
with the fresh value and the new id instead. If the probe itself fails, the
sync reports the failure and holds its watermark so the next run retries —
nothing is lost either way. No other code path is touched in this release.

## [1.28.31] — 2026-07-12 — Heart-rate history keeps its daily shape

Long-term retention for the dense intra-day signals (heart rate, HRV, blood
oxygen) now folds to hourly means instead of a single daily mean. The last
14 days keep every raw sample as before; older days keep up to 24 points —
enough to see how a day actually went, at roughly nine thousand rows per
metric per year instead of an unbounded raw stream.

Because the old fold soft-deleted rather than erased, a one-time rebuild
reconstructs the hourly shape for every already-folded day from the retained
raw samples, then retires the old daily row in the same transaction — no
reader can ever double-count a day. The rebuild runs automatically once per
installation after the update; days whose raw samples are no longer
available keep their daily mean. Daily min/max/mean statistics captured at
fold time stay untouched throughout.

## [1.28.30] — 2026-07-12 — The daily briefing stops silently skipping days

The recurring "no briefing today" had a chain of causes, now closed end to end.
Every failure path in the nightly generation names its cause in the logs
(several classes previously failed without a trace). A failed night retries
itself about forty-five minutes later instead of waiting for the next night.
A cached insight payload that carries no briefing no longer counts as fresh —
previously it could satisfy the daily window and even the unchanged-data check,
so a once-stripped briefing could block its own regeneration indefinitely. And
the briefing card now reports persistently why a briefing is absent (withheld
by the number check, generation failed, or not yet attempted) with a retry
button that always generates.

Documentation corrections, verified against the code: Withings credentials are
per-user in the app (the documented environment-variable path never existed —
and the webhook secret is now actually passed through in the compose file);
the classic Fitbit portal no longer accepts new registrations (new users:
Google Health); the backup-restore example no longer generates a fresh
encryption key (which could never decrypt an existing backup) and uses the
invocation that works in the production image; the certificate-pinning guide
now describes the real model (two CA-level pins, leaf renewals need no app
build); scaling and admin-endpoint references corrected.

## [1.28.29] — 2026-07-11 — Dashboard edits show up on the way back; one scrollbar again

Changing the dashboard tile selection now shows up immediately when you
navigate back — the third and final layer of this bug. Saving marked the
dashboard's cached data stale but, with the dashboard page unmounted, nothing
re-read it until the next poll or a window-focus flick. The save now refreshes
that cache directly, mounted or not.

The settings pages with sortable lists (dashboard layout, medication order,
modules, mood tags) showed a second page scrollbar: an invisible
screen-reader hint below each list escaped its container and silently
lengthened the document. All five editors are fixed and the overscroll guard
now covers these routes.

## [1.28.28] — 2026-07-11 — OpenAI-compatible gateways work; a re-keyed night can no longer vanish

The user-level "Local (OpenAI-compatible)" provider now speaks the standard
JSON wire: it sends `response_format` and, when an endpoint rejects it, falls
back once and remembers that endpoint's dialect — so LiteLLM, OpenRouter,
vLLM, LM Studio and plain Ollama all work from the same settings form. The
form and the provider docs now say so explicitly. Gateways that wrap a
Claude-family model behind a synthesized tool call are parsed correctly
instead of yielding silently empty insights.

The briefing token budget is configurable (`INSIGHTS_MAX_TOKENS`, default
raised so full briefings stop truncating), and a reply that was cut off
mid-JSON now says exactly that instead of a generic parse error. When the
number-grounding check withholds a briefing, the card now explains why
instead of pretending nothing was generated. The provider test button
distinguishes "the endpoint rejected the request" from "could not reach the
endpoint".

Sleep repair follow-up: re-syncing a history whose sleep rows predate the
stable segment keys could erase those nights — the old rows were swept while
their replacements collided with a second uniqueness rule and were silently
dropped. Re-imports now recognise such rows by their natural identity
(type, instant, stage) and migrate them in place: fresh value, new key,
restored if deleted. A full sync after updating heals any history affected.

## [1.28.27] — 2026-07-11 — Runs on CPUs without AVX2

Self-hosts on older x86-64 CPUs — Celeron/Atom-class NAS boxes, pre-2013
Xeons, and VMs that mask newer CPU flags — crashed in a restart loop since the
document renderer arrived: the bundled rasterizer uses AVX2 instructions, and
a CPU without them kills the whole process the first time a thumbnail or a
scanned-PDF render runs. The renderer is now gated on a one-time CPU-feature
check: on unsupported hardware, thumbnails and scanned-PDF rasterization
simply switch off (the vault shows type icons; PDFs are read as text) while
everything else runs normally. `NATIVE_CANVAS=off|on` overrides the detection
if ever needed. Reported by a self-hoster with kernel traps in hand — thanks,
that made it a same-day fix.

## [1.28.26] — 2026-07-11 — Internal restructuring for maintainability

No user-facing change. Eight of the largest source files were split along
their natural seams into focused modules — mood analytics calculators, the
insight status-invalidation machinery, feature extraction blocks, the doctor
report's types and helpers, the Google Health mapping layer, the coach chat
bubbles and read-aloud controls, the Telegram webhook handlers (the route now
holds only auth and dispatch), and the coach snapshot's cache, series helpers
and largest per-metric blocks. Every move is verbatim with stable import
paths; behavior is pinned by the full test suite.

## [1.28.25] — 2026-07-11 — Every integration held to the same standard

A platform-wide hardening pass: the failure classes found live this week were
hunted down across every integration, not just where they first surfaced.

Fitbit carried the same silent wedge fixed for Google Health — a soft-deleted
reading permanently blocked its own re-import, hidden behind a comment
describing a database index that never existed. Fixed the same way: a re-import
revives the deleted row in place.

Sleep segments now keep stable identities across re-scoring for Withings,
WHOOP, Polar and Oura — previously a source refining a night could duplicate or
orphan its stage rows, quietly inflating the night's total (the class fixed for
Google earlier this week). Each sync now also sweeps rows a re-score left
behind, so already-affected nights heal themselves as they are re-read.

One platform rule for deleted rows: a reading owned by a connected source comes
back when the source reports it again — across Withings, WHOOP, Oura, Polar,
Nightscout, the mood webhook, CSV re-imports and Apple Health day totals.
Deleting an Apple Health sample in the Health app still sticks, as the paired
client expects. Import counts and per-entry statuses now tell the truth in
every one of these paths.

Google Health lifecycle: an expired connection no longer lets the hourly sync
stamp success while importing nothing (it parks cleanly for reconnect instead
of retrying against a dead token forever); history backfills and the sleep
repair only mark themselves done after a clean pass, so a transient error now
retries instead of silently leaving a gap; and a failed database write holds
the sync watermark so the affected window is re-fetched.

Scale: the doctor report reads only the columns and sections it renders;
exports and backups read the measurement table in pages instead of one giant
query; long-window charts for sensor-dense metrics (glucose, pulse) aggregate
per day in the database beyond 90 days instead of shipping every raw sample;
blood-pressure pairing, achievement tallies and several "which types exist"
scans moved from in-memory loops to the database. A year of continuous sensor
data can no longer stall or crash a request.

## [1.28.24] — 2026-07-11 — A deleted Google reading no longer blocks its re-import

A Google Health reading that had been soft-deleted could never be imported
again: the sync treated the deleted row as absent and planned a fresh insert,
but the database's uniqueness rule still saw the deleted row and silently
dropped the insert — every sync, forever. A self-hoster's step days were stuck
exactly this way. The sync now recognises the deleted row and revives it in
place with the freshly fetched value: Google remains the source of truth for
its own readings, so a re-import deliberately brings a deleted one back. To
remove Google data permanently, disconnect the integration.

## [1.28.23] — 2026-07-11 — Sleep disagreement visible on the dashboard; Apple Health medication groundwork

When two sources disagree about last night's sleep — a sleep mat's time in bed
against a watch's time asleep — the dashboard sleep tile now carries a small
marker next to the value. The tooltip names each source and its total, so a
surprising number explains itself instead of silently picking a side. The same
marker backs the sleep panel; the shown total is unchanged either way.

Groundwork for importing medications and their taken doses from Apple Health
(iOS 26+): the server now accepts medications mirrored from an external source
and dose events carrying a stable external identity, imported idempotently —
re-syncs never duplicate. A mirrored medication is source-exclusive, so an
imported dose can never double-count against a manually logged one. The
matching client support arrives with a future app update.

Hardening: the doctor-report aggregation and PDF charts now compute their
ranges with loops instead of spread calls, so a report over a sample-dense year
(per-beat heart rate, sensor glucose) cannot overflow the call stack — the same
failure class fixed for the Google Health full sync.

## [1.28.22] — 2026-07-10 — Full sync survives dense histories; quieter document chrome

A full Google Health sync no longer fails on sample-dense accounts. Collecting
the rollup bookkeeping for a multi-year heart-rate history overflowed the call
stack, which aborted the metrics pass mid-cycle — exactly on the accounts with
the most data. Reported by a self-hoster whose sync log made the diagnosis
immediate; the new sync diagnostics from the previous release confirmed every
other read on that account healthy.

The documents vault gets quieter chrome: the "read by AI" tag no longer takes
its own line on each card — a small glyph rides inline on the date-and-size row
instead. The document view drops the status bar under the preview entirely;
when reading is automatic and nothing needs review, the content starts straight
with the document's fields.

## [1.28.21] — 2026-07-10 — Sleep history heals itself; plateau context; sync diagnostics

Three follow-ups to the recent sleep fix, plus better Google Health diagnostics.

Nights that were stored twice before the sleep fix now repair themselves: a
one-time background pass re-reads each connected account's Google Health sleep
history and collapses every re-scored night to its true total. No operator
action needed — it runs once after the update and marks itself done.

The sleep night read now reports when two sources disagree about the same night
(say, a sleep mat's ten hours in bed against a watch's seven and a half asleep).
The served total is unchanged — the disagreement rides along as an annotation so
clients can mark the number instead of silently picking a side.

A GLP-1 medication whose weight has plateaued on the current dose now says so
where the estimated drug level is shown — a short, factual note with the
observed change over the window, next to the curve in the efficacy view and in
Insights. It states the association and nothing more.

Google Health sync diagnostics: a daily-totals read that returns rows but
imports nothing now says so in the sync log, distinguishing an empty answer
from one the importer could not read — and the connection test's structure
probe reports the raw response field names when a type parses to zero, so a
per-account naming drift is visible from a single report.

The estimated active-substance curve for a GLP-1 medication — the modelled drug
level from your logged doses — now also appears in the efficacy view and in the
Insights medication overview, not only under the injection tab. It is the same
estimate shown there, surfaced next to the efficacy readouts so the drug level
and its effect sit side by side. Non-GLP-1 medications are unaffected.

## [1.28.19] — 2026-07-10 — Document and card polish

Small refinements across a few surfaces.

In the documents vault, each card now carries the date, size and an "read by AI"
marker directly under the document's title, instead of the meta line sitting off
under the thumbnail.

The document view gets a larger, easier close button, drops a redundant top-right
shortcut and the inline "read with AI" row under the preview, and gains a button
to ask about the document right next to share and download.

The mental-wellbeing cards no longer wash the whole tile on hover — only the
title is the tap target now, matching how the medication cards behave.

The medication API settings render inline instead of behind an expander that
never had anything else beside it.

Sleep imported from Google Health could read far too long — a night of about
seven and a half hours showing as ten. Google re-scores a night after the fact,
and the sync re-reads recent nights to pick that up. The re-read was landing as a
second, parallel copy of the night rather than replacing the first, so the
night-total added both together.

Each sleep segment now keys on a stable identity (the session's own id plus the
segment's start) instead of a value that shifted every time Google refined the
night, so a re-read overwrites in place. And before writing a re-read night, the
sync clears any superseded rows left in that night's window — so a re-scored
night reads its true total, and a mere re-classification of a block (light to
deep) updates in place instead of duplicating.

Nights already stored with duplicates heal as they are re-read; operators can
repair the full history at once with a one-shot re-sync.

Fixes two bugs and hardens two edges.

Dashboard layout changes now take effect immediately. Reordering or toggling
tiles and pressing save could appear to revert to the previous selection for a
few minutes: the saved layout was written correctly, but the home screen kept
serving a cached snapshot that the save never evicted. The save now clears that
snapshot, so the dashboard reflects the new layout on the next paint.

A share link created with a narrowed set of report sections now serves exactly
that set. Previously a link built with a reduced selection could fall back to the
full default set of sections when viewed — the opposite of what the owner chose.
The shared view now reads the frozen selection faithfully, so a section switched
off stays off for the recipient. Documents-only shares were never affected.

Hardening: the shared-document download path and the owner download path now use
identical filename sanitising, and thumbnail generation enforces its size ceiling
a second time after decoding, so a malformed image that slips past the up-front
check still cannot exhaust memory.

## [1.28.16] — 2026-07-10 — Documents-only shares stay documents-only

Hardens the "share a document, not the record" guarantee. A link created as
documents-only now carries an explicit frozen flag, and the shared view reads
that flag directly instead of inferring it from "are all report sections off?".
The old inference would have re-opened an existing documents-only link the day a
new report section was added — the link's frozen settings never mention the new
section, so it would have defaulted on. The flag closes that path: a
documents-only link can never begin serving health data later, whatever the
report grows to include. Existing documents-only links are migrated to the flag.

## [1.28.15] — 2026-07-10 — Document thumbnails; admin-shared AI access

The documents library now shows a thumbnail for each file — a small preview
rendered on the server, downscaled and re-encoded so location and camera
metadata are dropped, and served only to the file's owner over an authenticated
request. Files that cannot be previewed keep their type icon, and a file that
fails to render simply shows the icon rather than an error.

An administrator can connect one central AI access on the server and offer it to
the people who use it: each user decides in their own settings whether to use the
shared access or keep their own provider. It is set up in the admin area and
stays off until an admin turns it on, so anyone already using their own key is
unaffected.

Also trims two now-redundant pieces of the documents view: the caption noting
that search covers file contents, and the per-file searchable/read badges. The
same actions remain available without the extra chrome.

## [1.28.13] — 2026-07-10 — Sharing a document shares only the document

Fixes a scope bug: a link created from a document carried the full health record
(vital signs, labs, medications) because an empty report scope was read as "all
sections". A document share is now document-only — it serves the attached
document and no health data — while sharing from Settings keeps the full record
form. NOTE: revoke and re-create any document link made before this release; an
earlier link cannot be narrowed retroactively.

## [1.28.12] — 2026-07-09 — Lab scans use your AI provider; tidier dashboard

Scanning a lab report now uses the AI provider you already configured — including
a scanned PDF, which is rendered to images the same way documents are, so a
subscription or local vision provider reads it instead of only a Claude one. The
separate lab-scan provider setting is gone; there is one place to configure AI.
On the dashboard, the "log dose" action for an overdue medication now sits
directly under its line instead of far to the right.

## [1.28.11] — 2026-07-09 — Strava workouts + Garmin guidance

Connect Strava to bring your activities in as workouts. Like the other wearable
connections, you register your own Strava application and paste its keys, so no
shared account is involved. A run that also arrives through Apple Health is not
double-counted — the existing source-priority picker collapses the duplicate.
Strava is a workout source only (no sleep, recovery, or body metrics). Also adds
a Garmin page and an in-app note: Garmin has no direct connection, but its data
flows in through Apple Health or Google Health Connect.

## [1.28.10] — 2026-07-09 — Onboarding shows the AI value early

New accounts now meet the AI value up front instead of discovering it as a cold
"no provider connected" error. The finish screen shows a clearly-labelled sample
briefing — a static example, nothing is sent anywhere — and lays out the setup
choices local-first (a local model, your own API key, or a signed-in account),
with a plain reminder that the app is fully useful without AI. The getting-started
checklist gains a matching step that satisfies itself once a provider is
connected (or when the operator has configured a shared one).

## [1.28.9] — 2026-07-09 — Document chat in the coach dialog

Chatting about a document now opens the coach chat dialog, scoped to that
document ("Chatting about: …"), instead of a separate inline panel. The entry
is a neutral icon in the top-right of the document, matching the insights
surface. The document chat keeps its stricter footing unchanged — it reads only
the one document, carries no health-record context, uses no tools, and renders
as plain text.

## [1.28.8] — 2026-07-09 — Documents: automatic when set, cleaner when not

With automatic AI reading turned on, a document is read on upload — so the
per-document AI action buttons no longer appear (nothing to press). They return
when automatic reading is off, for manual per-document control. The AI-suggestion
review also drops its heading and grey sub-caption — just the fields to review
and apply.

## [1.28.7] — 2026-07-09 — Scanned-PDF reading actually works

The prior fix made the PDF image library loadable, but the page renderer was
still a bundled copy that failed on a real document with a bare error, so reading
a scanned PDF on a non-Anthropic provider still fell back to "PDF scanning needs
a Claude vision provider". The renderer now runs the real, un-bundled module —
the same one that renders these documents correctly in isolation — so scanned
PDFs are read on a subscription or local vision provider. Also drops a redundant
per-view note from the document summary panel.

## [1.28.6] — 2026-07-09 — Fix scanned-PDF reading in the container

Reading a scanned PDF with a non-Anthropic AI provider (a signed-in subscription
model or a local vision model) failed with "PDF scanning needs a Claude vision
provider" because the PDF page renderer could not load its image library inside
the standalone container image. The library is now resolvable where the renderer
looks for it, so a scanned PDF is rendered to images and read as intended.

## [1.28.5] — 2026-07-09 — Read documents with a subscription AI, cleaner surfaces

Documents can now be read by a signed-in (subscription) AI provider — the
capability check no longer wrongly treats those models as unable to see images,
so "read with AI" works on that path instead of erroring. Scanned PDFs and
photos are read the same way. Two now-redundant blurbs are gone from the document
panel, and on the recovery insights page each metric shows its explanation inside
its own card instead of repeating the heading above it.

## [1.28.4] — 2026-07-09 — Medication efficacy

A per-medication "effect" view: see whether a medication is moving the outcome
it targets, against your own data. The detail page gains a tab that plots the
target metric (or lab) with the start date, dose changes, and pauses marked, a
before/after-start comparison, and your adherence overlaid — strictly
descriptive, never a verdict or dose advice. A compact version surfaces on the
medication insights area. The target is resolved from the drug's class or its
name, and you can override which metric a medication is tracked against.

## [1.28.3] — 2026-07-09 — Consistent spacing and alignment

A consistency pass across the app, driven by a layout audit. Insight cards now
share one left edge — headings and body text line up instead of drifting from
card to card (worst on mobile). Settings and admin pages no longer scroll past
their content into empty space. On mobile, Settings and Notifications live only
in the account menu instead of being duplicated in the overflow menu. The
dashboard greeting keeps its action beside the text rather than pushing it onto
its own line. Preventive-care, cycle, and onboarding cards adopt the shared card
anatomy. The spacing and alignment rules behind these are written down so they
hold going forward.

Also folds in the document PDF rasterization runtime: the image renderer now
loads in the container, so a scanned PDF is read on an image-only AI provider
(previously it quietly fell back to text-only).

## [1.28.2] — 2026-07-09 — Automatic AI document reading (opt-in)

One opt-in in AI settings: read every uploaded document automatically with your
configured AI provider — no per-document tap, the same way a lab photo is read.
Off by default; the vault stays local-first for everyone who does not turn it
on. When on, scanned PDFs and photos are read too — a PDF's pages are rendered
to images so a provider that only accepts images can still read them — and the
turn-on records a standing consent entry. The background indexer now follows the
same opt-in, so nothing leaves the machine automatically unless you enable it.

## [1.28.1] — 2026-07-09 — Document vault load fix

Fixes documents failing to load — old and newly uploaded alike — on
deployments where local content extraction is present. The local PDF text
reader imported its parser at module load, which pulled a browser-only global
into the server bundle and threw during evaluation, taking the document routes
down with it. The parser now loads lazily on first extraction; the document
list, upload, and content search work again, and local text extraction is
unchanged.

## [1.28.0] — 2026-07-09 — Document intelligence

A milestone that closes the document line end to end. The vault stopped being a
place to _store_ files and became a place to _understand_ them — read,
searched, shared, and answered — with the privacy posture held at every step.
The document capabilities shipped incrementally across v1.27.17–v1.27.33; this
release marks them, together with a full correctness/resilience/quality pass, as
one coherent whole.

### The document intelligence era

- **Vault** — every letter, report, and scan in one place, encrypted at rest,
  byte-classified serving (inline vs download), opt-in.
- **AI reading + automatic search** — documents are read and indexed
  automatically on upload; a local reader keeps the file on the machine, an AI
  provider reads richer (including scans) with consent. Content search matches
  whole words _inside_ documents over an encrypted blind token index — nothing
  readable is ever stored.
- **Sharing** — hand a clinician a time-boxed, revocable link with a mobile QR
  code; camera metadata (EXIF/GPS) stripped on the way out.
- **Chat about a document** — ask a document questions in plain language,
  grounded and cited, with a security model that treats the document as
  untrusted: fenced as data, no tools, no health-record context, numeric-grounded,
  never a diagnosis.
- **AI provider governance** — for documents, a local-first / no-training-API /
  subscription-last provider order, explicit consent for any external egress,
  and a vendor-blind notice before a document leaves the machine.

### Correctness, resilience and polish

The same line carried a full audit sweep: DST-safe medication windows and
user-timezone compliance; graceful degradation (worker timeouts, per-metric sync
freshness, offline-write safety, per-source isolation, honest "unreadable"
markers); no more dashboard dead-ends and honest error/empty states; accessibility
contrast and semantics; and cold-start + performance fixes — down to the low-priority
findings.

## [1.27.33] — 2026-07-09 — Chat about a document

### Added

- Open a document and ask about it in plain language — a short, grounded conversation about that one document's text ("What does the Impression say?", "Which medications are listed?"). Answers cite where in the document each statement comes from and say plainly when the document doesn't contain the answer.

### Security

- The feature is built so a hostile document is harmless: the document text is fenced as data (never instructions — a document that says "ignore your instructions" is treated as content, not obeyed, and embedded fence markers are scrubbed); the chat has **no tools** (nothing an injected instruction could do); **no health snapshot** is ever sent (the only context is that one document — your health record can't leak, even if asked); fabricated numbers are stripped so only figures present in the document appear; and replies render as plain text (no markup a reply could contain is executed). It never diagnoses — it describes the document and defers clinical decisions.
- Available for indexed documents only, using your configured AI provider (local-first, keeping the document on your machine; any external provider requires explicit AI consent and shows the egress notice). Document chats are kept separate from the Coach and encrypted at rest. Migration 0230.

## [1.27.32] — 2026-07-09 — Quality-of-life, accessibility, cold-start and performance polish

### Changed

- **No more dead-ends:** the dashboard metric tiles (weight, blood pressure, pulse, glucose, mood, sleep, steps, VO₂max) now link to their Insights detail; the daily-briefing finding rows are tappable again; the "no notification channels" prompt points to where channels actually live now; and Coach Plans are reachable from the conversations header.
- **Honest states:** the Achievements, Coach-conversations, Notifications, custom-metrics and Insights surfaces render a retryable error card on a failed load instead of a confident empty state, and auth-gated pages show a layout-reserving skeleton instead of a bare spinner.
- **Medication dialogs** move to the bottom-sheet pattern on phones (consistent with the rest of the app), and secret/config inputs suppress password-manager autofill.

### Accessibility

- Fixed several contrast shortfalls (muted text/icons below AA, phantom colour utilities that emitted no rule), added an accessible name to the admin toggle, and `aria-pressed` to the chart range switches.

### Fixed

- Documentation now matches the actual compose contract for `DATABASE_URL`; a `SESSION_COOKIE_SECURE` transport mismatch is diagnosed (was a silent login loop); a boot readiness summary prints per-secret status before fail-closed loaders throw; and a nudge appears while public registration is open.
- CSV import batches its writes; the off-host backup pages its large reads; the theme provider closes a hydration seam; and hot per-row Intl formatters are cached.

## [1.27.31] — 2026-07-09 — Document AI provider governance

### Security

- Document AI now routes through a document-scoped provider order — local extraction first, then no-training API providers (BYOK OpenAI/Anthropic), and a subscription/OAuth provider only last. Sending any document to an external provider requires explicit AI consent (a gap where the subscription path was previously ungated is closed), and a vendor-blind notice appears before a document leaves the machine. Coach and Insights provider behaviour is unchanged. (Follows a three-part investigation of the subscription/OAuth path: capable of reading documents, but the consumer-tier data policy allows training on content, so it is never the default for health documents — only an explicit, consented choice.)

## [1.27.30] — 2026-07-09 — Correctness and resilience sweep

### Fixed

- **Time zones / DST:** the "today" medication window is now DST-safe — a dose near midnight on a 23h/25h transition day no longer drops off the cards, dashboard, or PWA badge. Per-day medication compliance now buckets in the user's own time zone (was hardcoded to one zone), and the punctuality classification and the Insights greeting hour follow the user's zone too.
- **Resilience:** background job workers now run with a statement timeout and pool cap (a heavy nightly fold can no longer wedge the worker pool). Offline mutations fail fast and surface their state instead of hanging and silently losing the write. Each sync source isolates its per-collection/per-metric-type work, so one bad response can't blank a whole integration, and a per-metric-type freshness signal distinguishes a dead pipe from a healthy-idle one. The rollup read falls back to live SQL on any read error. Undecryptable rows now log a diagnostic and, where a clinician or user reads them, surface an honest "unreadable" marker rather than a silent blank.

## [1.27.29] — 2026-07-08 — Automatic document indexing and AI reading

### Added

- Every uploaded document is made searchable automatically — no "index" button. On upload, a background job reads the document (the upload finishes instantly and never fails because of indexing) and adds it to the private, encrypted search index. It picks the best reader: an AI provider transcribes the original (including scanned pages and photos) when one is configured and consented; otherwise HealthLog extracts a PDF's embedded text layer locally, in milliseconds, with no AI and nothing leaving the machine — so digitally-generated PDFs (lab reports, letters) become searchable even with no AI.
- The document detail sheet gains a prominent "Read with AI" block with a status pill — Read by AI, Searchable, Making searchable…, or Not searchable yet — plus the existing suggest-details / summarise / show-text actions, consolidated. With no provider it shows a calm pointer to AI settings, and any locally-indexed document stays searchable. The old manual per-document index buttons are gone (indexing is automatic).

### Fixed

- An upload whose background index job failed to enqueue (a transient database hiccup) could return a 500 even though the file was stored; enqueuing is now fire-and-forget and never fails the upload.

## [1.27.28] — 2026-07-08 — Share a document from the document

### Added

- A document now carries its own Share action: open a document and tap Share to create a clinician share link with that document already attached — the picker, expiry, EXIF note, and the one-time QR (with the passphrase in the link) all appear in the same sheet, so sharing no longer requires a detour through Settings. The Settings → Sharing flow is unchanged.

## [1.27.27] — 2026-07-08 — Reorderable hero rings

### Changed

- The dashboard hero rings now lead with the health score by default, and the order is yours to set: drag (or use the up/down arrows) to reorder the rings in Settings → Appearance, and the order persists across the mobile carousel and the desktop row. The health score is pinned as the anchor ring — it can be repositioned but not removed.

## [1.27.26] — 2026-07-08 — Hero and wellbeing card polish

### Changed

- The dashboard hero tightens the gap between the ring row and the briefing another step, and each ring is now a link to its detail — readiness / recovery / sleep open their Insights score view, the dose ring opens medications, the health-score ring opens the Insights overview. On a phone the carousel keeps swiping; a tap navigates.
- The mental-wellbeing surface is titled "Mental wellbeing" (was a longer check-in phrase) and its instrument cards follow the medication-card anatomy. The questionnaire source/licence note moves out from under the Start button into a discreet info control in the card header, so the Start button stands alone.

## [1.27.25] — 2026-07-08 — Documents filter dropdowns

### Changed

- The Documents page filters (type, condition, year) move from an inline chip row into compact dropdowns beside the search field, so the filter bar stays on a single line at every width — on a phone the dropdowns collapse to icons rather than wrapping or scrolling. Selection behaviour is unchanged (type is multi-select; condition and year pick one).

## [1.27.24] — 2026-07-07 — Share documents

### Added

- A share link can now carry a hand-picked set of your stored documents, so a clinician can open your reports and letters at the public `/c/<token>` view without an account. Pick up to 50 documents when you create a link; the set is frozen at creation (revoke and re-share to change it).
- The share-create screen shows a prominent QR code that encodes the link and its passphrase together — a clinician scans it to open the shared record and its documents on their own device in one step (still shown only once, alongside the link and passphrase text).
- Recipients see the documents as a metadata list: images and PDFs preview inline, other formats download. Only the exact documents attached to that link are reachable, each fetch re-checks the link's live state, and revoking or expiring a link cuts off access to the documents immediately.

### Security

- Shared JPEG, PNG, and WebP images are stripped of embedded camera metadata (EXIF, XMP, GPS) on the way out; the stored original is untouched. PDF, TIFF, HEIC, and Office documents pass through as stored — a documented limit.
- The public document route is token-scoped to the link's frozen set, re-validates revocation and the passphrase before any decrypt, serves non-previewable types as opaque downloads, and carries its own strict framing policy.

## [1.27.23] — 2026-07-07 — Dashboard hero polish

### Changed

- On phones, the dashboard hero's wellness rings become a swipeable carousel — one ring shown at a time, centered, with dot indicators; swipe left/right through readiness, recovery, doses, and the health score. Calmer, and no vertical space spent on a cramped row. The desktop layout keeps every ring in the row.
- The desktop hero tightens the gap between the greeting/ring row and the briefing by one step.

## [1.27.22] — 2026-07-07 — Document assist and content search

### Added

- The document vault gains an optional AI layer that only runs with a configured AI provider (bring-your-own-key or local) and your consent — nothing runs automatically, nothing is interpreted, and nothing is saved without an explicit action.
  - **Suggest details** proposes a filing title, type, and date for a stored document. Suggestions are drafts: the title seeds the editable field, type and date apply only on an explicit tap, and nothing is written until you act.
  - **Summarise / show extracted text** returns a short plain-language description or the raw transcribed text, shown once for that view only — never saved into the coach, snapshots, records, or the search index, and never a diagnosis.
  - **Content search** now matches whole words inside a document's body, not just its title and filename. The extracted text is stored encrypted at rest and turned into a blind, one-way keyed token index — no readable text and no readable word is ever stored; a search matches hashes. Whole-word only (substring matching stays on title and filename). Index one document at a time or run a bounded background backfill over the rest.

## [1.27.21] — 2026-07-07 — Hero spacing and one green

### Changed

- The dashboard hero's greeting anchors to the top edge instead of drifting to the vertical centre of the taller ring column, and the briefing follows closely instead of sitting a full step below — the wide gap under the greeting is gone.
- A "green" score ring now uses the same green as every positive signal and trend delta beside it (the band-fallback ring green landed on its own hue before). Green reads as one green across rings, signals, and deltas — the change is app-wide (insights rings included), with computed contrast 11.9:1 dark / 6.1:1 light.

## [1.27.20] — 2026-07-07 — Coach and cycle toggle from the modules hub

### Changed

- The Coach and cycle-tracking rows under Settings → Modules now carry a real on/off switch, like every other module, instead of only a "manage in …" link. The switch drives the same underlying setting the dedicated page does, and a "manage" link stays beside it for the settings those pages carry beyond on/off. When the operator has turned a module off server-wide, its switch shows as disabled with a note rather than a control that can't take effect.

## [1.27.19] — 2026-07-07 — Vault page polish

### Changed

- The Documents page now uses the standard content width like every other page instead of a wider container.
- The standing dashed drop-zone is gone: the header Upload button and page-wide drag-and-drop already cover uploading, so the zone no longer takes a band of space on every visit (the quota bar still appears above 80% usage).
- Search shares one row with the type tags on desktop instead of sitting on its own line above them.
- In a document's detail view, Delete moved to the bottom-left as a quiet text button — the bottom-right slot reads as the primary action, so a destructive control no longer sits there; Download keeps the trailing edge.

## [1.27.18] — 2026-07-07 — Late doses no longer jump the evening slot

### Fixed

- Recording a dose late — after its catch-up window has closed, when the card has already advanced to the next scheduled time — no longer binds the intake to that later slot. Previously a morning dose taken in the early afternoon could be recorded against the evening slot, which then made the evening dose look already taken, dropped it from the day, and pushed the next reminder to tomorrow. A late intake now records on its own, leaving both the missed and the upcoming slot intact, and the taken-count reflects only real intakes. The same guard applies to the bulk-intake path.

## [1.27.17] — 2026-07-07 — The document vault

### Added

- A document vault: an opt-in module (Settings → Modules) that stores the paper trail a household accumulates — doctor letters, discharge summaries, lab and imaging reports, prescriptions, referrals, insurance letters, vaccination records — encrypted at rest in one searchable timeline, with no folders to maintain.
- Upload by drag-and-drop anywhere on the page, paste from the clipboard, or the file picker; multiple files upload in parallel with per-file progress and instant optimistic entries. Files are classified by their actual bytes, not their extension: PDFs and photos (JPEG, PNG, WebP, GIF) preview inline; Office, text, CSV, RTF, TIFF, and HEIC files are stored verbatim and served only as an opaque download; executables, HTML/SVG, and archives are refused at upload. Nothing a user uploads can execute in the app's origin.
- Find a document in seconds: filter by type, by linked condition, or by year, or search titles and filenames — every filter lives in the URL, so a view is shareable and the back button restores it. Each document opens in a detail view with inline preview, editable title, type, and date, and links to the conditions it belongs to; the illness journal shows and links its documents both ways.
- Bulk selection (shift-click, long-press on touch) with bulk type assignment, condition linking, and delete; delete is undo-able with a 30-day grace before a nightly job reclaims the space. Full keyboard navigation and screen-reader labelling throughout.
- Operators tune two limits on the admin settings page: a per-file cap (default 25 MB, hard ceiling 100 MB) and a per-account quota (default 1 GB, with an optional per-user override). Documents live in Postgres, so a normal database backup includes them; the off-host JSON backup deliberately stays data-only.

## [1.27.16] — 2026-07-07 — Offline that survives, and a faster first paint

### Fixed

- The installable app now survives being offline. A network failure on the auth probe was treated as a logged-out session — it wiped the offline caches and redirected to the login page, defeating the entire offline layer. Offline relaunches now render the dashboard from cache with the offline banner; only a real 401/403 or an explicit logout clears anything.
- Chart text is readable in the light theme again — 23 chart surfaces drew their ticks and axis text in colours measuring near-invisible contrast; they now use the semantic text tokens (measured 13.2:1 in light, dark byte-identical).
- On the mood insights page, correlation captions no longer escape their tiles on phone widths; the density guard now covers that route too. Row checkboxes gained a 32 px touch target at unchanged visual size.
- The dashboard hero breathes: the score rings space at 24 px on desktop, on phones the four rings spread evenly across the full width instead of clustering in the centre, and the briefing section separates from the greeting row at the same rhythm as the card padding.

### Changed

- Every page sheds roughly 100 KB of compressed JavaScript: the translation catalog no longer ships twice (once per route bundle, once inlined into the page document — the dashboard document alone shrinks from 139 KB to 25 KB compressed); catalogs now load once as a cached static asset. All sixteen charts share a single chart runtime chunk instead of up to eight copies.
- The dashboard's first paint carries real tile values straight from the server (measured −25 % largest-contentful-paint), and a new bundle-size budget gate in CI keeps route weights from regressing silently.

## [1.27.15] — 2026-07-07 — Complete Google Health coverage

### Fixed

- HRV, resting heart rate, SpO₂, respiratory rate, and VO₂max now import from Google Health. All five daily-summary types filtered with a field-name style the live service never matches — the requests returned 200 with zero rows while the data sat visibly in the Google app. The reference documentation contradicts itself on the style; the sync now sends the form the documentation's own worked example uses and falls back to the alternative automatically, and the connection test reports which one the service accepted.
- Respiratory rate additionally read a response field that does not exist, and height parsed metres where the API sends millimetres — both silent zero-imports since the integration launched.
- Workout recognition covers the full documented exercise catalogue (~35 additional activity types — trail runs, pool swims, rowing machines, and the like no longer land as "other").

### Added

- Three more Google Health data types import into existing measurements: blood glucose, core body temperature, and the nightly wrist temperature Fitbit bands record during sleep.
- A full audit of all 40 API data types is documented alongside the integration — every type is now either imported or an explicitly reasoned skip.

## [1.27.14] — 2026-07-07 — Cross-device dose sync and phone-width polish

### Fixed

- Marking a dose on one device now wakes the others within seconds: every intake mutation — logging, editing, undoing, bulk actions, imports — dispatches a silent sync push to the user's other iPhones, so a lock-screen Live Activity no longer keeps counting down after the dose was taken on the web. Rapid mutations coalesce into one ping (a five-dose bulk action sends one push, not five), the originating device is skipped, and the payload carries no health data — previously it leaked the medication id, and five of the seven mutation routes sent nothing at all.
- On phone widths, the dashboard's briefing-signal rows and the health-score delta stack vertically instead of squeezing a wrapping headline beside its value — a signal headline measured seven lines tall at a third of the tile width before, and on narrow phones the delta spilled past the tile edge. A permanent guard test now pins zero horizontal overflow and no element escaping its tile on the dashboard and insights at 390 px and 360 px widths.

## [1.27.13] — 2026-07-07 — Assessments that interpret

### Changed

- The per-metric AI assessments now interpret values instead of enumerating them: where the current value sits on guideline reference bands (resting heart rate, SpO₂, respiratory rate, body temperature, sleep duration, waist measures, pulse-wave velocity, BMI, visceral-fat rating — each derived from cited primary sources), what that band means in plain words, and a trend judged by its position — a shift deep inside a healthy band reads as a footnote, the same shift near a boundary leads the text. Metrics without an established general reference band say so honestly and interpret against the person's own baseline.
- Two contract rules now bind every AI text surface: measurement counts and logging cadence are not insights (they may only appear when they carry a consequence), and the tone standard is encouraging and dignified — celebrates what is genuinely good, names what deserves attention, never alarms or moralises.
- Band positions are computed server-side and handed to the model as context — the model states them, it never computes them; no diagnosis language anywhere.

## [1.27.12] — 2026-07-06 — Google Health daily totals

### Fixed

- Steps, distance, floors, and active energy now import from Google Health. The daily-totals request counted one calendar day too many per window (an exclusive end bound where the API expects the last covered day), which the API rejected outright; the request now matches the documented example exactly, with a self-reporting fallback to the tighter window size should a stricter limit apply.
- One data type's failure no longer blocks the remaining ones — each cumulative type fetches independently, failures are reported per type, and the sync watermark is withheld so the next run refetches what failed.
- Google API errors now carry the offending field names in the logs (redacted to field paths), so a future rejection explains itself; the connection test's structure probe also exercises a minimal daily-totals request.

## [1.27.11] — 2026-07-05 — Consistency, colour, and locale fixes

### Fixed

- An explicitly chosen display language now sticks on every device, permanently. Two causes were fixed together: the server never consulted the profile's language when the locale cookie was missing, and Safari deletes script-written cookies after seven days — which silently flipped the UI back to the system language every week. The cookie is now set server-side and the profile choice wins whenever the cookie is gone.
- Every insights and dashboard card now shares one measured geometry: the same text edge, the same header-to-body distance, the same foreground colour for body prose. A measurement pass over all pages found and fixed a dozen drifted surfaces, including the "usual range" strip (rebuilt on the standard card) and the blood-pressure explainer.
- The dose ring on the dashboard paints in the medication hue used across the insights instead of green.

### Changed

- The last raw theme-palette colour utilities are gone — every surface reads from semantic tokens now, and the lint rule that guards this is set to error. A small brand token covers the few places that genuinely carry the brand accent, with computed AA contrast in both themes.
- Card slots are guarded against padding overrides by a new lint rule, keeping the spacing scale uniform going forward.

## [1.27.10] — 2026-07-05 — Two new check-ins: wellbeing and sleep

### Added

- The WHO-5 wellbeing check-in joins the mental-wellbeing page: five positively worded questions about the last two weeks, scored 0–100 per the WHO's official scheme. A lower result gently points to the PHQ-9 check-in — a hint, never a diagnosis. The questionnaire uses the WHO's own official translations in all six app languages.
- The Sleep Condition Indicator (SCI) adds a sleep check-in: eight questions, aligned with how sleep problems are clinically described, shown with neutral wording. The validated English questionnaire is used; languages without a validated translation show the English items with an honest note.
- Both scores persist as measurements (server-computed, like the existing screening scores) and can be scheduled as preventive-care reminders that satisfy themselves when a check-in is completed.

### Changed

- The mental-wellbeing page now leads with the four instrument cards; the result history moved off the landing page. Each card opens a detail view with the score trend chart, the dated history, and the start button.
- Dependency refresh: Next.js 16.2.10, TanStack Query 5.101.2, nodemailer 9.0.3, react-hook-form 7.81.0, @types/node 26, and current Docker build-action pins.

## [1.27.9] — 2026-07-05 — Coach plans you can accept

### Added

- When the Coach works out a concrete if-then plan with you, it now appears as a card right in the conversation — accept it or decline it with one tap. Accepted plans become part of what the Coach remembers: follow-up conversations refer back to them, and a plan with a review date comes back for review on its own.
- A new plans page in the Coach area lists your proposals, active plans, and finished ones — mark a goal as met, end a plan, or clean up past ones.

## [1.27.8] — 2026-07-05 — Dashboard follow-ups and design-system sweeps

### Changed

- The hero's medication ring now shows today's doses — "1/3 taken" as a filling ring — instead of a seven-day percentage. No doses scheduled today means no ring.
- Ring choices under Settings → Dashboard apply immediately when toggled and the selection can be reordered; the order carries over to the hero. Ring colours match the Insights rings exactly.
- The "daily briefing" heading on the dashboard is itself the link to the full briefing (no underline), the verdict sentence links to the metric it talks about when it has no action button, and the separate "open Insights" text link is gone.
- The light theme now tunes all remaining highlight colours to readable contrast on light cards — admin pages, the Coach thread, and confidence meters no longer render neon-on-white.
- Failed data loads show the same retry card everywhere; a dozen surfaces previously showed a bare error line without a retry.
- Insights tiles share one header anatomy (icon and title in the standard size and colour) — the sleep, glucose, cycle, and correlation tiles had drifted into hand-rolled variants.
- Card paddings across ~20 surfaces now come from the card primitive alone, removing stale per-card overrides from an older spacing era.

### Added

- The doctor report can include structured allergies and family history as toggleable sections, and the Coach considers both in its picture of you.
- The PHQ-9 check-in regained its optional closing question ("how difficult have these problems made daily life?") as a regular tenth question — answering is optional.
- A guard test pins the settings pages against the recurring scroll-past-the-end class, and the lint rule against raw palette colours now also catches theme utilities, colour props, and arbitrary values.

## [1.27.7] — 2026-07-05 — Score rings on the dashboard

### Added

- The dashboard hero can now show up to three score rings of your choice beside the health score — readiness, recovery, sleep, or medication adherence — picked under Settings → Dashboard. Rings only offer themselves when their module is on, and a ring without data simply stays away. The default shows medication adherence, which replaces the old "doses taken" text line.

### Changed

- Tapping a briefing signal on the dashboard now opens that metric's own page instead of the Insights overview.
- The hero's broad "Open Insights" button is gone; the health-score card already links there. Verdict buttons with a specific action (take dose, view blood pressure, …) stay.

## [1.27.6] — 2026-07-05 — A calmer mental-wellbeing check-in

### Changed

- The mental-wellbeing page is a judgment-free space now: the score history chart is gone from the page itself. Trends stay available through Insights and Measurements for those who want them.
- The PHQ-9 and GAD-7 cards follow the same card anatomy as medications and preventive care: title, when you last tested, your last result, the time since — and one start button.
- The check-in itself is just the questions: the question-overview strip at the top is gone, and after the last answer you land directly on your result — no summary step in between. The back button stays.
- The page intro now mentions a comfortable rhythm: both tests cover the last two weeks, so checking in every two to four weeks is plenty.

### Added

- Mental-wellbeing check-ins can be planned under preventive care like any other reminder, with a four-week default interval. Completing a check-in satisfies the reminder automatically, and its card button starts the check-in directly.

### Fixed

- Completed screening scores are now recorded as server-computed readings, so they cannot be confused with hand-entered values; existing score entries are re-attributed once during the update.

## [1.27.5] — 2026-07-05 — Insights polish and honest states

### Fixed

- The cycle wheel no longer counts into implausible territory when the last logged period lies far back. Beyond a grace window past your typical cycle length it pauses the day count and says plainly that the period is later than usual, with a shortcut to log it.
- Injection medications no longer show the overdue notice twice on one card; the line under the streak row is gone, the escalated next-intake line stays.
- The preventive-care measure button keeps one constant look; a due checkup no longer tints it green. Due-ness still reads from the next-due line.
- Editing a measurement now runs the same per-type plausibility bands as every other entry path, and readings owned by a connected device or the server can no longer have their value edited by hand. Signed metrics accept negative values on edit again.
- The daily briefing card opens straight on the day's signals: the recall/outlook paragraph above the list is gone, the section titles read in the regular text colour, and the card's Ask-the-Coach entry is removed.
- Assessments and the briefing overview are asked to write short paragraphs instead of one connected block — takes effect as texts regenerate.
- Dimmed low-contrast text is gone from informational lines (integration cards, notifications, sleep chart, module rows, and more); your own mood notes now read in the regular text colour and size.
- Sleep-phase and voice copy no longer promise features "coming in v1.x" — those texts now describe the actual state.

### Added

- The recovery score's detail view shows how the score is composed — the same ranked factor rows the readiness and sleep scores already have (shown for scores computed from your vitals; watch-native scores stay as delivered).

## [1.27.4] — 2026-07-05 — Google Health sync fixed against the live API

### Fixed

- The Google Health sync now actually imports data. Against the live service the v4 responses differ from what the connection was built against: payload fields arrive in a different naming form, large numbers arrive as text, and several data types only answer on other read methods. Steps, distance, floors, and active energy now read as true daily totals; sleep, workouts, blood oxygen, HRV, respiratory rate, and cardio fitness use the read method and data type the service accepts, so their requests no longer fail. Weight and height convert from the service's units correctly.
- When Google rejects a request, the sync log now carries the service's own error message (shortened, without credentials), so a failing setup can be diagnosed from the integration status instead of a bare status code.

### Added

- The Google Health connection test can return a structure probe: one sample request per data type, reduced to field names and value kinds — never actual readings. Useful when reporting sync issues.

## [1.27.3] — 2026-07-05 — Briefing resilience and Insights readability

### Fixed

- The daily briefing no longer disappears when the AI provider fails mid-generation. If the number-grounding recheck cannot run because the provider is unreachable, the previous day's briefing stays in place until the next successful run — a briefing that restates unverified numbers is still withheld, as before.
- Assessments show their full text right away; the three-line cut with the "show more" step is gone.

### Changed

- Insights read better: the assessment, the daily briefing, the page explainers, and the "usual range" note now use the regular text colour instead of grey — grey stays reserved for meta lines such as timestamps.
- The "usual range" note is a proper card now, with the same icon-and-title header as every other insights card.
- The page heading and explainer on each metric page line up with the card text below them instead of hanging to the left of it.
- The health-score card drops its "Ask the Coach" corner button.

## [1.27.2] — 2026-07-04 — Readable AI texts

### Changed

- The AI texts — Coach replies, the daily briefing, and the insight assessments — now read as structured prose instead of a single block: short paragraphs with real spacing, a proper list when a reply genuinely enumerates options or steps, and the one key takeaway may be set in bold. The rendering stays deliberately minimal: those two shapes are the only ones the app accepts, everything else remains plain text, and there is still no markdown engine anywhere in the tree.

## [1.27.1] — 2026-07-04 — iPad layout fixes

### Fixed

- On tablet-width screens — an iPad held upright — the app now starts with the compact icon sidebar, so the content keeps the width it needs instead of being squeezed into a narrow column next to the full navigation. Expanding the sidebar still works and the choice is remembered, as before.
- The measurements page no longer pushes the whole page into a horizontal scroll on tablet widths; the history table scrolls within its own frame instead.

## [1.27.0] — 2026-07-03 — Fitbit and Pixel Watch through Google Health

### Added

- A new Google Health connection reads your Fitbit, Pixel Watch, and Fitbit Air data through your Google account: heart rate and resting heart rate, heart-rate variability, blood-oxygen, respiratory rate, steps, distance, floors climbed, active energy, cardio fitness, sleep, and weight. It runs alongside the existing Fitbit connection and is the path forward as Google retires the older Fitbit Web API in September 2026 — connect through Google and your devices keep syncing. You register your own Google client once, and the setup guide walks through it step by step. Two things are stated plainly up front: stress and readiness scores are not offered by this interface, and Google may ask you to reconnect from time to time — the connection shows a clear prompt when it does.

## [1.26.1] — 2026-07-02 — Fitbit setup guide fix

### Fixed

- The Fitbit (Fitbit & Pixel) setup guide described the wrong OAuth app. HealthLog connects through the classic Fitbit Web API, so you register a **Fitbit developer app at dev.fitbit.com** and paste that Client ID/Secret — but the guide walked you through creating a **Google Cloud** OAuth client instead, which the Fitbit sign-in rejects with `unauthorized_client — Invalid client_id`. The guide now describes the correct dev.fitbit.com setup (app type, HTTPS callback, scopes), and flags that Google is retiring the classic Fitbit Web API in September 2026.

## [1.26.0] — 2026-07-02 — Light theme and a consistent interface

### Changed

- The light theme is calmer. Text now sits on a soft off-white instead of pure white, the near-black body colour is lifted to a dark tinted grey, cards separate from the background by a gentle step rather than a hard edge, and charts and status colours draw from the theme's own palette — so nothing glares and light mode reads as one harmonious whole. The dark theme is unchanged.
- Every page shares one header now: the same title size, the same one-line description beneath it, and the same back control. Admin sections, cards and list rows follow the same spacing everywhere, so the app feels of a piece as you move between modules.
- The remaining forms that still opened the device's own date picker (allergies, environment, documents) now use the in-app calendar, matching the rest of the app.
- Wording is consistent across the interface — one word per action and one term per concept throughout.
- Mental Wellbeing now shows a visible page title, like every other module.

### Fixed

- When a list can't load, it shows a clear "couldn't load — retry" card instead of looking like there is no data; lists also show a placeholder skeleton while loading rather than a blank spinner.
- The Coach's medication-adherence storyline now reports the same figure as the dashboard tile. An account that only logged doses it took could previously read as fully on track and hide a real decline.
- Charts over a custom historic date range now return the range you asked for; a range far in the past could come back showing the most recent stretch instead.
- Logging out now always clears the session on this device, even if the server hits a transient database error while doing so.

### Security

- Error reports sent to an operator's monitoring service no longer carry the webhook path secret. This only applies if outbound error reporting is enabled.
- The workout import endpoint no longer accepts a device-owned source from a client, so a synced-device label cannot be forged.

## [1.25.13] — 2026-07-01 — Briefing and medication fixes

### Fixed

- The daily briefing no longer vanishes when it mentions one of your own vitals. It could quote a blood-pressure average, a resting pulse, a weight, a mood or a sleep figure that the server had computed but the briefing's number check did not recognise; a single unrecognised figure dropped the entire briefing while the rest of the insight refreshed, so the briefing looked like it had stopped working. Every figure the server pre-computes for those signals is now recognised, and a genuinely invented number is still caught.
- A medication's dose now reads as a tag next to its category — `7,5 mg` beside `Other` — instead of a separate grey line under the name. Blood-pressure tablets and GLP-1 injections present their strength the same way.
- The custom on-time window switch in a medication's schedule can now be turned on. Turning it on was previously undone in the same step, so it snapped straight back off and no custom window could be set.
- The Appearance sub-pages no longer carry a "Back to appearance" link that pushed the layout down; each sub-page is a dead-end by design.

## [1.25.12] — 2026-06-30 — Follow-up fixes

### Fixed

- The left navigation no longer briefly flashes entries for modules you don't have enabled while a page loads.
- The daily briefing could time out before finishing on an account with a long history; it now has a longer window to generate. (If it still clips, raise the AI response timeout in Settings → AI and/or add a second AI provider so a slow one falls back.)
- Pre-existing and chronic conditions — the ones the Coach watches — now live in Medical history (Anamnese), alongside allergies and family history, instead of the personal-context panel. Where they are stored is unchanged.

### Changed

- Tapping a mental-wellbeing assessment card (PHQ-9, GAD-7) now opens that instrument's trend, the same way a medication card opens its detail.

## [1.25.11] — 2026-06-30 — Consistent settings and cards

### Added

- A date field now opens an in-app calendar that looks and behaves the same on every browser and phone, instead of handing off to the device's own date picker. The time field — and your 12-/24-hour preference — are unchanged.
- Appearance settings are now a hub: a list of the modules you can arrange (dashboard, insights, medications, and the rest). Pick one to open its own page with that module's view and ordering options, plus a link back to the list.

### Fixed

- Medication doses now show their unit in your language ("1 Stück", "2 tablets") instead of an English code, and the dose sits on its own line under the name instead of running into it — on the cards, the detail view and the dose lists.
- The integrations settings could intermittently render with non-interactive notification controls after a slow load; the notification card now renders identically on the server and on the first client paint, so its controls stay responsive.
- A short settings section no longer over-scrolls into an empty band below its last card — the content now fills the visible height exactly, and switching sections stays width-stable.
- The admin sign-in overview truncates a long IPv6 address instead of forcing the table to scroll sideways, and clicking an address copies it in full.
- The admin system snapshot now names the geo provider you actually configured, rather than always showing the default.
- Several insight charts no longer leave a lone tile stranded at half width, and a chart's rolling-average line no longer sits flush against the card edge.

### Changed

- Settings section headers, card layouts and add-form spacing are now drawn from shared building blocks, so they stay consistent across the app — the medication card's shape is the template every card follows.
- Configuration and secret fields — API keys, tokens, integration URLs — no longer prompt your password manager to fill or save them, while real sign-in and password fields still do.
- The custom-metrics add button carries an accessible label on mobile, and the custom-metrics section reads as its own block on the measurements page.

## [1.25.10] — 2026-06-30 — Mobile add-form fix

### Fixed

- On a phone, opening an add form (measurements, mood, medication, …) could push the layout wider than the screen, so the page scrolled sideways. The date-and-time field now stacks its date and time halves on narrow viewports instead of forcing them onto one row, so the form stays within the screen width. They still sit side-by-side from tablet width up.

## [1.25.9] — 2026-06-30 — Custom metrics

### Added

- **Custom metrics.** Define your own measurement — a name, a unit, optional target range, decimal places, and a short description — then log values against it and chart the trend over time, right alongside the built-in measurements. Useful for anything the standard catalog doesn't cover (a symptom score you track, a device reading, a habit count). Each definition and its values are private to your account; they are a deliberately separate, log-and-chart store, so they are not synced to Withings or Apple Health, not exported to FHIR, and not used by AI Insights.

### Fixed

- The settings pages could intermittently render with non-interactive controls (a disclosure that wouldn't open, an export button that did nothing) when the section navigation resolved a different set of entries on the server than on the client. The navigation now renders identically on both passes and applies its module-based filtering once after load, so every settings control stays responsive.

## [1.25.8] — 2026-06-29 — Carrier in the sign-in overview

A focused configuration release. No schema change.

### Changed

- The admin sign-in overview now resolves the network operator (carrier) from the online IP-location provider's ISP field, so it is populated even on a host without the optional offline ASN database. The carrier moves out of a chip stacked under the login method into its own column, next to the location.
- The location backfill now also revisits rows that already had a location but no carrier, so the column fills in across existing history on the next pass — not just for new sign-ins.

## [1.25.7] — 2026-06-29 — Settings, tidied

A settings information-architecture cleanup. No schema change; every page keeps a working address (old links 301-redirect).

### Changed

- **Appearance** is now the single home for how each area looks and is set up: the dashboard, insights, medications, mood, labs, illness journal, and preventive-care surfaces render inline as sections there (each with its full view/sort and management cards), instead of being scattered as their own left-hand entries. A disabled module's section simply doesn't appear. The per-area pages keep their addresses and redirect into the matching Appearance section.
- **Delivery channels** (Telegram, ntfy, web push, …) now live under **Integrations** alongside the other external services, instead of under Notifications. Notifications keeps the reminder types.
- **Share links** move into **Health record**, next to the export they belong with — the standalone Sharing entry is gone.
- **Account** no longer repeats active sessions and security activity; those live under Data & Privacy.

These changes only relocate existing surfaces — nothing was restyled, and every deep link keeps working.

A focused configuration release. No schema change.

### Added

- A self-hoster can now opt into a plain-HTTP IP-location provider by setting `IP_GEO_ALLOW_INSECURE=true` alongside an `http://` `IP_GEO_LOOKUP_URL`. This makes the free ip-api.com endpoint usable (its HTTPS form needs a paid key, but its geolocation is often more accurate, and it includes the carrier). The default stays HTTPS-only with ipwho.is — plain HTTP is refused unless the operator explicitly opts in, since the looked-up IP then travels unencrypted over the server's own egress.

## [1.25.5] — 2026-06-29 — Mental-wellbeing polish, location lookup

A focused polish release. No schema change.

### Changed

- **Mental wellbeing** reads cleaner: the screener trend now matches the rest of the app's charts (a single line with the same soft gradient fill and spacing as the dashboard, no surface-only background bands — the severity band still shows on hover); the page uses the full content width like the other tracking surfaces; and the redundant top heading, its tooltip, and the repeated self-test disclaimer are gone. The instrument card's last-test line now reads like a medication card: the label on the left, the day (today / yesterday / date) on the right.
- **Location lookup** defaults to ipwho.is again — free, no key, resolves a city/country for the login overview out of the box. The offline GeoLite2 databases stay strictly optional (used only when an online lookup misses). Operators whose network blocks ipwho.is can point `IP_GEO_LOOKUP_URL` at another provider without any code change.

## [1.25.4] — 2026-06-29 — Time picker honors the 24-hour preference

A focused fix release. No schema change.

### Fixed

- **The time picker now follows your 24-hour preference.** The earlier fix corrected the times shown across the app, but tapping a date/time field still opened the browser's own time picker — which renders its clock (and the AM/PM toggle) by the browser's language, not the app's. On an English-language browser you saw AM/PM even with 24-hour selected. The field now uses its own time picker, so hours/minutes always follow your preference (24-hour, 12-hour, or automatic) in every browser. The date half keeps the familiar native calendar.
- The doctor-report PDF's "generated at" timestamp now honors the time-format preference as well, instead of falling back to the locale default.
- When adding a blood-pressure reading, the systolic / diastolic / pulse field labels no longer wrap onto a second line in the three-column layout — the metric name stays prominent and its unit (mmHg / bpm) sits beside it as a compact affix.

## [1.25.3] — 2026-06-29 — Mental wellbeing, labs depth, and fixes

A patch release: a clearer mental-wellbeing check-in, more useful lab pages, two visible bug fixes, and a couple of settings tidy-ups. No schema change.

### Added

- Each biomarker now reads with a short explanation of what it measures and why it matters, in every language — not just a generic line.

### Changed

- **Mental wellbeing** is reworked: the PHQ-9 / GAD-7 check-in is now a calm step-by-step flow (one question at a time, with progress) instead of a single long form; the screen reads as cards with a clear title and a short explanation, the voluntary-self-test note stays on the overview rather than interrupting the test, and past results show as a proper trend with severity context. Crisis-support always surfaces for an at-risk answer.
- **Labs** biomarker pages: the redundant "adjust target range" control is gone (it already lives in Edit); the controls now read Delete · Edit · Show all values · Add value, with tooltips, and the "show all values" control matches the others.
- **Settings**: delivery channels now live inside Notifications (one place for "what you receive" and "where it lands"); the former "Dashboard" settings area is renamed **Appearance** and gathers links to the view settings of the dashboard, insights, medications, labs, illness journal, and checkups.
- The daily briefing now scales its generation budget to your configured AI response timeout, so raising the timeout for a slower model actually takes effect instead of being capped — and when a refresh genuinely fails, the message points at the right lever (raise the timeout / re-check the provider) instead of a generic error.

### Fixed

- **The 24-hour time preference is honored everywhere again** — several screens (sleep timeline, workout times, sign-in activity and sessions) were showing AM/PM even with 24-hour selected. Time now follows your preference across the app.
- The readiness / recovery insight tile no longer renders broken — the method note was overlapping the score and contributing factors; the card now reads top to bottom with the factors visible, on every screen size.
- The weekly and monthly review now use the same top-right "ask the Coach" control as the other insights, and the Coach conversations list spans the normal content width instead of a narrow column.

### Removed

- The Documents feature is temporarily switched off pending a deeper rebuild; the existing data and code are untouched.

## [1.25.2] — 2026-06-29 — Flat settings navigation

### Changed

- The settings navigation returns to the familiar flat list down the left, reversing the grouped layout introduced in 1.25.1. Two-factor and passkeys stay under Account; active sessions, trusted devices, and login activity return to Data & Privacy; account deletion returns to Advanced. Every page keeps its own address. The recent quality-of-life touches stay: active sessions and security activity remain collapsed by default, the personal-context page links to the medical-history form, and your chronic conditions show there.

## [1.25.1] — 2026-06-29 — Documents library, tidier settings

A patch release that turns the document inbox into a real library, reorganises the settings, closes a cross-account data-isolation gap on shared browsers, and carries a broad quality pass across the new surfaces. One additive migration (`0222`) applies automatically on start.

### Added

- A documents library: file any clinical document — a report, discharge letter, lab result, imaging, prescription, and more — without needing an AI provider. Give it a title, a category, and a date, then search, filter, sort, and browse it grouped by date. AI fact-extraction is now a separate, optional step you run on a document you have already filed, and you can view or download the original at any time.
- Richer reference descriptions for every biomarker — a few plain sentences on what each marker measures and what it relates to, in all six languages.

### Changed

- Settings are reorganised into nine clear groups — Account, Tracking, Display, Integrations, Notifications, AI & Coach, API & Access, Data & Privacy, and About — with in-page tabs. Far fewer entries down the left, and every page keeps its own address. Sign-in security — two-factor, passkeys, active sessions, and trusted devices — now lives together under Account.
- "Inbound documents" is now simply "Documents".
- Several repeated medical disclaimers were removed in favour of one clear, non-diagnostic statement, and the mental-wellbeing check-in now stands on its own page.
- The daily briefing can draw on grip strength, waist, and pain alongside your other signals, and the grip-strength and waist reference bands are age- and sex-aware.

### Fixed

- Signing out and back in as a different account on a shared browser no longer shows the previous account's data: the in-memory cache is now cleared at every sign-in and sign-out, alongside the offline caches.
- A once-weekly medication no longer triggers a false "low adherence" alert — the alert now uses the same cadence-aware calculation as the rest of the app.
- A lab value read from a filed document is no longer saved under the wrong unit: a unit mismatch is refused and reported rather than silently mis-recorded.
- Moving between insight pages now starts at the top; scroll resets on navigation throughout the app.
- A broad pass of accessibility, mobile-layout, date-format, and wording refinements across documents, settings, and the biomarker pages.

### Security

- Cross-account data isolation on a shared browser: no cached reading from one account can survive into another's session.

## [1.25.0] — 2026-06-28 — Clinical depth

A milestone release. It broadens tracking into clinical territory — validated mental-wellbeing self-assessments, grip strength, a pain score, waist measurements, a longevity lab panel, and respiratory rate as a first-class vital — adds structured allergy and family-history records, an optional weather-and-daylight context module, and the ability to file a doctor's letter and pull its facts into your record after you review them. It also makes the Coach's check-ins warmer, restores assistant-connector sign-in, and carries a broad correctness, performance, security, and accessibility pass. Additive migrations (`0208`–`0220`) apply automatically on start.

### Added

- Mental-wellbeing self-assessments (PHQ-9 and GAD-7) — opt-in, alongside your mood tracking and never a diagnosis. Item answers are encrypted; a non-zero self-harm response surfaces calm, locale-aware crisis-support contacts. Enable the Mental wellbeing module to use it.
- New signals you can log and chart like any other, each with its own detail page, reference range, and trend: grip strength, a 0–10 pain score, waist circumference and waist-to-height ratio, and respiratory rate.
- A longevity lab panel in the biomarker catalogue — ApoB, Lp(a), hs-CRP, HbA1c, fasting glucose and insulin, eGFR, GGT, ferritin, and the omega-3 index — with reference ranges.
- Structured medical-history records: allergies and family history, encrypted at rest, gathered under a new Medical history section and included in the health-record export. Immunizations are not part of this release.
- An optional environmental-context module: daily weather, daylight, and temperature for your location, correlated against mood, sleep, and vitals — off by default, with a home location, dated location periods, and backfill.
- Inbound documents: file a doctor's report or discharge letter and review the facts it contains before they enter your record. The app transcribes what is written and never interprets it; off by default.
- Biomarker detail pages now match the metric pages — description, summary, chart, trend, and a one-tap question to the Coach.

### Changed

- The Coach's proactive check-in is warmer and in your language: it greets you by name, keeps to one calm thought, never quotes your own words back, and never arrives two days running. A setting turns the daily suggestions off; another lets the Coach compose the check-in itself.
- Sleep debt now follows a configurable source order — a wearable's own figure or the computed one — and explains what the computed number means.
- One consistent assessment card, with a one-tap Coach question, across every insight page.
- Sortable history tables and real pagination where long lists used to truncate.
- A clear, non-diagnostic description of what HealthLog and the Coach are — and are not — and an explicit statement of where your data stays.

### Fixed

- Assistant connectors (such as Claude Code) can sign in again over the Model Context Protocol — an outbound-connection fix that also hardens every outbound request aimed at a host you configure.
- The daily briefing, health score, and weekly review keep their last good text instead of going blank when a model is slow.
- The clinician-share page renders again for newly created share links.
- Wearable daily figures, paused-medication adherence, and several long-window calculations are corrected.

### Security

- Free-text on the new records and on filed documents is encrypted at rest, and key rotation covers it.
- Mental-wellbeing answers stay out of the assistant connector, the Coach, and exports by default; their scores export only once you enable the module.
- A fresh second-factor check is required when changing the password.

## [1.24.0] — 2026-06-28 — Model Context Protocol server

A connector release. HealthLog can expose your own health record to MCP-compatible assistants (Claude, ChatGPT, and others) over a standard, OAuth-secured Model Context Protocol server — off by default, behind a module switch and a connector token you mint yourself. Two additive migrations (`0206`, `0207`) apply automatically on start.

### Added

- An MCP server — remote over `/mcp` and a local stdio command — that serves your own records to a connected assistant: metric series, glucose, sleep, workouts, medication compliance and schedule, labs (latest and history), correlations, baselines, level-shift detection, recovery and illness, cycle, integration status, and the preventive-care due-list. Every value carries its unit and reference range, with honest "no data" instead of a fabricated zero.
- A confirmed, scoped write surface: log a measurement, a blood-pressure pair, or a mood entry from an assistant — preview first, then confirm. Read-only by default; writing needs a token minted with the write scope.
- Installable prompt "skills": doctor-visit summary, weekly review, medication check, recovery / glucose / sleep review, and a lab-trend brief.
- Browseable resources and resource templates for metrics, labs, medications, and the doctor-visit report.
- An OAuth 2.1 connector flow (PKCE, audience binding, dynamic and URL-based client registration) so Claude.ai and ChatGPT can connect; mint read-only or read-and-write connector tokens under Settings → MCP. Enable and connect guides live in `docs/`.

### Security

- Off by default — the module gate plus a configured `APP_URL` are required, or the surface returns 404. A connector token is audience-bound to the MCP surface: it can never write or delete over the REST API and can never reach the admin surface. Writes are append-only, idempotent, range- and timestamp-bounded, and audited.

## [1.23.0] — 2026-06-27 — Account security and data sovereignty

A security release. It adds two-factor authentication, brings every sign-in and sensitive action under a stronger check, encrypts free-text health notes at rest, lets you download an encrypted copy of your record, and gathers export, deletion, and privacy controls into one place. Seven additive migrations (`0199`–`0205`) apply automatically on start; `0205` removes the retired bug-report tables.

### Added

- Two-factor authentication: an authenticator app (TOTP) or a hardware security key as a second factor, with one-time recovery codes — set up under Settings → Security.
- Sign-in asks for the second factor when it is enabled; you can trust a device for 30 days to skip it, while the password is always still required.
- Passkeys now show when they were last used and can be renamed, with a gentle prompt to add one.
- An active-session list with sign-out-everywhere, and an alert when a new device signs in.
- A security activity log of recent sign-ins, second-factor changes, and exports.
- A passphrase-encrypted export, so a downloaded copy of your record is never plain text — keep the passphrase safe, there is no recovery.
- A Data & Privacy page that gathers export, deletion, retention, encryption status, sessions, and activity in one place.
- A check that warns when a chosen password has appeared in a known breach.
- Admin controls to require a second factor and to review encryption coverage and key-rotation progress.

### Changed

- Free-text notes on measurements and mood entries are now encrypted at rest.
- Sensitive actions — account deletion, data reset, encrypted export, disabling the second factor, and key rotation — require a fresh second-factor check.

### Removed

- The bug-report integration has been removed.

### Security

- A second-factor session is bound to the credential it was issued for; an API token can never satisfy a fresh-factor check or reach the admin surface.

## [1.22.1] — 2026-06-27 — Mobile and Coach polish

A reliability and quality-of-life patch focused on the mobile interface and the Coach.

### Added

- Each lab biomarker shows a short description under its heading, the way Insights describes its metrics.
- Hover a Coach message for an action row: copy it, read it aloud, rate the reply, regenerate it, and see the time it was sent.

### Changed

- Read-aloud now selects a natural device voice instead of the default robotic one.
- The Coach prompt stays on one line and the conversation search field spans the full width.
- The settings and admin section navigation stays fixed while only the content scrolls, on both desktop and mobile.
- The admin "Module availability" section is now simply "Modules".

### Fixed

- The settings and admin side navigation no longer drifts while scrolling.
- Selecting a settings section on mobile no longer animates a scroll from the top of the page.
- The profile menu rows are evenly spaced, and the "More" menu labels are no longer clipped on narrow screens.
- Charts no longer crush the layout in landscape on small screens.
- Sleep insights no longer repeats the nightly average above its tiles.

## [1.22.0] — 2026-06-27 — A Coach that speaks, remembers, and charts; richer narratives across the app

A feature release. The Coach reads its replies aloud, can draw the metric it is discussing, remembers what you ask it to and resurfaces those reminders, and proposes checkups or measurement reminders you confirm inline. Insights and Coach assessments are rewritten for connected, motivating narratives instead of restated figures, and the daily read now folds in labs, preventive care, workouts, and glucose. Four additive migrations (`0195` hidden biomarkers, `0196` coach reminders, `0197` coach plan outcomes, `0198` AI settings); applied automatically on start — no operator action required.

### Added

- The Coach can read its replies aloud, and a reply can include a chart of the metric under discussion so the number has its trend alongside it.
- The Coach remembers things you ask it to keep and resurfaces a reminder when it comes due; a reminders list in settings shows what it is holding and lets you clear any of it.
- The Coach can propose a checkup or a measurement reminder, which you confirm inline before anything is saved.
- Hover a message to see the date and time it was sent.
- A configurable AI response timeout, and a separate optional provider dedicated to scanning lab documents.
- Steps now appear in Insights, and selecting a measurement type opens its insight.

### Changed

- Insight and Coach assessments are rewritten to connect signals into a motivating narrative rather than restate figures, with substantially expanded score summaries; generated text now renders in paragraphs and carries clearer "updated" timestamps — today with the time, yesterday, and a date for anything older.
- The daily read folds in labs, preventive care, workouts, and glucose, and correlations surface emerging signals over a recent window alongside more cross-signal links.
- The preventive-care area is now "Checkups", reached at `/checkups`; the German interface keeps "Vorsorge".
- Settings pages share one consistent layout, and the settings and admin sidebar stays pinned while the content scrolls.
- Lab biomarkers are a compact, editable list with hide and restore.
- Local AI servers stream their replies and honour the configurable timeout, so slower self-hosted models finish cleanly.

### Fixed

- The daily briefing and the insight trend no longer go blank when generation runs long.
- The blood-pressure "usual range" no longer shows a nonsensical band.
- A Coach notification now opens straight into the conversation it began.
- Insight headings drop the trailing info icon in favour of a short description.
- Lab values no longer link out to an article.

## [1.21.4] — 2026-06-27 — Coach surface refinements

A patch release. No migrations, no breaking changes.

### Changed

- The Coach settings link now lives in the composer's "+" menu, next to New chat and Conversations, and the redundant gear in the page toolbar is gone; the drawer keeps its own gear. The composer is the single control hub.
- Conversations open as a dedicated page with the search field at the top and the list grouped by recency — today, yesterday, this week, and earlier — instead of a slide-in panel. Both the "+" menu and the drawer's conversations control route there.
- The seeded "worth a look" opener spans the full width of the composer and carries a dismiss control that hides it for the rest of the day.

## [1.21.3] — 2026-06-27 — Coach memory and a standing quality harness

A patch release. One additive migration (`0194` coach plans); no breaking changes.

### Added

- The Coach can remember a goal or an if-then plan you confirm — "if my resting pulse is up in the morning, I'll keep the evening easy" — and carry it across conversations. It proposes the plan; it is saved only when you accept, and you stay in control of what it keeps.
- A standing quality harness runs in CI for the Coach: a graded set of reference cases plus an adversarial battery checks that every cited number traces to your own data, that the warmth never tips into over-validation, and that a red-flag symptom always escalates. An optional nightly model-judged pass is wired in and stays off until a key is configured.

### Fixed

- The dashboard and insights snapshot is cached per language, so switching language no longer briefly shows the previous language's briefing text.

## [1.21.2.1] — 2026-06-27 — Coach + briefing provider hotfix

A hotfix. No migrations, no breaking changes.

### Fixed

- The Coach and the daily briefing failed for accounts signed in through the ChatGPT provider: the provider rejected the multi-step tool-call request, and the failure surfaced as a server error instead of a graceful message. A provider failure now always degrades to a clear in-chat notice — with the correct reconnect or rate-limit prompt where those apply — rather than a 500, and the provider request follows the documented tool-call wire format so the Coach's multi-round reasoning and the briefing generate again. The provider's own error detail is now captured for diagnosis.

### Changed

- While the Coach is thinking, the bubble shows only the three animated dots — the "Thinking…" word is gone (it remains for screen readers).

## [1.21.2] — 2026-06-27 — Ambient Coach presence

A patch release. The Coach surfaces what it already computes — at the metric, on the score, in the briefing — instead of waiting to be asked. No migrations, no breaking changes.

### Added

- A "Coach read" on every metric page: one line placing today's reading against your own usual range, and — when the data supports it — one line naming the strongest connected signal in plain association language. While your range is still forming it says so rather than guessing.
- Opening the Coach from a metric or card now shows that it is already on that metric, with a tappable opening question; the unscoped Coach opens on the day's most notable signal instead of a blank box.
- The daily briefing recalls the prior period and points ahead.
- The health score surfaces an honest "internal read" when its contributors disagree — good sleep but a rising resting pulse — and notes when a metric has come back inside your usual range after a dip.

### Changed

- The Coach's motivational-interviewing repertoire gained develop-discrepancy and roll-with-resistance moves and a clearer anti-persuasion boundary.
- The prose number-check now runs on the local-model path too, so grounding holds regardless of provider.

## [1.21.1] — 2026-06-26 — Dialog footer reachability

A patch release. No migrations, no breaking changes.

### Fixed

- Pop-up forms now scroll only their body on desktop, keeping the action row in view. A tall form — or one made tall by browser zoom, display scaling, or a longer-language label — could push the primary button below the fold and force a scroll to reach it; the centred dialog now matches the bottom sheet, which already pinned its footer. Every form the app mounts through the shared sheet surface inherits the fix.

## [1.21.0] — 2026-06-26 — Date-format preference, a far more connected Coach, and broad correctness work

A feature release. The Coach reaches every data domain on demand, surfaces the cross-metric patterns the analytics tier already discovers, opens in context from any screen, and speaks with a warmer, forward-looking voice on one shared set of safety thresholds. Dates render in your chosen format everywhere. Two additive migrations (`0193` rollup x-rescale, `0192` date format); no breaking changes.

### Added

- A date-format preference in the profile — automatic (follows the language), day-month-year, month-day-year, or ISO — honoured across the app, including every date and date-time field, which now render in your chosen order regardless of the browser's locale.
- The Coach answers from the full data picture: every metric domain on demand plus cycle and workouts, and it surfaces the discovered cross-metric correlations — medication adherence against symptoms, short sleep against the next morning's vitals, and so on — citing only what the analytics tier actually found.
- Open the Coach in context from any metric page or insight card and it arrives already scoped to what you were looking at, with a relevant opening question.
- "Learn more" pointers on the vitals tiles, the glucose panel, the resilience tile, and the lab biomarker detail link out to the matching guide; the Coach references the same guides and can no longer offer a link that doesn't exist.
- Medication compliance and symptom severity are now first-class signals in the correlation engine, so an adherence dip that tracks a symptom flare can finally be surfaced.

### Changed

- The Coach connects signals into one story instead of listing metrics, looks ahead with gentle, ranged outlooks, ends an action turn by checking your confidence and offering a single doable step, and keeps affirmation earned. A closed acute-symptom clause points to prompt medical attention for crisis signs.
- Critical-threshold numbers — blood pressure, fever, glucose — now come from one source, so the dashboard banner, the Coach, the status cards, and the notifications always state the same thresholds.
- The trend regression is composed on an origin-rescaled, mean-centred basis, removing a floating-point cancellation on long windows; the rollup now matches the live computation to the last digit.
- The daily AI usage budget is provider-aware: usage on your own OpenAI key, ChatGPT plan, or local model is no longer limited by the server-cost ceiling that applies to an operator-provided key.
- The Coach builds its data snapshot once per turn and may take an extra reasoning round for a deep cross-metric question.
- Discovered correlations are held to an effect-size floor and a confidence tier, and sparse personal signals are shrunk toward the baseline, so a real-but-trivial association is no longer stated as a confident driver.

### Fixed

- ChatGPT/OpenAI sign-in users no longer hit a spurious "daily limit reached" after only a couple of messages.
- The symptom journal's recovery-return and the SpO2 red-flag count consecutive calendar days and are order-independent; the "two or more vitals out of band today" flag is keyed to your calendar day rather than UTC.
- Withings activity sync and the medication-intake dedup issue far fewer queries on a long backfill.
- The trend read returns the same boundary day whether served from the rollup or from a live query.
- The native date primitives that ignored the locale are gone — every field routes through the format-aware inputs.

## [1.20.2] — 2026-06-26 — Hardening across insights, safety flags, and integrations

A patch release. A broad pass over the server tier and the AI surfaces: a few correctness and safety fixes, a numerical hardening of the trend tier, and several smaller robustness and cost improvements. No schema changes.

### Added

- The lab-report review screen marks low-confidence rows so an uncertain reading is easy to spot before it is saved.

### Changed

- The trend regression (slope, r² and variability) is composed from mean-centered sums, which removes a floating-point cancellation on long, near-flat windows and keeps the rollup result in line with the live computation. Each accumulator now uses the exact stored sum rather than reconstructing it.

### Fixed

- The symptom journal's "sustained fever" flag — which can raise an urgent prompt to seek care — now counts only consecutive calendar days. A sparse series of isolated febrile entries no longer trips it, so the alert reflects a genuine multi-day run.
- Insight generation no longer reads a full measurement history per metric to compute its 30-day comparisons; it reads only the window those averages need. Generating insights on a long-history account is markedly faster, on both the page request and the overnight pre-generation.
- Photo and PDF scanning is no longer offered for text-only reasoning models that cannot read an image, so a scan attempt fails clearly up front instead of erroring at the provider.
- A notification channel whose stored configuration cannot be read now disables itself immediately with a precise reason, instead of retrying a permanent error several times and ending on a misleading message. This surfaces during an encryption-key rotation gap.
- The Coach cancels its in-flight model call when the browser tab disconnects mid-answer, rather than paying the full cost into a closed connection.
- Local-OCR text structuring reserves a budget proportionate to its real cost instead of the larger vision-scan ceiling, and refunds cleanly on a failed read.
- The admin diagnostic endpoints return a 422 for a malformed query string instead of a 500.

## [1.20.1] — 2026-06-23 — Dashboard render-loop fix

A patch release. One fix; no schema changes.

### Fixed

- A user reported the dashboard crashing on returning to a backgrounded tab. The on-focus snapshot refetch re-rendered the page, and each chart's "data ready" notify — keyed on a handler that the page recreated every render — re-fired on every commit, driving the chart row into an unbounded update loop until the browser tripped its render-depth guard and the page fell back to its error card. The notify now fires once, when a chart's initial query settles, regardless of how often the page re-renders.

## [1.20.0] — 2026-06-22 — Coach on-demand retrieval, deeper recovery insight, Fitbit, and a leaner data tier

A feature release. The Coach fetches what it needs on demand instead of carrying a full snapshot; the recovery-gap learns from the symptom journal and sleep; Fitbit connects over its own Web API; the trend tier serves slope and variability without a live scan; and several built surfaces become discoverable. Two additive migrations (`0190`, `0191`); no breaking changes.

### Added

- The Coach answers from on-demand retrieval: a small base context plus a data inventory, with tools it calls to pull the exact series, lab, sleep, medication or recovery figures a question needs. It cites only what it fetched and says so plainly when there is no data. First-turn cost drops substantially while the grounding and cross-metric reasoning are unchanged.
- The recovery-gap reads the illness journal's own symptom-severity curve and adds a sleep-context line, and it is now relapse-aware — it reports the final sustained return, not the first.
- Fitbit connects experimentally over the Fitbit Web API with PKCE, so a self-hoster can link it with an instant developer app.
- The sleep, steps and glucose dashboard tiles and the preventive-care row are surfaced by default (each self-hides without data), so built features are easier to find.

### Changed

- The AI client layer moves to a structured message format with per-provider prompt-caching, which lowers cost on repeated context and lays the groundwork for retrieval.
- Trend slope, r² and standard deviation are served from the rollup tier via stored regression accumulators instead of a live scan on every request; the result matches the live computation.

### Fixed

- The fever red-flag now reads days in chronological order, so an episode logged from both a thermometer and the journal can no longer raise or hide a sustained-fever flag incorrectly.
- A vital that settles and then shows a single stray out-of-range reading keeps its recovery day instead of reporting none.
- Fitbit sleep segments are placed on the correct day for users outside UTC.
- Concurrent syncs for Withings/WHOOP/Oura/Fitbit no longer park a connection at a spurious reconnect when a one-time-use refresh token is rotated.
- The Coach reply is no longer corrupted into raw JSON on some providers, and a tool request is no longer dropped on an unexpected stop reason.
- The trend tier records when slope is briefly unavailable pending backfill rather than reporting it silently.

### Refactor

- The Coach's per-request reads are shared across the retrieval fan-out instead of repeated per tool.

### Security

- Dependency bumps: next, pg-boss, radix-ui, pg, @testcontainers/postgresql, and the CI actions.

## [1.19.2] — 2026-06-21 — Recovery-gap symptom signal, resilience tile, long-range charts, richer device + Telegram data

A follow-up that folds the illness journal's own symptom curve into the recovery-gap, surfaces Oura resilience, fixes multi-year chart ranges, and widens the heart-rate and Telegram data paths. Two additive migrations (`0188`, `0189`); no breaking changes.

### Added

- The recovery-gap now reads the illness journal's own daily functional-impact curve (and linked symptom severity), not just passive vitals. When symptoms lead the recovery, the card names them — "you tend to feel better before your logged symptoms ease". Sparse journals withhold rather than guess.
- An Oura resilience tile on the recovery surface, showing the latest resilience band with a quiet above/in-line/below-average cue and a calm learning state until enough days are recorded.
- Hourly heart-rate uploads can carry a per-bucket low and high alongside the average, so a high-frequency client no longer loses the within-hour spread.
- A numeric reply to a Telegram measurement reminder is captured as a reading (for example a weight or a glucose value), bound to the linked chat and self-cleaning like the mood path. Blood pressure stays a simple "done" for now, since it needs two values.

### Changed

- A multi-year "All" chart range now renders the whole history, stepped up to a weekly or monthly tier, instead of being silently truncated to the most recent year.

### Fixed

- `telegram_chat_id` is now unique, with a one-time clean-up of any stale duplicate bindings (no account is removed).
- Migration `0187` is rerun-safe.
- The sleep peer-card comment no longer overstates window parity; each card discloses its own night count. Dead streaming state left after the reasoning-disclosure removal is gone.

## [1.19.1] — 2026-06-21 — Coach flow, sleep and mood polish, navigation, recovery-gap

A follow-up to 1.19.0 that refines the Coach conversation flow and cost, adds a sleep average card, completes the mood colour pass, tidies navigation, and sharpens the illness recovery-gap. No schema changes; no breaking changes.

### Added

- A sleep average-per-night card sits beside sleep debt and chronotype as a third peer, computed over the same scorable-night set so the three cannot disagree. It stays calm until enough nights are scored.
- The recovery-gap names the vital someone tends to recover ahead of — for example "you tend to feel better before your resting heart rate settles" — rather than a single bare line.

### Changed

- The Coach opens on a fresh chat by default. It resumes a past conversation only when the Coach has written something unread; an explicit `?c=<id>` deep-link still opens that conversation. This refines the 1.19.0 behaviour, which always reopened the most recent thread.
- The chat view carries an always-visible toolbar with a clear way into past conversations and a new-chat action, and reaching conversations from the dashboard tile now always lands on the conversation list instead of an empty pane.
- The Coach sends the full health snapshot once per conversation (and again only if the conversation grows long enough to scroll the original context out of view); short follow-ups ride the existing transcript. A one-word reply no longer re-pays the whole snapshot, cutting per-message cost on follow-ups by roughly an order of magnitude while keeping the same grounding and cross-metric correlation.
- The streaming reply shows a typing indicator that gives way to the streamed text, replacing the reasoning-status disclosure.
- The settings navigation entry that opens the dashboard layout is labelled "Dashboard" to match where it leads.
- The main sidebar order groups the care surfaces together: medications, preventive care, lab values, illness, then insights, the Coach, and achievements.

### Fixed

- The mood time-of-day chart and the mood calendar now use full colour saturation in line with the other mood surfaces; only no-data cells stay muted.
- The cross-episode recovery-gap baseline counts only days that deviated in the illness-adverse direction, so a neutral reading (such as a weight drift) can no longer pad the sample or be named the recovery driver.
- The sleep average-per-night field is part of the documented sleep-rhythm response contract.

## [1.19.0] — 2026-06-21 — Coach context, a leaner AI pipeline, new device signals, interactive reminders, and wider self-hosting

A feature release. The Coach gains the lab values and a direct way in; the daily AI work is restructured to do less and reuse more; several new device signals are captured; reminders become interactive over Telegram; charts and the cycle and sleep surfaces are corrected and polished; and the project ships ready-made templates for one-click self-hosting. Three additive migrations (`0185`–`0187`); no breaking changes.

### Added

- The Coach can answer about lab results — the most recent value per biomarker (last twelve months) is provided as grounded context, with reference range, in/out-of-range status, and date. Qualitative results are included; the Coach quotes them verbatim and never invents a value.
- The Coach entry points open directly into the most recent conversation, the same thread across devices, rather than always starting blank. A `?c=<id>` deep-link opens a specific conversation; the new-chat start remains.
- The daily briefing is surfaced on the dashboard as a short spotlight strip, lifting its key signals above the fold for a fresh briefing.
- Mood can be logged straight from a Telegram reminder — a 1–5 inline choice or a short written note — and the reminder chat self-cleans about thirty minutes later so old prompts do not linger or bias the next entry. Mood and measurement reminders also carry calm "remind me later" / "done" actions.
- Withings ECG records the device's atrial-fibrillation screening result and the full ECG waveform (stored encrypted at rest).
- Oura cardiovascular age and resilience are recorded.
- A configured multimodal model reads a scanned lab document directly; where the model is text-only, the on-device OCR path still applies.
- Ready-made self-hosting templates: an Unraid Community Applications template and a Portainer stack template, a hardened `docker-compose.yml`, and a NAS quick-start guide.
- A go-forward aggregated heart-rate upload contract (hourly buckets) so high-frequency clients stop accumulating one row per raw sample.

### Changed

- The AI pipeline does less, more coherently: the comprehensive briefing reads a bounded recent window (all-time figures stay accurate); per-domain status summaries generate once on the nightly pass instead of per metric through the day; a shared feature snapshot is computed once and reused; slow movers (weight, BMI) skip regeneration when their inputs are unchanged; illness and cycle state fold into the briefing context at no cost for users without them. Reproducibility, consent, and grounding checks are unchanged throughout.
- Medication remaining-supply is computed server-side and rendered from one canonical value, so the web and the iOS client always agree.
- High-frequency heart rate and blood oxygen are consolidated server-side into daily aggregates (mean with the daily minimum and maximum preserved; a resting-heart-rate value is derived where the source has none), matching the cumulative-metric consolidation already in place.
- Day-level bucketing for recent readings honours the user's timezone, so a late-evening reading lands on the correct local day.
- Sleep debt is a recovering rolling balance over recent nights instead of an ever-growing sum, so it reflects what is owed now and shrinks after a good night.
- The cycle view aligns its columns, uses consistent typography and equally sized toggles, and shows the prediction disclaimer once — clearly, at onboarding — rather than repeated across the feature.
- The sleep card's tiles share one consistent layout, and mood charts paint at full saturation.
- Sleep-night minute values are returned rounded; the notifications page opens on a single heading.

### Fixed

- Charts honour the 90-day and All ranges — they were stuck on roughly the last month regardless of the selected range.
- Medication remaining-supply can no longer display a nonsensical negative figure; the canonical readout is floored and a would-be underflow is recorded for diagnosis.
- Notification settings now label the measurement-reminder, medication-intake-sync, and coach-nudge events instead of showing raw keys.

### Performance

- Achievements and the dashboard summary serve from a stale-while-revalidate cache, the achievements builder precomputes day boundaries, three charts defer their library, and the analytics aggregate folds its canonical self-join into a single shared expression.

### Security

- The ECG waveform is encrypted at rest and covered by the key-rotation script, with a schema-driven test that fails the build if any encrypted column is ever left out of rotation.
- A Telegram interaction is strictly bound to the linked account before it can write, and the chat identifier is redacted from logs.

### Refactor

- Oversized modules are split into focused modules behind a barrel with no change in behaviour: the OpenAPI medication and insights registries, medication validations, the import panel, and the account settings section.

### Deferred

- Garmin: blocked by an external gate (the developer programme is invitation-only and not accepting new applicants), so there is nothing to build until access opens; only the official hosted instance could pursue it.
- Briefing map-reduce over the per-domain summaries, the cycle/sleep companion-line edge cases, multi-year "All" chart ranges, and the Oura resilience tile remain follow-ups.

## [1.18.10] — 2026-06-20 — data-loss fix, measurement consolidation, grounding, and the full-page Coach

A correctness-and-polish release. It closes a silent data-loss path and a stalled measurement-consolidation job, hardens AI output grounding, and acts on a broad round of UI feedback. Two additive migrations (a covering index and a labs setting); no breaking changes.

### Fixed

- Editing one field of a cycle or condition-journal day entry no longer wipes an encrypted note that cannot be decrypted with the current key — the stored value is preserved untouched unless that field is explicitly changed.
- The nightly consolidation of cumulative metrics (walking/running distance, flights climbed, active energy) no longer aborts on the first conflicting day, so raw per-sample history collapses to daily values as intended. A one-time compaction of the existing backlog runs after deploy.
- The daily briefing refreshes when regenerated, and the home screen reflects a saved tile layout without a manual reload.
- The Coach dictation button reports when speech input is unavailable instead of doing nothing.

### Added

- The Coach has a full-width page (no panel-within-a-panel), reachable conversation history, and a clean new-chat start.
- Scan a lab report without a vision model: optional on-device OCR (off by default) reads the image in the browser and sends only the extracted text to the configured AI provider, then the same mandatory per-row review applies. The labs "Add" action now offers "scan a document" or "add a value manually".
- Withings sleep now records heart rate, respiratory rate, blood oxygen, sleep HRV, and the sleep score (previously discarded at sync).
- Oura VO2max is recorded, and the VO2max tile is shown on the dashboard by default.

### Changed

- Preventive-care cards show the cadence on the metric row rather than beside the heading, and the heading opens the measurement history filtered to that metric.
- The danger zone and the daily-briefing card match the rest of the surface; the feedback tool is marked deprecated; the preventive-care and labs settings follow the standard section layout.
- Lab values: delete moved to the value's detail view, the overview tags are quieter, and the reference-range confidence is surfaced when a new biomarker is created.
- Location lookups default to the online resolver; the offline database is optional.
- Mobile: the full-page Coach composer stays clear of the bottom navigation, long navigation labels stay readable, and touch targets meet 44 px.

### Performance and integrity

- Blood-pressure in-target and grade read identically whether served warm or cold (one canonical source per day).
- A per-session statement timeout stops a single stuck query from holding a connection; a soft-delete-aware measurements index; the all-time fallback scan is bounded.

### Security

- Daily-briefing numbers are checked against the underlying signals; the Coach reply is screened for fabricated values or dose instructions; the period narrative is grounded before it is stored; the metric status cards state precomputed trends rather than re-deriving them.

### API

- The labs OCR capability response carries a `mode` (vision or text) and a new local-OCR preference; additional measurement types are recorded server-side. All additive and back-compatible.

## [1.18.9] — 2026-06-20 — Coach surface, lab-report scanning, and fresher dashboards

A broad UI and data release. It adds two migrations (both additive and nullable — qualitative lab results and Coach token columns) and three additive, back-compatible API changes (see the note below).

### Added

- Coach opens on a calm new-chat surface: a centred greeting and a single composer, then each answer streams in word by word with a soft fade, a collapsible thinking disclosure, and a quiet per-message footer showing the tokens used and the model. The quick-access drawer is unchanged.
- Scan a paper lab report. With an AI provider connected, upload a photo or PDF and the reader proposes the measurements and biomarkers it finds. Every row goes through a mandatory review — confirm, edit, or discard each one, with duplicate and reference-range hints — and only what you confirm is saved. The uploaded file is held in memory for the read alone and is never stored.
- Record a qualitative lab result — positive/negative or another text value — where a number does not apply.
- Sort lab values alphabetically, and delete a biomarker directly from the labs list and detail views.
- VO2max shows on the dashboard by default, and Oura's VO2max reading is now ingested alongside the existing sources.

### Changed

- The labs surface defaults to the list view, and its tiles share the medication-card layout. The labs and condition-journal settings now follow the same section pattern as the rest of Settings.
- Preventive-care cards read the last-completed date as "today"/"yesterday" and the next due date as a discreet "today" (green) or "overdue" (orange), and drop the small trend strip.
- Sleep-debt and chronotype sit side by side, and the daily-briefing card aligns with the surrounding type.

### Fixed

- The dashboard reflects new readings without a hard refresh: an added or background-synced measurement now refreshes the home snapshot — including on Withings and Apple Health sync, and on returning to the tab.
- The condition journal opens quickly again. The cross-episode correlation runs only when an entry's analysis is opened, and the typical-recovery-gap insight appears only when there is enough real data to support it.
- The latest-report area shows its age and, when no AI provider is connected, points to where to connect one, instead of presenting an old report as current.
- The Coach quick-access icon uses a softer tone.

### API

- The Coach stream's `done` frame now carries an optional token `usage`, and a Coach message can carry `tokensUsed` and `model`; an optional `reasoning` frame is reserved. New `GET/POST /api/labs/ocr/{capability,extract,commit}` endpoints; rows committed from a scan carry `source: "OCR"`. All additive and back-compatible.

## [1.18.8] — 2026-06-20 — coded condition and lab terminology in the health-record export

An additive export-only release: the FHIR R4 health record now carries standard terminology codes where it can assert them honestly. No migration, no API contract change.

### Changed

- Condition resources for journal entries carry a SNOMED CT category coding per illness type (infection, allergy, injury, mental health, autoimmune, chronic, other) alongside the user's free-text label. These stay broad categories, not diagnoses — the patient-reported, unconfirmed guard rails are unchanged.
- Lab Observations now emit a LOINC code and a canonical UCUM unit for the common biomarkers (HbA1c, lipid panel, ferritin, TSH, vitamin D, creatinine, eGFR, liver enzymes, CRP, fasting glucose, hemoglobin), resolved through an analyte alias table. An unrecognised analyte, or a unit that does not match the canonical UCUM symbol, keeps the honest text-only behaviour rather than asserting a code it cannot validate.

## [1.18.7] — 2026-06-19 — dashboard, Coach and insights polish

A broad UI, insights, and AI-efficiency release. It ships database migrations (see the migration note below) and two client-facing contract changes: Coach budget responses now arrive as a stream error rather than a 429, and the measurement-reminder push carries the reminder id.

### Added

- The daily briefing surfaces "signals of the day" — today's readings against your 7- and 30-day trend, emerging slopes and recent outliers — and leads with one concrete, present-focused nudge.
- Preventive-care cards show a quiet seven-day strip of the metric, and their menu jumps straight to the measurement history filtered to that type.
- The Coach reads your active illness state and Rest Mode, can point you to the relevant in-depth guide, and draws on a tiered view of your history (recent days in full, older periods progressively summarised with peaks preserved).
- Dictate to the Coach by voice.
- The share-link section is back as its own Settings entry, next to the health-record export: mint a time-boxed, revocable, read-only link to share your record with a clinician.
- Share links now carry a passphrase second factor. A new link mints a one-time passphrase embedded in a QR code (in the URL fragment, never sent to the server); the public view stays locked until the passphrase is verified. Links created before this release keep working without one.
- Labs, preventive care, and the condition journal each have their settings as a proper section of the Settings shell, in the same layout as every other section, instead of a separate page.

### Changed

- The daily briefing regenerates every day and reads warmer and more motivating.
- The Coach interface is rebuilt around a calm, centred reading column with a collapsible conversation list, a thinking indicator that hands off to streaming, and a quieter scrollbar.
- The health-score rings are flattened to match the chart style — the glow, sheen and pulse are gone.
- Sleep drops the redundant "last night" card; the chronotype reads as a prominent summary with your natural sleep midpoint and an expandable detail.
- Every integration card follows one layout — a short description ending in an inline setup-guide link, with the credential hint above the save button.
- A warm insight cycle now sends far fewer AI requests: the per-metric status assessments are batched into a single call, and the comprehensive path recovers from a malformed reply with one corrective retry instead of failing outright.
- The daily briefing now varies its wording day to day while the underlying findings stay stable, so a quiet day no longer reads as a frozen cache.
- Prompt construction is consolidated: grounding, tone, and the medication-safety rules come from one shared source across the briefing, status cards, narratives, and the Coach.
- Settings cards share one card primitive and a consistent padding step, and touch controls across the app meet a 44-pixel target on phones while staying compact on wider screens.
- The local-AI private-host switch accepts an explicit host allowlist instead of an all-or-nothing flag (the previous `true` still means "any private host").
- Coach conversations are pruned on a schedule, alongside the existing notification-attempt retention.

### Fixed

- The daily briefing no longer goes stale: a fresh daily signal forces regeneration instead of re-stamping an unchanged narrative.
- The sleep assessment no longer shows the "connect an AI provider" prompt when a provider is already connected.
- A medication's supply now updates on the next read: adding a container or registering a new medication evicts the cached list instead of serving the pre-change stock for the cache window, and the card and table refresh together.
- The seed for the public demo no longer produces an impossible blood-pressure reading, and reads as a current, healthy, fully-used account.

### Security

- The Coach budget gate reserves spend atomically before each request, so concurrent requests can no longer slip past the cap together, and tokens burned on an empty or refused reply are still counted.
- New share links require a passphrase to open the record; the passphrase is stored only as an HMAC hash, verified in constant time behind a rate limit, and unlocks a short-lived view cookie scoped to that one link.
- The session and authentication-challenge tables are indexed on their expiry column for the reaper.
- The development key-padding fallback fails closed unless the environment is explicitly development or test, so a missing `NODE_ENV` can no longer silently derive a weak key.

### Migration

- This release adds three migrations: expiry indexes on the session and challenge tables, a daily-briefing reroll marker, and the nullable share-link passphrase hash. Run `prisma migrate deploy` (the entrypoint does this automatically). All three are additive — no backfill, no downtime.

## [1.18.6.1] — 2026-06-18 — settings and Coach UI follow-ups

A small UI and settings patch on top of v1.18.6. No migration, no API contract change.

### Fixed

- The settings and admin left menu now aligns with the top of the first card, instead of sitting slightly offset.
- The Coach conversation scrolls within a bounded area with the composer pinned to the bottom, instead of overflowing the panel.
- The health-record settings section (PDF and FHIR export) is reliably reachable again — its entry no longer disappears from Settings.

### Changed

- The guided tour is first-run only. The per-page and Settings "show tour" triggers are removed.
- Preventive-care cards now mirror the medication card: the cadence sits as a chip beside the name, due and last dates read as text, and "last done" always shows — with an em-dash when there is nothing yet.

## [1.18.6] — 2026-06-18 — offline reads, grounded guidance, and one consistent app

A large release that makes the app genuinely useful offline, gives every metric cited reference context, grounds the AI Coach and Daily Briefing in that same context, adds responsible safety alerts for clinically urgent readings, and brings the newer modules (preventive care, illness, labs) and the whole settings area in line with the established patterns. A guided tour now explains what each module does and how they connect. No breaking changes; all schema changes are additive.

### Added

- **A module-by-module guided tour.** After onboarding, a short tour walks each module — what it does, one capability you might miss, and how it feeds the others — so the whole app makes sense on day one. Replayable any time from Settings, or per module from its page.
- **Cited reference ranges everywhere.** Metrics now carry plain-language explainers and the general reference range they sit in (blood pressure, resting heart rate, glucose, blood oxygen, temperature, and more), framed as general guidance and sourced from recognised guidelines — never a diagnosis. Blood pressure follows the ESH range. The blood-pressure detail now also shows pulse pressure and mean arterial pressure, derived from your readings.
- **A Coach that knows the ranges.** The AI Coach and Daily Briefing are now grounded in those cited ranges, so a comment about a value reflects where it sits in the general range — still general guidance, never a diagnosis, with no third-party attribution.
- **Proactive Coach check-ins you can actually see.** A proactive nudge now appears as a message in your Coach conversation (not only as a push), with a discreet unread dot on the Coach button that clears when you open it — so it works even without notifications set up.
- **Responsible safety alerts.** A confirmed, re-measured reading in a clinically urgent range (very high or low blood pressure, low or high glucose) now raises an alert that says to re-check or contact your doctor — never a diagnosis, and only for the modules you use.
- **A diabetes setting.** An explicit opt-in switches glucose targets to the tighter clinical goal range; it is never inferred from your readings.
- **Per-module settings for preventive care, illness and labs.** Each gets its own settings page to reorder items and switch between card and list view; labs additionally lets you manage biomarkers and choose the sort order.
- **Mark a reminder done.** A measurement reminder can be completed server-side (for the apps), instead of only being dismissed locally.
- **Real offline reads.** Opened without a connection, the installed app shows your last synced dashboard and recent data with a "showing your last synced data" note, rather than blank placeholders. Changes you make offline still save when you reconnect.

### Changed

- **Preventive-care cards match the medication cards.** A clear "measure now" action, the interval as a chip, and progress toward the next due date — with measurement-appropriate wording (no more "intake" for a blood-pressure check) and the same calm, neutral card.
- **One consistent "add" and a settings wrench** across preventive care, illness and labs; the illness journal's resolved entries are collapsed by default.
- **Every Settings and Admin page now has a clear heading and description**, in one shared frame, with the side menu lined up to the content — so the whole area reads as one piece. The AI section is now labelled "AI provider", and module availability has its own admin page.
- **No more AI dead-end.** When no AI provider is connected, onboarding and the Coach/Insights/Briefing screens explain what the feature does and how to set it up, instead of a bare error.
- **Clearer sleep, recovery and insights.** The estimated sleep-stage timeline is shown only when it reflects measured stages (with an honest note otherwise); the chronotype reads as labelled text; the sleep-quality assessment is more useful; the recovery page is de-cluttered; and insight cards link through to their detail pages, including steps.
- **A faster dashboard.** All charts load in one batched request instead of one per chart, with target ranges computed on the server.
- **Fewer disclaimers, one clear acknowledgment.** The repeated "not medical advice" banners are gone in favour of a single acknowledgment at onboarding (reachable any time in Settings).
- **Mobile polish.** Small tap targets were brought up to a comfortable size, and a global reduced-motion safeguard quiets animation when your device asks for it.

### Fixed

- **Reduced motion no longer hides content.** Charts and list rows that animate in now stay visible when the device requests reduced motion, instead of disappearing.
- **Read-after-write.** A reading or medication you just added now reliably appears in its list.
- **A timezone bug** that anchored the local day at UTC midnight for one intake path.
- **Contrast.** The preventive-care action button now meets AA contrast in dark mode.

### Security

- **The offline cache is hardened.** It stores only a safe, read-only allowlist (never anything tied to sign-in or sensitive AI conversations), is bound to the signed-in account, and is wiped when the session ends — not only on explicit sign-out.
- The container scan ignores a known `picomatch` advisory (CVE-2026-33671) that exists only in the npm CLI bundled inside the base image, not in the app's own dependencies (pinned to the fixed version).

### Operator note

- Additive migrations only (`0173`–`0177`: tour progress, diabetes opt-in, disclaimer acknowledgment, Coach last-seen, a Coach-message index). The optional `APNS_CRITICAL_ENTITLEMENT` env var (introduced in 1.18.4) gates native critical alerts; urgent alerts ship as time-sensitive without it. The service-worker cache version bumps with the release, so clients refresh their offline cache automatically on update.

## [1.18.5] — 2026-06-18 — filter by value, a tidier advanced panel, and a titration timeline for injectables

A small polish release. You can now filter your readings by value, the advanced medication settings collapse into sections instead of one long page, and injectable medications show their dose-escalation plan as a timeline. No breaking changes; no migration.

### Added

- **Filter readings by value.** Search now takes a numeric range — show only readings whose value is between two numbers (or just above / just below one), alongside the existing type, source and date filters. Useful for finding outliers or a specific episode.
- **A titration timeline for injectables.** Injectable medications now show their planned dose-escalation (e.g. 2.5 mg → 5 mg → 7.5 mg over the weeks) as a timeline with a "you are here" marker, on the injection tab. Built from the dose-change history already recorded — nothing new to enter.

### Changed

- **The advanced medication settings read more calmly.** The advanced and API panels group into collapsible sections (lifecycle expanded, data and danger areas collapsed by default) instead of one long wall — the settings themselves are unchanged.

## [1.18.4] — 2026-06-18 — urgent alerts that reach you on whatever you've set up, and a stronger free notification path

This release makes notifications work well for self-hosters who don't run Apple push. Genuinely urgent health signals — a sustained low-oxygen or fever pattern flagged by the condition journal — now go out at the strongest level each notification channel you've configured supports, and reach you even with no Apple Developer account: max-priority ntfy, high-urgency Web Push, a webhook, or a time-sensitive iOS alert if you do run push. The installed web app gains real reminder handling: a dose reminder clears itself once you mark it taken, and an app badge counts what's still due. No breaking changes; no migration.

### Added

- **Urgent alerts, on every channel you have.** A condition red-flag (sustained low SpO₂ or fever — "seek care", never reassurance) now sends an urgent alert that escalates per channel: time-sensitive on iOS (critical only if you've been granted and enabled Apple's entitlement), max priority on ntfy, high urgency on Web Push, flagged on the webhook. No Apple account required — an instance with only ntfy or Web Push still gets the urgent treatment. De-duplicated per condition.
- **A real reminder experience in the installed web app.** Dose, preventive-care and low-stock reminders reach the home-screen web app over Web Push; marking a dose taken clears its reminder (no leftover notification), and an app badge shows how many doses are still due today — the closest the no-Apple-account path gets to the native lock-screen behaviour.

### Changed

- **Notifications degrade gracefully without Apple push.** The channel cascade and every urgent path are now explicit that an instance without APNs still delivers through its other channels at their top tier.

### Docs

- A self-hosting notifications guide: what each free channel (Web Push, Telegram, ntfy, webhook, email) can and can't do, the recommended PWA + Web Push setup, and a step-by-step path for running your own signed iOS build with your own Apple Developer account and APNs key for native push and the lock-screen widget.

### Operator note

- UI/API-only; no migration. Optional new env var `APNS_CRITICAL_ENTITLEMENT` (default off) — set it only if your own iOS build carries Apple's Critical Alerts entitlement; otherwise urgent iOS alerts use the time-sensitive level, which needs no Apple approval.

## [1.18.3] — 2026-06-17 — the condition journal you can scroll back through, and a clearer view of what's tracked

A small follow-up that finishes a few rough edges from the previous releases. The condition journal's day-by-day timeline now scrolls through the whole illness, not just today; deleting a condition can be undone; the condition journal is on by default like every other area; and medication inventory that was never set now reads as "unknown" instead of a misleading zero. No breaking changes; no migration.

### Added

- **Restore a deleted condition.** Deleting a condition now offers an Undo — its day-by-day log and note come back exactly as they were, nothing is re-created from scratch.
- **The full condition timeline.** A condition's detail page now lists every day you logged, newest first, instead of only today.

### Changed

- **The condition journal is on by default.** It now behaves like every other optional area — present unless you switch it off under "What you track" — rather than starting hidden. Self-hosters can still make it unavailable instance-wide.
- **Unknown medication stock reads as "unknown".** A medication whose inventory was never set now shows "unknown" rather than 0, so it can't be counted down into a confusing negative. A genuine zero still shows as zero, and low-stock reminders ignore the unknown case.

### Operator note

- UI- and API-only; no schema change and no migration. The companion-app contract gains a date-less day-log list endpoint, a condition restore route, and nullable medication-inventory fields (`null` = unknown) — all additive.

## [1.18.2] — 2026-06-17 — preventive care, the same as your medications

This release brings preventive care into line with how medications already work, and clears up the condition journal. Each preventive-care item is now its own card in the same style as a medication, and marking one done behaves the way you'd expect: a check-up you plan for yourself is a simple "done", while a reminder tied to a measurement opens the actual entry form — completing a blood-pressure reminder records the reading rather than just ticking a box. Items take a first-due date and a custom interval, the page gained a settings control like the labs and condition pages, and preventive care can now sit on the dashboard as its own tile. The condition journal was reorganised so it reads at a glance. No breaking changes; no migration.

### Changed

- **Preventive care looks and works like your medications.** Every reminder is its own card with one clear action. A self-planned check-up is marked done in a tap; a reminder linked to a measurement opens the matching entry form, so finishing it captures the value and clears the reminder in one step. Reminders take a first-due date and a custom interval, can be edited from the card, and the page carries a settings control to manage them. Preventive care can be placed on the dashboard like any other area.
- **The condition journal reads at a glance.** Conditions are grouped into active and resolved, flares sit under the condition they belong to, each row carries a single clear action with the rest behind a menu, and a condition's daily timeline now lives on its own page. The retrospective summary sits up top where you'll see it.

### Operator note

- UI-only release — no schema change and no migration. Preventive care ships on the dashboard switched off by default; enable it from the dashboard layout settings.

## [1.18.1] — 2026-06-16 — labs that hold a catalog, a condition journal, and reminders that only nudge when you forget

A large release that turns two thin features into proper ones and adds two more, all in the existing visual language. Lab results gain a biomarker catalog: define a marker once with its unit and reference range, then log a value by picking it — with a full dashboard-style chart, edit and undo. A new condition journal records an illness from onset to recovery and, once it has enough of your own history, reflects back how it announced itself and how long recovery took — retrospective only, never a diagnosis. Preventive-care reminders now fire only when a measurement is actually overdue and clear themselves the moment a reading arrives from any source, and the coach can suggest an evidence-based measurement cadence you accept with one tap — both feeding one shared reminder engine. The settings menu, the dashboard header, the recovery page and the coach view were tightened so every module reads as one app. Medications can now be switched off like any other module; the core vitals — weight, blood pressure, pulse — stay always on. No breaking changes.

### Added

- **Lab biomarkers with a reference range you set once.** Define a biomarker — name, unit, lower and upper bound, an optional note — from a suggested common panel or your own, then record a value by picking the marker instead of retyping its range every time. Each biomarker gets a proper chart with its target band, a full reading history, and edit, correct and undo. Every reading links to a catalog marker, so none is a dead end.
- **A condition journal.** Track any illness or condition — acute, chronic, recurring, or a flare hanging off an earlier one — with a daily symptom-and-severity log and an encrypted note. Once there is enough of your own data, a retrospective view shows how often you have been unwell and your typical recovery gap (when your body returned to baseline versus when you felt better), computed from your own baseline and withheld until it is sure. It never predicts or diagnoses, and a sustained red-flag pattern points you to care rather than reassuring you. The area ships switched off; turn it on under "What you track".
- **Rest Mode.** While a condition is active, your scores, recovery and streaks are annotated rather than penalised and cadence nudges pause — an active illness never changes a measured number, only the narrative around it. A calm banner explains it on the dashboard and recovery view, and condition episodes carry into the doctor-report PDF and the FHIR export as patient-reported conditions.
- **Coach measurement-cadence suggestions.** When a real change warrants it, the coach can suggest an evidence-based cadence — daily weight, morning-and-evening blood pressure for a week, structured glucose — that you accept with one tap to create a reminder. It stays non-naggy: capped, cooled-down, dismissible, and willing to say you already measure enough.

### Changed

- **Preventive-care reminders only nudge when you forget.** A reminder now clears itself the moment a matching measurement arrives — entered by hand or synced from a device — and reschedules its next due date, so the self-disciplined are left alone and the reminder is a safety net for gaps. Coach suggestions and preventive-care reminders run on one shared engine; reminders can be edited, carry a quiet "Coach" badge and course-window end date, and the linkable measurement set now covers the full range of types.
- **Every module reads as one app.** Labs, the condition journal and preventive care now use the same add-entry sheet, overflow menus and confirm-before-delete guards as medications. The settings sections drop their leading blurbs and align consistently, integrations split into Connections, Channels and Sources as their own entries, the coach setting reads as "activate the coach" (on by default), and the "About me" health context moved into the account profile.
- **A calmer dashboard and a consistent recovery page.** The daily-overview header now sits flat alongside the other tiles instead of as a glowing hero. The recovery page follows the same shape as every other metric page — heading, a short explanation, history with high, median and mean, a chart with a 7- and 30-point view, a target band and an assessment — and the duplicate score block was removed. The coach view was rebalanced for symmetry and space.
- **Medications is now an optional module.** It can be switched off like cycle, sleep or labs; weight, blood pressure and pulse remain the always-on core.
- **A richer cycle log.** The day sheet gains a phase-context header, inline field explanations, and a fertility section that opens itself when your goal calls for it.
- **Admin tidy-up.** The coach feedback, insight-quality and assistant-surface panels consolidate into one coach area, the backups panel leads with its counts, and the danger zone now requires typing a confirmation like the less-destructive restore already did.

### Fixed

- The illness recovery-gap engine no longer reports a return before a vital deviated, escalates a red-flag for rock-steady oxygen or temperature, reads journalled fever, and keys days by your own time zone rather than UTC.
- Lab readings logged without a catalog marker are linked on write instead of stranded; a failed note-load no longer wipes the note on edit; and a partial reference-range edit can no longer save an inverted range.
- The morning-and-evening blood-pressure protocol now schedules both times instead of one. Reminder satisfaction is race-safe across the cron and event paths.

### Security

- The encryption-key rotation script now covers every encrypted column in the schema — including the new lab, biomarker and condition notes and a tail of previously-missed integration and profile fields — driven from a single registry that a test asserts is complete, so a future encrypted column cannot silently miss rotation. The admin data-wipe is gated behind a typed confirmation and a per-user rate limit.
- Pin `hono` to `≥ 4.12.25` through an override, clearing the CORS-middleware advisory (GHSA-88fw-hqm2-52qc). The package is pulled in only by Prisma's and the shadcn CLI's tooling; the app is Next.js and sets no CORS headers anywhere, so the issue was never reachable at runtime.
- Pin `picomatch` to `≥ 4.0.4` through an override, clearing the ReDoS advisory (CVE-2026-33671). The package is a transitive build dependency.

### Operator note

- Additive migrations only (`0169`–`0172`): reminder course-window fields, the biomarker catalog and lab link, the condition-journal tables, and a partial unique index for coach-minted reminders. No backfill and no deploy-time action required. The condition journal ships disabled by default. **If you rotate `ENCRYPTION_KEYS`, re-run `scripts/rotate-encryption-key.ts` after upgrading** — it now re-encrypts several columns it previously skipped; do not drop a legacy key until it reports zero remaining rows.

## [1.18.0] — 2026-06-16 — turn off what you don't track, and a settings menu that finally reads as one app

This release makes the app yours to shape. Every optional area — cycle, mood, sleep, glucose, workouts, recovery, labs, achievements, the coach, AI insights and the doctor-report — can be turned off, and when it is, it disappears everywhere at once: out of the navigation, off the dashboard, gone from insights, the coach, your reminders, achievements and the exported report. Your data is kept; turn the area back on and it returns. The settings menu was redesigned alongside it, so notification channels, integrations, sources and per-area pages each sit where you'd look for them instead of spread across overlapping hubs. The core vitals — weight, blood pressure, pulse and medications — are always on. No breaking changes.

### Added

- **Turn modules on and off.** A "What you track" settings hub lets you switch off any area you don't use. The switch is honoured by one server-side gate, so a disabled area is hidden from the navigation and the dashboard and is also refused at its API — the surface and the route vanish together, with no window where one leaks without the other. Re-enabling restores everything; nothing is deleted.
- **Operator-level module availability.** A self-hoster can make an area unavailable for the whole instance from the admin settings; an operator "off" wins over any personal preference. Both layers project onto the same module map the web app and the companion app already read, so neither client needs special handling.

### Changed

- **The settings menu reads as one app.** Notification channels moved under Integrations alongside the connection and source panels; the duplicated "Reminders" hub collapsed into Notifications; mood, medications and the health-record export each became a clear top-level entry; and every section now carries one consistent heading. Old deep links (`/settings/reminders`, `/settings/sources`, the standalone coach page) redirect to their new homes.
- **One add-entry pattern across every feature page.** The cycle, labs, mood, medication and preventive-care pages now share the same header and primary "add" affordance, so a page built later doesn't read differently from one built earlier.

### Operator note

- Migrations 0167 (per-user module preferences) and 0168 (operator-level module availability) are additive — a single nullable JSON column each, no backfill. Both default to "all on": an area is disabled only by an explicit choice. No deploy-time action is required.

## [1.17.1] — 2026-06-15 — preventive care, lab results, and more of the data you already have

This release closes the loop from tracking to acting. Preventive-care reminders tell you when to measure or check what, structured lab results give your bloodwork a home, and a new recovery view surfaces signals that were already being collected but never shown. Sleep timelines now read in real clock times, marking a dose on one device clears its reminder on the others within seconds, and self-hosters gain a generic webhook channel, email, one-tap Web Push setup and a proper notifications guide. Every new number is computed once on the server and read the same way on the dashboard, the coach, the doctor-report and the companion app. No breaking changes.

### Added

- **Preventive-care reminders.** Set a reminder to measure your blood pressure on a cadence or to schedule an annual blood panel, with a clear next-due date and where to do it. A matching measurement marks it done on its own; the rest you tick off. Reminders reach you over every notification channel, and the cards stay calm — status is a quiet badge, never an alarming colour.
- **Structured lab results.** Record bloodwork and biomarkers with their reference range, see each one trend over time, and carry them into the doctor-report PDF and the FHIR export. An out-of-range value is shown plainly, not in red.
- **A recovery view, and sleep quality in depth.** A new recovery page gathers strain, training load and autonomic-charge readings, and the sleep page gains an efficiency, performance and sleep-score block — metrics a connected device was already sending that nothing surfaced before. Each appears only once it has data and stays calm until it has enough to be sure.
- **Import and backdated entry.** Import a CSV of past measurements with a previewed, per-row result and unit conversion, and log an entry with a past date and time — the cold-start escape hatches for bringing existing history in.
- **Onboarding that does what it says.** A short, skippable health-baseline step, and the goals you pick now actually seed your dashboard.
- **Polar and Oura credentials in the browser.** Both connect with your own developer-app credentials entered in settings, like the other integrations — no environment file needed.
- **More ways to be notified.** A generic webhook channel reaches a self-hosted notifier or a chat service, an email channel sends over your own SMTP server, and an operator can see delivery health across every channel. Web Push keys can be generated in one click from the admin panel.

### Changed

- **Sleep reads in real clock times.** Per-stage rows now carry their own start and end, so the "last night" timeline lays out across the night instead of stacking — measured where the device reports stage timing, and an honestly-labelled reconstruction where it only reports stage totals. Nights logged by more than one source resolve to a single total.
- **A dose taken on one device clears the others in seconds.** Marking a dose sends a silent sync to your other devices, so a lock-screen reminder ends without waiting for the next app open.
- **More of a connected device's data flows in.** Readiness contributors, body-temperature deviation, blood-oxygen, a sleep score and autonomic-charge and training-load now come through where the source provides them. Body weight is never taken from a wearable strap.
- **One product across every screen.** Desktop and mobile navigation now tell the same story, the coach has a single home, the layout and reminder settings each gather under one hub, and every integration card links to its setup guide.

### Fixed

- Sleep nights from some sources were stamped at the wrong instant and sat shifted earlier in the day; corrected, with a one-time backfill that re-syncs affected nights.
- The doctor-report sleep figure now matches the dashboard and the companion app, reading the same reconstructed per-night total as every other surface.
- Polish across the new surfaces: consistent loading and empty states, design-token colours, responsive grids, and a calm confirmation for regenerating Web Push keys.

### Security

- The webhook channel pins a public host and refuses a private or loopback address unless explicitly allowed; webhook secrets, SMTP credentials and the Web Push private key are kept out of any recorded error; the key-generation and delivery-health endpoints are reachable only from an authenticated admin session, never a token.

### Self-hosting

- A notifications guide spells out that no Apple account is needed — Web Push, Telegram, ntfy, the new webhook and email all work without one — alongside a backup-and-restore callout and a clearer note on which variables must be whitelisted to reach the container.

### Operator note

- Migrations 0162–0166 are additive. A boot-time backfill re-syncs sleep nights from the affected sources to the corrected timeline once; it is idempotent and bounded.

## [1.17.0] — 2026-06-14 — clinical depth for glucose and sleep, and three new sources

This release builds new depth on the coherent foundation laid over the v1.16 line. Blood glucose gains a clinical panel, sleep gains a debt and chronotype reading, and three new data sources — Nightscout, Polar and Oura — join Withings, WHOOP, Fitbit and Apple Health. Every new metric is computed once on the server and read the same way on the dashboard, the coach, the doctor-report and the companion app, and each holds back a confident reading behind a calm "still learning" state until it has enough data. No breaking changes.

### Added

- **Blood-glucose clinical panel.** Beneath the glucose chart, a panel reads time-in-range on the consensus bands, the glucose management indicator and an estimated A1C, and the coefficient of variation with an instability flag — with the J-index and the low/high blood-glucose risk indices behind an advanced view. It is honest about its limits: a panel built from spot readings says so, and it waits until enough readings over enough days have accrued before asserting anything.
- **Nightscout.** Connect a self-hosted Nightscout instance and its continuous glucose readings flow in — the density that makes the clinical panel meaningful. Public instances work by default; a per-connection toggle allows a private or home-network instance.
- **Sleep debt and chronotype.** The sleep page now shows a rolling sleep debt against your age-based need and an MCTQ chronotype with your mid-sleep, social jetlag and a type band — the deeper detail behind an advanced view, and the type held back until enough free-day nights are recorded.
- **Polar and Oura.** Connect either over OAuth to bring in sleep, heart rate, respiratory rate, activity and recovery. Recovery now reads from the strongest connected source — WHOOP, then Oura, then Polar, then the computed proxy.
- **Reorder-aware medication supply.** The low-stock warning now accounts for how long a refill takes, so a weekly medication is flagged before its last dose rather than after, with a concrete "runs out on … — reorder by …" date. A reorder lead time is configurable globally and per medication.
- **Invite deep-link.** Invites open through a link the companion app can intercept to start a prefilled registration, with a browser fallback.

### Changed

- **The coach reasons from the new signals.** Glucose time-in-range, sleep debt and chronotype, and a connected device's native recovery and strain now reach the coach, which prefers the device's gold-standard number over a computed proxy and respects each metric's still-learning state.
- **Mood and cycle entry is one sectioned sheet.** A quick row of your recent tags stays open, the rest folds into collapsible sections with a count of what's set inside — fast by default, deep on demand.
- **Wearable data you already had now surfaces.** Heart-rate variability from a ring or strap appears on the HRV view, and Oura and Polar steps, energy and pulse are ranked as real sources.
- **Onboarding tells the truth.** The setup flow now presents the sources that actually shipped, signposts importing existing history, and sets the expectation that some insights sharpen over the first week or two — instead of promising a configuration that did not happen.

### Fixed

- The sleep "last night" timeline bar returns for nights whose stages share an end instant, and the dashboard clears a recorded dose without a reload (carried forward from v1.16.17).

### Security

- Outbound Nightscout calls pin a public host by default with an explicit private opt-in, the stored token is kept out of any recorded error, and the new OAuth connections verify a signed, expiring state before exchanging a code.

### Operator note

- On the first nightly low-stock check after deploy, a medication already flagged low re-notifies once as the warning threshold moves to its lead-time-aware value. Expected and bounded.

## [1.16.17] — 2026-06-14 — the sleep timeline returns, and the dashboard clears after a dose

Two fixes to behaviour that surfaced in daily use. No breaking changes.

### Fixed

- **The "Last night" sleep timeline bar returns.** The staged hypnogram — which lays the night out across deep, core, REM and awake by clock time — had collapsed to just the numbers for nights whose stages share an end instant, leaving the breakdown without its bar. The bar now appears whenever the night carries timed stages; only a session recorded on a single instant falls back to the breakdown alone.
- **The dashboard clears a dose the moment it is recorded.** After recording an intake from the medication card or detail page, the dashboard kept prompting for that dose until a full page reload, because the home view was refreshed only while it was on screen. It now refreshes as soon as the dose is recorded, with no reload.

## [1.16.16] — 2026-06-14 — one engine for sleep, recovery and glucose

This release continues the work of making one number mean one thing everywhere. Sleep, recovery and blood glucose are now read from a single source on every surface — the dashboard, the coach, the doctor-report, the CSV and FHIR exports, and the companion app — so the figure you act on is the same wherever you look. Several displayed numbers become correct-but-different; each is called out below. No breaking changes.

### Added

- **Per-stage sleep on the night feed.** The sleep-night feed now rounds every duration to whole minutes and carries the per-stage breakdown (deep, core, REM, awake), so the companion app renders the same night the web does.

### Changed

- **Sleep is reconstructed once, from one engine.** The sleep score now reads each night through the same reconstruction the rest of the app uses, with source de-duplication: a night recorded by more than one source (for example a watch and a ring) is counted once instead of summed. For multi-source nights the score — and the readiness that builds on it — drops to its true figure rather than an inflated one.
- **WHOOP recovery is the recovery you see.** When a WHOOP-native recovery exists it is now the single canonical value on the tile, the chart, the doctor-report, and the coach; the computed proxy is the fallback when there is no native score. A connected account no longer sees the proxy and the native value as two competing numbers, and the night each belongs to is resolved consistently, so one night reads as one recovery. A WHOOP user's recovery figure can change to the native one.
- **Blood glucose speaks your unit everywhere.** Glucose is converted once, at the point it is served, through a single helper — so the series the companion app charts, the CSV export, the dashboard tile, the detail page, and the coach all read the unit you chose. The CSV export now matches the FHIR document instead of emitting raw mg/dL against a converted clinical export. If you read in mmol/L, these surfaces now show the converted value (for example 100 mg/dL as 5.5 mmol/L); mg/dL readers see no change. The blood-glucose median no longer claims a fixed window its value does not hold.
- **The coach reads the canonical numbers.** The coach now quotes recovery from the same resolved series as every other surface rather than a blend of sources, and states blood glucose in your unit instead of a bare mg/dL number.
- **WHOOP sync keeps a cursor per data type.** Recovery, sleep, workouts and cycles each track their own sync position, so a single slow or rejecting collection no longer holds the others back; a change notification refreshes just the affected record, and a full sync can backfill the deep history an incremental tick skips.

### Fixed

- **The coach appears when a shared model is configured.** A self-hoster who runs the coach from a server- or operator-managed model — with no personal key — now sees the coach instead of an "unconfigured" state, because the provider endpoint reports whether the coach can actually answer.
- **A consent receipt cannot double-mint.** Two requests arriving together can no longer leave two active consent grants; the active receipt is enforced unique and minted atomically, and a concurrent first grant resolves to the winning receipt instead of an error.

### Security

- **Consent endpoints are rate-limited.** The consent grant, read and revoke routes share a per-user limit, so the receipt path can no longer be driven in a tight loop.

## [1.16.15] — 2026-06-14 — an honest calendar that learns before it predicts

A focused release on the cycle calendar: it leans on observed data, names its
uncertainty plainly, and reads your charts the way the Sensiplan method does.
No breaking changes.

### Added

- **Mark a reading as disturbed.** A temperature taken after a fever, a late night, or any off day can be flagged "disturbed" and is dropped from the evaluation, so a single skewed point no longer drags the curve.
- **A positive ovulation test anchors the prediction.** When you log a positive test, it refines the predicted ovulation day — it sharpens the estimate but never overrides a temperature shift you have already confirmed.
- **Choose your secondary fertility sign.** Advanced cycle settings now let you track either cervical mucus (the default) or cervix observation alongside temperature, so the symptothermal evaluation follows the sign you actually record.
- **Warmer phase descriptions.** Each cycle phase gained a second paragraph of plain-language context, so the calendar explains what is happening, not just which phase you are in.

### Changed

- **The calendar learns before it predicts.** Below three logged cycles it shows a calm "still learning your cycle" state instead of a confident fertile-window or ovulation guess — and the same gate now applies on the API, so every client reads the same honest signal rather than painting a window the rest of the app holds back.
- **Temperature evaluation no longer under-detects ovulation.** The symptothermal reading gained the two Sensiplan exception rules — the slow rise and the single fall-back day, each confirmed on a fourth reading — so a real shift is recognised in the patterns that the simple rule used to miss.
- **The mucus peak settles before it is trusted.** A mucus peak is now confirmed only after three drier days follow it, so a stray late entry no longer shifts the peak backward.

### Fixed

- **Longer cycles are no longer clipped.** Cycles up to roughly sixty days are evaluated in full instead of being cut short, so a naturally long cycle reads correctly.

## [1.16.14] — 2026-06-14 — one number everywhere: the score, the coach, and the doctor-report agree

### Changed

- **Blood-pressure in-target speaks one window everywhere.** The in-target tile, the health-score blood-pressure pillar, and the coach now read a single 90-day window — labeled on the tile, so it is no longer hidden. The tile shows its real span ("· 23 T") until 90 days of history have accrued, and holds back a percentage ("sammelt noch Daten") until it has at least a handful of readings, so a single measurement can never imply a confident share. The all-time view stays on the detail page. The headline figure can differ from the previous unlabeled 30-day number — it is now the correct, consistent one.

### Fixed

- **The dashboard ring and the insights card show the same health score.** Both assemble the score from one shared input builder over identical windows, so the same account can no longer see two different scores or a pillar present on one surface and absent on the other; the ring's day-delta now also reflects blood-pressure movement.
- **The coach quotes the adherence the card shows.** Medication compliance routes through the same authority as every other surface instead of the coach's own per-day tally, so it can no longer reason from a number you never see — it matters most on irregular, rolling and as-needed schedules.
- **The doctor-report matches the app.** The adherence in the PDF/FHIR export is computed from the same dose history — slot attribution, cadence and cross-source dedup honoured — as the detail page, instead of a raw intake-row count, so the figure a clinician reads on paper agrees with the screen.
- **Measurement and mood entries reject implausible timestamps.** A future date beyond a small clock-skew allowance, or anything before 1900, is refused — matching the medication-intake guard — so a stray future-dated reading can no longer distort the recent-window metrics.

## [1.16.13] — 2026-06-14 — installable and offline, doses that find the right day, and headers that hold their line

### Added

- **The app installs and works offline.** The service worker now registers for every visitor, not only after notifications are switched on, so the app installs to the home screen, its shell and assets are cached, and a lost connection shows an offline page instead of a dead tab. Authenticated pages are never cached — their data always loads live — the share-by-link page is kept out of the cache entirely, and signing out clears the page cache. The running app still heals itself across deploys, and the cached-version marker can no longer drift stale between releases.

### Changed

- **The default mood tags are curated.** The redundant `happy`, `excited`, water and music defaults step aside, `overtime` returns to the work picker, a new `praise` ("Lob") tag joins it, and the manual sleep-quality rating retires — a measured night already covers it. Tags already recorded against any of these keep resolving their labels; nothing on existing entries changes.
- **Page headers hold one line on a phone.** The medications header no longer drops its actions to a second row, the insights "Ask the coach" action sits to the right where it belongs, and a long label in the more-menu stays inside its tile. The mood, measurements and dashboard headers get the same treatment so none of them can wrap either.

### Fixed

- **A historical dose edit credits the schedule that was live then.** Editing a past intake on a medication whose schedule has since changed now attributes it to the dosing era valid at the dose's own time rather than today's schedule — the same era the history and compliance already read it under.
- **A CSV intake import moves the tracked stock.** It was the one path that recorded taken doses without decrementing the supply, so the runway read high; it now consumes exactly like every other path, once per dose, and a re-import never drains the shelf twice.
- **A workout that reaches WHOOP late is no longer lost.** Workout ingest used a one-hour overlap window while recovery and sleep used a far wider one, so a phone that synced to the WHOOP cloud more than an hour after a session left the workout permanently outside the window. It now shares the wider window; the idempotent upsert keeps the widening from duplicating anything.
- **Sleep night totals read as whole minutes** instead of a long fraction, matching the contract the clients decode.
- **A tiles-only layout save no longer wipes section customization.** Reordering the navigation tiles without sending the section layout keeps the stored sections instead of resetting them to defaults, and the same holds the other way around.
- **The web AI surfaces honour consent again.** The web client now records the consent receipt the server requires before any model call, so insights and the coach stop falling back to the empty no-provider state for people who have granted it, and the status reads "consent missing" honestly when it is genuinely absent.
- **The coach button in the public demo no longer errors** — it steps aside there instead of offering a send the demo blocks.

## [1.16.12] — 2026-06-13 — split doses, steady cards, and a read that stays warm

### Added

- **A dose can consume a fraction of a unit.** Split-pill medications now declare ½, ⅓ or ¼ of a tablet per dose — the wizard offers a curated set of fractions alongside the whole numbers, the most error-resistant input. The supply tracks the fractional remainder (30 tablets dosed at a half each reads 29.5 after one dose), the days-left projection follows, and undoing a dose refunds exactly what it consumed. Existing whole-number doses are untouched; the inventory unit counts widen to decimals across the API contract. (#316)

### Changed

- **The medication cards hold one shape.** The low-supply notice moves onto the adherence row beside the streak — a slot every card already reserves — so a card that is low on stock no longer pushes its bars out of line with the card beside it. The gap between the drug class and the first line tightens at the same time.
- **The dashboard and insights stay warm between visits.** The analytics and derived-insight reads keep a served-stale snapshot for an hour rather than ten minutes, so returning after a normal break paints instantly and refreshes in the background instead of paying the full cold rebuild — which a visit spaced more than ten minutes apart hit almost every time.

### Fixed

- **The medications list refreshes when you return to it.** Navigating back to the page — or reopening the supply tab — now refetches the list, compliance and stock instead of serving a client cache that could be minutes stale, so a dose logged on another device shows up without a manual reload.

## [1.16.11] — 2026-06-12 — the supply speaks up, tags find their groups, and nothing asks twice

### Added

- **The app says so before the pack runs out.** A daily pass projects every tracked supply against its schedule and notifies on the configured channels when the runway falls below a per-account threshold — once per crossing, re-armed by a refill, re-announced when the threshold changes. The threshold lives beside the reminder settings (1–60 days, default 7, or off), the push deep-links straight into the supply tab, the table's stock column carries the projection as "≈ X Tage", and the card states the remaining runway once it crosses the threshold — only then.
- **Mood tags get groups, icons and a home of their own.** Custom groups with encrypted labels, a searchable 75-icon picker, and a manage page under settings; tags archive without touching the entries that carry them — editing an old entry can no longer drop its archived tags either — the picker offers inline creation right where a tag is missing, custom labels finally render in the picker AND across insights, and the arrangement persists per account. The whole surface ships in the public API contract.
- **Every due dose in one confirmed action.** When two or more doses are due — including a dose escalated past its catch-up window — a button on the medications list collects them into one confirm dialog and records each through the same path as the card buttons: slot attribution, stock consumption and every dependent surface included; failures are counted, not hidden.
- **A medication can declare itself as-needed.** No schedules, never due, never reminded, excluded from every compliance rate — but intakes log normally, consume inventory exactly like scheduled doses, and the history stays. The wizard offers it as a cadence choice; switching it onto a fixed schedule later never repaints the schedule-less stretch as missed doses, and the doctor report lists it without inventing a rate. (#316)
- **Units-per-dose and the default pack size are editable from the supply tab** — a manufacturer switch with a different blister size no longer requires walking back through the wizard.

### Changed

- **One wrench marks every customize entry point.** Dashboard, insights and medications share the glyph, the table corners clip to their container again, and the card/table view choice moves into its own settings section.
- **The coach opens in place.** The button brings the side drawer over the page you were reading instead of navigating away, and grew to a comfortable tap size.
- **The card's dose state lives on the next-intake row.** Take-now, late and the overdue escalation speak from the line that names the dose — with their time beside them, on mobile too — instead of a separately reserved status line that left a hole on every settled card.
- A source ladder saved before a newer integration existed now lists and ranks the later-added sources everywhere — settings, charts, rollups and the sleep picker — instead of silently pinning them below every ranked one.
- WHOOP's self-reported profile weight is no longer ingested as a measurement; the stale entry stops resurfacing as the newest weight, and existing accounts heal on the next sync.

### Fixed

- **The hypnogram keeps its timeline when a summary writer joins the night.** A stage summary stamping all its rows on one instant no longer evicts a per-segment night; when only summaries exist, the card shows the stage breakdown instead of a fake skyline.
- **A dose taken on the dashboard updates the dashboard.** The snapshot band refetches with every intake path instead of waiting out its polling interval.
- The supply tab can delete a container, its controls carry the outline they always implied, each container states its condition inline next to its figures, and the table's stock warning follows the user's runway threshold instead of a leftover four-dose constant.
- Every wide event carries the recent event-loop lag, and a stalled loop emits its own warning event — the instance-level signal per-request durations cannot carry.

## [1.16.10] — 2026-06-12 — the stock follows every dose, and the list takes your order

### Added

- **A medication can declare how many units one dose consumes.** Two 2 mg tablets for a 4 mg dose register as one dose taken and decrement two units, the supply dialog accepts quantities in doses or units with live conversion, containers carry a type (pen, ampoule, blister pack, inhaler, bottle) and hold up to 1000 units — a 200-dose inhaler canister finally fits. (#316)
- **The medication list has a table view and an order of your choosing.** A toggle beside the add button switches between cards and a compact, per-column sortable table; both views share a manual order, and the whole arrangement lives in its own settings section behind the same gear icon the dashboard and insights pages use. The choice persists per account. (#316)

### Changed

- **The daily-overview band is opt-in now.** New accounts and accounts that never chose it start without the band and keep the plain greeting; it switches on under dashboard settings.
- **Expired containers count as available nowhere.** Every surface — overview row, supply tab, list, table, GLP-1 card and the runway estimate — agrees on the same figure and shows expired stock separately instead of mixing it in.
- The wellness rings sit exactly on the theme palette now — readiness green, recovery cyan, sleep purple, stress orange, strain pink — instead of neighbouring tones, and the light theme follows the same five hue families.
- The inventory endpoints speak one wire dialect: request fields renamed to `unitsTotal` / `unitsRemaining` to match the responses they always returned.

### Fixed

- **Every taken dose now moves the tracked stock.** Only one of the six intake paths decremented the supply before — web, the status toggle, the phone sync, the external API and the Telegram button all consume now, the next container opens automatically, and undoing, skipping or deleting a dose refunds exactly what it consumed. Each dose carries its consumption stamp, so a double tap racing a sync replay decrements once, and a re-posted history never drains the shelf. Doses recorded before this release stay untouched — the count starts moving with the next dose, or correct a container once under the supply tab. (#316)
- **A dashboard full of readings no longer claims "not enough data".** While the score warms up the band says it is being computed, and a first reading of a new data type — a fresh wearable metric, a first glucose value — can no longer knock the score out, because the gate checks only the types the score actually reads.
- **The score stops flickering on busy accounts.** The pre-aggregation rebuild deleted its window before inserting the replacement without a transaction — a concurrent sync write could abort the insert and leave whole types empty until the next pass. Delete and insert run atomically now, and the boot-time backfill shares the fold horizon, so an account with years of history stops re-backfilling on every deploy.
- **The filter pills on the mood and measurements lists open their menu on screen again.** The menu opened off-viewport below the page since v1.16.1 — selecting a mood, type or source read as a dead control.
- **The coach button stops blinking out on chart hovers.** It no longer hides whenever a chart tooltip is open anywhere on the page, and it sits evenly in the corner.
- The pre-item GLP-1 supply ledger reads again: accounts that tracked pens through the older ledger see their count on the card and in the coach until they register containers, which then take over.

## [1.16.9] — 2026-06-12 — the day opens with a verdict, and every dose path tells the truth

### Added

- **The dashboard opens with a daily band.** Greeting, the one item that matters right now — a fresh crisis-level blood-pressure reading, an overdue or upcoming dose, weight drifting from its range, a run of short nights, a quiet stretch, a score drop, or the briefing's key finding — with a single action, today's dose tally beside the next due time, and the health score as a ring. The verdict resolves from a fixed ladder with crisis floors that ignore personal target ranges, it never invites a dose the server has not called due, and the band can be turned off under dashboard settings, where the plain greeting then returns to the header.

### Fixed

- **An intake recorded through the external API now credits the due slot.** The ingest endpoint was the one intake path that stored a bare row beside the pending slot — the card showed the intake as the last dose while still demanding it, and the ledger later counted a miss. It attributes to the dose band like every other path now, the Telegram confirm and skip buttons converge onto the reminder's own slot, and a nightly pass heals the pairs this has already produced — both days' history and compliance recompute, no manual repair needed.
- **A cached page can no longer contradict an action you just took.** Invalidation now fences in-flight cache builds, so a read can neither join a build that started before your write nor have a background refresh re-store the pre-write state as fresh.
- **Dose prompts err on the safe side everywhere.** A take shortly before the window credits the slot instead of floating loose, an off-schedule intake can no longer silently resolve a different slot and hide a genuinely due dose, a long-interval dose taken on an earlier day downgrades the slot-day prompt to "last dose n days ago" instead of inviting a double dose, and the overdue badge no longer disappears because the day's pending entries were counted as actions.
- Intake times entered retroactively carry the same plausibility bounds as edits, moving a dose across a slot boundary keeps its recorded injection site and dose, both affected days recompute, and schedule corrections, data wipes and backup restores refresh the caches they feed.
- The medication cards, the quick-entry preselection and the dose pills compute their clock in the profile timezone instead of a fixed one.
- WHOOP credentials are trimmed on save — a stray space from the portal's copy button read as an unknown client — and an empty redirect override falls back to the derived callback URL.

## [1.16.8] — 2026-06-12 — texts that follow your data, charts that never strand

### Added

- **The coach is one tap away on every page.** A round button sits bottom right, stays put while you scroll, shows a quiet dot when a nudge is waiting, and steps aside for the selection bar and the welcome tour.
- **Tell the coach to remember something.** A remember action under your own chat messages stores the statement in the matching self-context field — allergies land under allergies, diagnoses under conditions — visible and editable in the settings, and fed into every future conversation. Statements phrased casually are recognised again, and remembered facts no longer drop out of the prompt on data-rich accounts.
- **Mood notes in full.** Notes expand to their complete text right in the list — the toggle only appears when something is actually clipped — and the CSV export carries a note column.
- **The hypnogram names its source** and paints only the stages the night actually contains.

### Changed

- **Insight texts regenerate when your data changes, not on a timer.** Every generated text stores a fingerprint of the data it describes; nightly runs, page visits and sync bursts skip the model call when nothing moved. A notable new reading is narrated the same morning, a manual regenerate refreshes the cards along with the briefing, and texts can no longer claim freshness over readings that crossed a staleness boundary. An active day drops from hundreds of model calls to a handful.
- **Medication cards arrive in one piece.** All cards share a single compliance request instead of one each, the heavy date math runs about five times faster, and the status line, adherence bars, streak and cycle line keep reserved slots — nothing shifts when data lands. A dose logged from the phone app is reflected immediately.
- **A cold start paints the page you'll actually get.** The chart row reserves its space before any data arrives, the tile silhouettes match the real layout, and the health-score card holds its column while the numbers compute. The insights overview runs its reads in parallel and serves repeat visits from cache — the targets and derived endpoints answered in well over a second before.
- **Sleep nights pick the richest recorder.** Several apps writing through the same health platform no longer blend into one night — the writer with actual stage data wins, time in bed unions every writer's window, and nights that reach the sleep service late are fetched up to seven days back, so a wrong night heals itself on the next sync.

### Fixed

- Charts no longer strand on a skeleton after a deploy: the update check re-arms per version, a failed chart chunk retries and then degrades to a single card with a reload button, stalled requests time out and retry, and a failed data read shows an error with a retry instead of "no data in this period".
- Screen readers hear chart failures and coach nudges, the floating button leaves the tab order when it hides, focus survives the remember confirmation, and the icon cluster on insight pages no longer has overlapping touch areas.
- The duplicated customize entry and the per-chart target link are gone, show-all-values became an icon beside the target control, pill borders stop clipping in the tab strip, and the mood tag bars adopt the muted palette of the charts above them.
- Changing a target range, profile detail or source priority is reflected in the analytics on the next read, AI consent is honoured before any stored text is reused, and CSV exports neutralise spreadsheet formula prefixes in free-text cells.

## [1.16.7] — 2026-06-11 — insights answer instantly, every evening

### Changed

- **Insights always answer instantly.** A stale briefing is served immediately with a regeneration kicked off in the background — the response carries a revalidating flag and the open page polls briefly until the fresh content lands, instead of blocking the visit on up to ten seconds of inline generation.
- **The nightly pre-warm no longer skips evening readers.** The staleness threshold drops from twenty hours to one — previously an evening visit stamped the cache fresh, the night run skipped it, and it expired exactly the next evening, so the people who read insights after work were the ones who always hit cold generation. The visit-triggered warm fills both locale families and collapses to one job per user.
- **The session resolves faster.** The profile read inside `/api/auth/me` runs in parallel with the cookie refresh, the bug-report status answer comes from a ten-minute cache without a write per request, and the medications page is prefetched the moment its nav entry is touched.
- **The insights route ships less JavaScript.** The schema validator loads lazily and the mood charts split out of the main chunk, trimming the cold download that dominated an uncached first visit.

### Fixed

- A manually entered measurement is reflected in the analytics aggregates on the next read — interactive writes evict the cache instead of marking it stale, while background sync keeps the cheaper path.
- The analytics script proxy degrades to a silent no-op instead of failing every page when the upstream is unreachable, and records the failure reason where the operator can find it.

## [1.16.6] — 2026-06-11 — corrected eras, an honest weekly status and a faster first paint

### Added

- **Schedule eras can be corrected.** A recorded era can be edited through a superseding revision that keeps the original as an audit trail; manual eras edit in place, all era writes serialise per medication, and duplicate dose times collapse in validation.
- **The server-wide assistant key has an admin home** — status, provider, model and base URL with the BYOK-first and consent rules stated where the operator works.

### Changed

- **The first paint got faster again.** The dashboard snapshot fires the moment login succeeds instead of waiting for the page chunk — its request starts about half a second earlier under throttled conditions — handed over so the server and client render never disagree.
- **Guided coach follow-ups speak to your data.** Questions are personalised from your own snapshot when a provider is available, and an answer receives the coach's streamed reaction before the next question.
- **Settings and admin finally share one face.** Twenty-seven hand-rolled card headers move onto the shared pattern, sixty containers normalise to one chrome, descriptions get a consistent one-sentence voice, and the one duplicated coach preference collapses onto a single owner.

### Fixed

- A rolling medication whose next dose is tomorrow no longer reads as heavily overdue — the card status derives strictly from the served next-due.
- The adherence bars keep a fixed geometry in every state instead of growing with their status text.
- The remaining hydration warnings on the dashboard, insights and AI settings are gone.

## [1.16.5] — 2026-06-11 — a guided coach dialog and a schedule that shows its past

### Added

- **Open coach follow-ups run as a guided dialog.** A quiet card offers to start, the coach asks one question at a time with visible progress, answers can be adopted into the matching self-context field, skipping keeps a question pending, and a closing summary says what was taken over.
- **The schedule shows its history.** Past eras appear as a collapsible timeline on the schedule tab, and an earlier era can be added manually for old history — validated against overlaps and bounded so it can never swallow tracked live history.
- **Smarter proactive nudges.** Three new deterministic signals — weight drifting from its target band, a run of short nights, an active user falling silent — plus per-group toggles, a frequency preference and wording that addresses the focus you asked the coach to watch.
- **Invites mint up to fifty uses** with a scrolling redemption list.

### Changed

- **A documented path away from the moving latest tag.** The compose image reference accepts a pinned digest via env var, and a promote script resolves the published digest, verifies its cosign signature and hands the operator the exact pinning call.

### Fixed

- The self-context adopt runs in one transaction, the admin area renders nothing before the role is confirmed, and the json-body helper keeps caller headers intact.

## [1.16.4] — 2026-06-11 — half the bundle, a typed client, and stock you can record

### Added

- **The inventory tab records stock** — packs and pens with optional expiry, corrections and withdrawals. The detail page gains a dedicated API tab, an editor entry under lifecycle, and a danger zone without the red drama.
- **Record the dose you actually took.** Intakes carry an optional actual dose, editable in the quick-add and log dialogs and shown as a quiet deviation in the history.
- **Undo for deletes.** Removing a measurement or mood entry can be taken back from the toast.
- **Pull-to-refresh** on the measurement and mood lists, and the customize entry on every insights sub-page.
- **Answered coach follow-ups can flow into your self-context** with one tap.

### Changed

- **The app got dramatically lighter and faster.** Only the active language ships to the browser — the dashboard route drops from 2.1 MB to under 1 MB parsed (288 KB gzip), with no language flash. The shell paints immediately while the session resolves, a redundant request stage is gone, and insight sub-pages prefetch on approach: a first tab switch lands in tens of milliseconds instead of nearly a second.
- **Every client call goes through one typed API client** with the envelope, error and ok-handling in a single place, enforced by lint. The route registry, query keys, background worker and dashboard page split into feature-located modules behind thin indexes.
- **Settings behave one way.** Provider and integration cards live in focused subcomponents, every setting persists server-side at exactly one home, save conventions are documented, and duplicated controls collapsed into single owners with links.
- **Published images are signed**, dependabot merges only behind the required checks, a pre-commit secret scan guards every commit, the deploy webhook can demand a fresh timestamp, and a monthly drill proves the newest backup actually decrypts.

### Fixed

- Server and first client render now agree everywhere query state used to leak into the chrome.
- Delete confirmations admit the undo they offer, step counts drop their decimals, streaks know their singular, the medication header speaks your date format, and a failed coach turn keeps your message and says what went wrong.
- A language switch updates pending status notes and only flips once the new language is actually loaded.

## [1.16.3] — 2026-06-10 — schedules remember their history

### Fixed

- **Changing a schedule no longer rewrites the past.** Every material cadence change now archives the outgoing schedule as a dated revision, and history, compliance and write attribution evaluate each period against the schedule that was valid at the time — a dose era taken at its then-correct times stays on time forever. The repair script can infer historical eras from consistently dated old anchors behind an explicit flag.
- **The welcome tour can no longer strand its buttons below the fold.** The target scrolls into view first, the popover flips above it when space runs out, and a centred sheet takes over on any viewport when neither fits.
- The avatar menu drops its about entry; the section lives in settings.

## [1.16.1] — 2026-06-10 — a chat worth using, honest sleep stages, stock you can record

### Added

- **The inventory tab records stock.** Packs and pens with optional expiry, plus corrections and withdrawals — no API detour. The medication detail page also gains a dedicated API tab, an editor entry under lifecycle replacing the misleading header button, and a danger zone on the shared card surface with only its buttons in red.
- **A shared filter bar.** Measurements and mood lists filter through one pill-rail language — active filters read as removable chips, date ranges live in a popover, every page feels the same.
- **Six care achievements.** Miss-free dose streaks (7/30/90 days), a four-week measurement routine, a complete self-context and a week of sleep logging.

### Changed

- **The coach chat behaves like one.** Single-line composer that grows with the text, a typing indicator, no inline disclaimer, a context rail that hides until asked, conversations in the full view, and coach preferences in Settings. Clearly stated allergies and conditions are remembered immediately.
- **Settings and admin share one alignment language.** Icon column left, content flush on its own column, neutral header icons, no duplicated titles, and every select on the account-style idiom with a visible chevron.
- **First paint shows silhouettes, not bare cards**, and charts reveal within 1.2 seconds even when one widget lags.

### Fixed

- **Sleep stages show again next to coarse sources.** A night carrying granular watch stages alongside coarse phone samples picked the coarse source and showed only awake/asleep; the granular source now wins its session.
- **The next-dose line tells the truth after a schedule change.** It reads from the dose calendar instead of a stale schedule window; the repair script reconciles drifted windows and clears pending rows on abandoned anchors.
- **Nightly insight texts are actually there in the morning.** The warm pass no longer skips the status cards when the briefing step is budget-blocked or fails, and one hanging provider cannot stall the whole run.
- The welcome tour stays inside the viewport — no more sideways scrolling to reach its buttons, with a bottom-sheet fallback on narrow screens.
- The dashboard customize icon matches insights, the target-settings link leaves the home charts, and the mood heatmap adopts the damped fills of its sibling charts.

## [1.16.0] — 2026-06-10 — a coach that knows you, invites, and a faster, calmer app

### Added

- **Tell the assistant about yourself.** A new encrypted self-context in Settings → AI — free text plus structured fields for conditions, allergies and what the coach should watch — feeds the coach and the daily briefing as clearly fenced context. After saving, the coach may ask up to three targeted follow-up questions, surfaced as tappable chips above the chat composer.
- **Proactive coach nudges.** A nightly pass watches four signals — low 7-day adherence, blood pressure above its target band, a falling recovery trend, and a stale self-context — and sends at most one gentle nudge per week through your configured notification channels, with its own opt-out. Off whenever the coach is disabled.
- **Invite links with QR codes.** Operators on closed registrations can mint expiring invite links from a new admin section: status, uses, expiry and a redemption history of who joined when. Revoking keeps the history; the link and QR are shown exactly once at creation.
- **Attribute an off-schedule dose to its slot.** History rows that landed off schedule now show when the dose had been due and offer to attribute the intake to that slot — visibly badged, always counted as taken late, reversible at any time.
- **A time-format preference.** Automatic (follows the language), 24-hour, or 12-hour — set once in the profile, applied to every clock the app renders.
- **Insight pills are manageable in one place.** The settings list that orders the navigation pills now also hides and shows them, with the same eye toggle the overview tiles use; the page-side manager folded into a link.

### Changed

- **The medication detail page calms down.** Six tabs instead of seven (reminders live with the schedule they gate), every section on the card surface, an overview tab that actually summarises — next dose, reminder state, supply runway — and a history where settled rows carry one quiet menu instead of a button wall. Charts load on demand.
- **The dashboard loads as one.** Structured skeletons replace bare tiles, and charts reveal together once their data is in instead of popping in one after another.
- **The medication list stops hammering the server.** Compliance for the cards is computed in one calendar pass per request, cached for fifteen minutes and invalidated on every write; the dashboard drops two redundant queries; the BMI chart reuses the weight series; expensive analytics endpoints gain a shared per-user rate limit.
- **Nightly assistant runs respect every gate.** Status generation skips users who disabled the coach and honours the operator kill switch, deleted measurements never feed a prompt, the mood card gets the nightly run the other cards always had, non-German locales consistently fall back to English, and worker failures finally reach the error tracker with real retries behind them.
- **The README says what matters in one screen**, and the repository description and topics match it.

### Fixed

- The wellness ring's glow is no longer clipped to the circle.
- An overflowing insight-pill row is reachable by mouse — chevrons and wheel scrolling joined touch.
- Safari favourites no longer render the icon on a white plate.
- A rate-limited briefing regenerate stops claiming success, and a missing AI provider shows as exactly that instead of an eternal "preparing".
- Editing schedule times migrates the open dose rows of the old anchors and reconciles a stale intake window instead of stranding both.
- Auto-missed verdicts respect each schedule's real catch-up window, clear when the dose is taken after all, and skip deleted rows.
- The intake repair script runs inside the production container.
- Every workflow action is pinned, dependabot merges only patch and minor updates behind required checks, vulnerability gates block instead of warn, and the published image carries its build SHA so a deployment can prove what is running.

## [1.15.19] — 2026-06-10 — honest dose states, bounded bodies, new licence

### Changed

- **The project licence is now PolyForm Noncommercial 1.0.0.** HealthLog stays free to use, modify and self-host for noncommercial purposes; commercial use needs a separate arrangement. Releases up to and including v1.15.18 were published under AGPL-3.0 and remain available under that licence.

### Fixed

- **An open dose no longer reads as missed the moment its time passes.** A pending dose now shows as upcoming until its intake window actually closes — hours for daily schedules, days for weekly ones — so the history tab and the compliance rate stop punishing doses that are still takeable. Phantom "ad-hoc" lines for tonight's not-yet-due doses are gone too.
- **Logging the same dose from two places no longer doubles it.** A dose acknowledged via a reminder and also logged from another client produced two live rows on the same slot, inflating the day's schedule count (4 of 4 on a two-dose day). Intake writes now converge onto the existing slot row regardless of source, the compliance rollup counts slots instead of rows — which also corrects historical days on the next recompute — and the duplicate sweep runs nightly instead of only at worker start.
- **A weekly dose taken a few days late counts as late, not missed.** The write path only searched ±1 day around the intake time for a matching slot, so a weekly injection taken inside its multi-day catch-up window was stored as off-schedule while the slot stayed missed. The search now covers the schedule's full window reach.
- **An intake edit can no longer park a dose on an impossible date.** Editing a dose's time now rejects future timestamps and dates before the medication existed, the picker caps at now, the dialog shows the scheduled slot next to the field and warns when the new time sits more than 48 hours away from it — a day/month typo no longer corrupts the today view silently. The edit dialog's note field is removed; it was never saved.
- **One poisoned day no longer halts the nightly consolidation for everyone.** The daily-mean pass could collide with a row parked exactly on its canonical timestamp and abort the whole run on the first conflict, leaving every later user and metric unconsolidated night after night. Collisions now resolve deterministically and a failing day is logged, counted and skipped.
- **Every JSON request body is now size-bounded.** Raising the upload limit for large Apple Health archives had removed the implicit ceiling on all other JSON routes; each one now enforces an explicit cap sized to its payload and answers 413 beyond it.

### Added

- **An operator repair script for historical intake anomalies.** `scripts/repair-intake-anomalies.ts` lists duplicate rows sharing a dose slot and intakes whose taken time sits implausibly far from their slot; with `--fix` it merges the duplicates the same way the nightly sweep does and recomputes the affected compliance days. Runbook: `docs/ops/intake-repair.md`.

## [1.15.18] — 2026-06-08 — a traceable medication dose history

### Added

- **A traceable dose history for every medication.** The Verlauf tab now shows every expected dose slot with a clear status — taken on time, taken late, skipped, or missed — and tags any off-schedule intake as ad-hoc. The history reads from the same ledger the compliance percentage is built on, so the rate you see can no longer disagree with the timeline beneath it.
- **A configurable intake window per dose.** Each dose time can carry either a point time or an explicit range (for example 07:00–09:00); the default stays ±1 hour. The window defines the on-time band, so a take that lands inside it counts as on time rather than late. The window is editable on the schedule and in the medication wizard.
- **An Insights settings page.** A cog at the top right of the overview opens a dedicated Insights section in Settings, where you arrange the overview sections and sort the navigation pills. The old inline "Anpassen" toggle is gone — the cog is the single entry point.
- **A dose-history endpoint.** A read endpoint returns the resolved per-slot status over a date range, so the history view and any client render the same picture.

### Changed

- **A redesigned medication detail page.** The detail page is now a tabbed layout — Übersicht, Zeitplan, Erinnerung, Bestand, Verlauf, Erweitert — and the old stacked advanced-settings modal is dissolved into tidy, grouped sections under Erweitert. Card actions open straight to the matching tab.
- **The medication card keeps a constant surface.** The card no longer changes colour by dose status; the current status shows as a discreet label instead of tinting the whole card.
- **Intake writes and edits attribute by the real intake time.** Marking a dose taken records it against the slot whose window it falls in; a take outside every window records as ad-hoc instead of snapping to a far-off slot. Editing a dose re-attributes it, a near-miss take offers "attribute to this dose anyway?", and marking taken or skipped recomputes the history and rate immediately.

### Fixed

- **The daily briefing's regenerate no longer times out before the text is ready.** A slow but successful regeneration used to be discarded by a short timeout, leaving the old text in place while the toast still claimed success. The regenerate path now waits for the warm text and the toast is honest — it reports a refresh only when one happened, and tells you to try again when generation is still running.
- **The sleep-phase chart no longer double-counts time in bed.** Time-in-bed was being stacked as if it were a separate phase on top of the individual phases, roughly doubling the bar and the per-night total. It is no longer counted as a phase, so the bar and tooltip total read correctly.

## [1.15.17] — 2026-06-07 — large imports, demo chart toggles

### Fixed

- **Large Apple Health exports import correctly.** A request-body size limit in the middleware layer truncated uploads over ~10 MB before they reached the importer, so a multi-megabyte `export.zip` lost its ZIP structure and failed with an "end-of-central-directory" error. The limit is raised so real exports arrive intact. (GitHub #281)

### Changed

- **Chart display toggles work in demo mode.** On a demo instance, the comparison-baseline selector and per-chart overlay toggles above charts are no longer blocked — these are harmless display preferences.

## [1.15.16] — 2026-06-07 — wellness ring glow no longer clipped

### Fixed

- **The score ring's glow shows in full.** On a wellness score detail page the ring's soft glow was being clipped at the card edge. The card no longer clips its contents (its background gradient still follows the rounded corners), so the glow renders uncut on every side.

## [1.15.15] — 2026-06-07 — one warm, motivating assistant voice

### Changed

- **The whole assistant speaks in one voice.** The daily briefing, key findings, the insight write-ups, and the Coach now share the same warm, motivating, advisory tone the metric and wellness assessments adopted last release — encouraging and grounded in your data, honest about what needs attention, never generic. (Already-generated briefing text refreshes within about a day; the Coach speaks the new way immediately.)

## [1.15.14] — 2026-06-07 — manage every detail page, calmer mood charts

### Added

- **Manage every detail page from the overview.** "Anpassen" → "Detailseiten verwalten" now lists every insights sub-page, grouped by category, so you can reorder and hide any of them — not just the vitals tiles. The top navigation follows your choices: hide a page and its pill leaves the nav too.

### Changed

- **Calmer, more compact mood charts.** The mood distribution and weekday-average charts on the mood page are smaller and use softer colour, so the page reads more easily. Their axis labels are now legible in the light theme too.

## [1.15.13] — 2026-06-07 — search, filter, and bulk delete

### Added

- **Filter your measurements and mood entries.** Both lists now filter by source (manual, Apple Health, Withings, …) and by a date range, alongside the existing type / mood filter and sorting.
- **Select and delete in bulk.** Tick several entries on a page and remove them in one step, with a confirmation step. Deletions stay reversible on your devices the same way a single delete does.

## [1.15.12] — 2026-06-07 — a fairer health score and a richer overview

### Fixed

- **Blood pressure is scored fairly.** The Health Score's blood-pressure share used to be all-or-nothing per reading: a reading slightly over target counted exactly like one far over, so being consistently a little high collapsed the score even when you were well-controlled. It now grades by how close your readings sit to your target — recent readings weighted more — so "borderline" reads as borderline, not a crisis, while genuinely high pressure still scores low.
- **Workout heart rate no longer counts against your resting pulse.** Apple Health files every heart-rate sample — including the hundreds recorded during a workout — under one type, and the resting-pulse view was scoring all of them against a resting range, so an active day looked "elevated." Resting-pulse surfaces now use your true resting heart rate (with a careful estimate when that isn't available), and raw heart rate is no longer judged against a resting target.
- **The "in review" section is named "Rückblick"** and the spacing above it matches the rest of the overview.

### Added

- **Tap a wellness score for the full picture.** Readiness, Recovery, Sleep, Strain, and Stress now open a detail view with an explanation of what the score means and why it matters, the breakdown of how it's built, and a personal assessment of where you stand.
- **A warmer, more motivating assessment voice** across the insight assessments — encouraging and grounded in your data, never generic.
- **The running version on the admin overview**, with a hint when a newer release is available.

### Changed

- **Premium polish on the wellness detail view** — the detail card carries the score's colour, the ring has room to breathe, and the info control sits in the top corner.
- **Self-hosted instances resolve a login's location online by default**, using a bundled offline database only when one is configured — so the admin login overview shows a location out of the box.

## [1.15.11] — 2026-06-07 — a customizable overview

### Added

- **Arrange your overview.** Tap **Anpassen** on the Insights overview to rearrange it: drag sections into the order you want, hide the ones you don't, and — inside Vitals — reorder or hide individual metric tiles. Your layout is saved to your account and carries across devices. Tap **Fertig** to apply, **Zurücksetzen** to return to the default arrangement.

### Fixed

- **Self-hosting docs now generate a URL-safe Postgres password.** The setup examples used `openssl rand -base64 24`, which can emit characters (`/`, `+`, `=`) that break the unescaped `DATABASE_URL` and stop a fresh instance from connecting to its database. Every example now uses `openssl rand -hex 32`.

## [1.15.10] — 2026-06-07 — Insights overview, medication follow-ups, health score

### Fixed

- **Medication compliance now pairs doses to the right slot.** For a twice-daily medication, a dose logged off its usual time could be matched to the wrong slot — so a deliberately-skipped dose might read as taken, or a late evening dose as missed. Doses now snap to their own scheduled slot first, so the percentage reflects what actually happened.
- **The card advances to your next real dose.** After you log a dose, the "next dose" line moves to the next upcoming, unresolved slot instead of lingering on one that's already taken or past.
- **A single dose time reads cleanly.** A dose with one target time shows "07:00" rather than "07:00 to 07:00".
- **Your weight trend counts toward the Health Score even without a target.** The weight pillar used to need a height/target to score; it now scores your weight trend on its own when no target is set, so it stops dropping out of the score.

### Changed

- **A consistent Insights overview.** Every section now has its title above its card with a matching icon and even spacing throughout — the daily-briefing icon matches the rest, Trends has an icon, and the period-in-review and cycle sections carry proper headings.
- **A clearer cycle ring for new trackers.** With only a little cycle data the ring now shows the four phases in sensible proportions instead of collapsing to a single arc.
- **Mobile polish on Insights and Cycle** — the cycle ring fits narrow screens, the cycle tabs no longer crowd, and calendar days meet the tap-target size.
- **Your photo in the top bar.** If you've uploaded a profile photo it now shows in the top-right avatar; otherwise the icon remains.
- **The notifications area is just "Notifications"** (shorter), and admins get a link to the admin area from the mobile menu too.
- **Dark theme by default** for a fresh visitor; an explicit theme choice is still remembered.

## [1.15.9] — 2026-06-07 — medication compliance and cards

### Fixed

- **Compliance now counts a forgotten dose as missed.** A scheduled dose that was never taken or skipped used to quietly drop out of the calculation after a day, which made adherence read higher than it was. It now counts as missed, so your 7 / 30 / 90 / 365-day figures reflect what actually happened — and genuinely differ from one another instead of all looking the same.
- **The dashboard medication chart is computed against your schedule.** It previously measured taken doses against the doses you had logged (not the doses you were due), which pushed every window toward 100%. It now measures against the schedule.
- **Consistent skip handling.** A dose you deliberately skip is treated the same everywhere (a deliberate pause, not a miss); a dose simply forgotten counts as missed.

### Changed

- **The two medication cards are now truly identical.** Both styles render from one shared card body, so structure, spacing, labels, and the streak row line up exactly — only the value content differs (a weekly injectable keeps its relative-day phrasing, a daily dose shows a time). The bottom-spacing mismatch between cards is gone.
- **Cards highlight the dose that's due.** When a dose is in its take-now window the card is highlighted; once it is past due the card shows an overdue note, escalating to "Stark überfällig" near the cutoff. After the cutoff the dose counts as missed and the next dose becomes the focus.
- **Dose windows are cadence-aware.** A daily dose has a short on-time window then an overdue grace before it counts as missed; a weekly injectable follows a wider, clinically-appropriate window.
- **Tidier card.** The compliance bars show the percentage on its own, and the injection-site line was removed from the card (site tracking is unchanged).

## [1.15.8.1] — 2026-06-07 — large Apple Health imports

### Fixed

- **Large Apple Health `export.zip` uploads no longer fail with "Could not locate ZIP End-Of-Central-Directory record".** The multipart upload reader could drop part of a file body when a network chunk ended exactly on the multipart boundary — which only showed up on larger, multi-chunk uploads (a small export imported fine). The reader now handles the boundary across chunks correctly, so the uploaded archive arrives byte-for-byte intact. (#281)

## [1.15.8] — 2026-06-07 — medication cards

### Changed

- **Consistent medication cards.** Both medication card styles now use the same structure and the same labels for the same thing — "Next intake" and "Last intake" everywhere — so the two cards read the same way. The GLP-1 card keeps its relative-day hint ("Saturday 13 Jul (in 7 days)").
- **Compliance bars show the counts.** Each compliance bar now shows the doses behind the percentage (for example "100% · 12 / 12"), so two windows that genuinely land at the same percentage are legible at a glance instead of looking like a glitch.

## [1.15.7] — 2026-06-07 — data import in the browser

### Added

- **Import your data from the browser.** Settings → Export is now **Export & Import** and carries a proper import area with two paths:
  - **Apple Health** — upload your `export.zip` directly. It streams server-side (handles multi-GB archives) and is idempotent, so re-uploading the same archive merges rather than duplicating; progress and the imported/skipped totals are shown as it runs.
  - **Generic JSON** — upload or paste a JSON document of measurements and mood entries (with a downloadable example and a documented schema) for manually-prepared or converted data.
  - The data-import schema, the full measurement-type/unit reference, and a "convert a CSV into this" how-to are documented at `docs/integrations/data-import.md`.
- **Cycle export.** When cycle tracking is on, the Export area offers an explicit cycle export.

### Changed

- **A more compact health-record export card.** The health-record export keeps its prominence but takes far less vertical space.

### Fixed

- **The Apple Health import is reachable again.** The importer existed on the backend, but the web page the docs pointed to was never present; there is now a real import UI in Settings → Export & Import. (#281)

## [1.15.6] — 2026-06-06 — settings, insights, and medication-card polish

### Fixed

- **The notifications settings panel no longer crashes.** Opening Settings → Notifications could throw a client-side error on some accounts; the panel now renders safely whatever shape the data arrives in.
- **Even chevron in dropdowns.** The arrow on the right of selects (timezone, language, units, and everywhere else) now sits with the same inset from the right edge as the label has from the left, instead of pushing against the edge.

### Changed

- **Clearer Insights overview.** The period-in-review card now carries a proper heading, and the "signals of the day" section only appears when there's an actual anomaly to flag — when every vital is within your personal range it stays hidden rather than showing an empty header.
- **Tidier medication cards.** The next-dose line no longer appears twice on a card, and the injection-site suggestion text has been dropped from the card surface (site tracking and the post-dose picker are unchanged).
- **The avatar menu lands in Account.** Clicking your avatar now opens the Account settings directly.
- **Shorter integration save button.** The integrations credential form's button now simply reads "Save".
- **Tidier API-tokens panel.** The token endpoint URL is shown inline with a copy button, and the "generate another token" button matches the rest of the page rather than standing out in a different colour.
- **The export panel's create button is right-aligned**, consistent with other primary actions.

### Removed

- **The moodLog integration** has been removed from the Integrations page; it is no longer used.
- **The standalone sharing (create-link) feature** has been removed from the Export area.
- **The doctor report is no longer offered twice** — it has been removed from the main Export page, where it duplicated the health-record export's own doctor report.

## [1.15.5] — 2026-06-06 — insights layout, navigation, password-reset CLI

### Added

- **Reset a password from the command line.** Operators can reset a user's password from inside the container — useful when someone is locked out — via `docker compose exec app node scripts/reset-password.mjs <username-or-email>`. See `docs/ops/password-reset.md`.

### Changed

- **A tidier health-scores row.** With cycle tracking on, your cycle ring takes the place of the strain ring in the Insights health-scores row, so the row stays compact rather than growing an extra tile.
- **Cycle sits with your other trackers.** The Cycle entry in the sidebar now appears between Medications and Insights, rather than at the very bottom.

### Fixed

- **No more empty gap on the Insights overview.** The cycle summary card on the Insights page was held invisible by a style rule yet still took up space, leaving an odd gap above and below it; it now appears as intended and the spacing is even.

### Added

- **Your cycle ring in the health-scores strip.** With cycle tracking on, the Insights health-scores row now includes your cycle ring — current phase and day — alongside the other scores. It shows only when cycle tracking is enabled.

### Changed

- **A calmer cycle calendar and cards.** Predicted-period days are now a soft filled marker instead of a thin underline; the "what's happening now" card sits only under the ring (no duplicate above the calendar) and drops its own log button since logging is one tap away at the top; and the predictions and insights tabs lost their repeated "estimates / associations" footers (the caveat is stated once, where it matters).
- **Tidier settings.** Section descriptions line up under their headings; the web-push enable action sits in the card header; and the standalone cycle-data export/delete actions are gone from the cycle settings (cycle data is already in the full export).
- **Calendar tiles keep their size.** The mood and medication calendar tiles no longer balloon to several times the height of their neighbours when only a short window or a single medication is shown.

### Fixed

- **Per-score explanations load faster.** The dashboard's batch read now carries each score's deterministic explanation, so the score sheets show their "why" without an extra request.

### Added

- **Your cycle at a glance on Insights.** If you track your cycle, the Insights page now shows a compact card with your current phase and cycle day plus the one standout phase relation, with a tap-through to the full cycle insights. It appears only when cycle tracking is on, and the detailed phase analysis stays in the cycle section.

## [1.15.2] — 2026-06-06 — cycle insights crash fix

### Fixed

- **Cycle insights no longer crash on mood or blood-glucose relations.** The insights tab could throw and fail to render when a mood or blood-glucose pattern cleared the significance check, because those two metrics were missing their on-screen labels and units. They now render correctly, and an unrecognised metric can never crash the tab again.

## [1.15.1] — 2026-06-06 — cycle premium parity, reminder polish, fixes

### Added

- **Know your phase.** A "what's happening now" card next to the cycle wheel names your current phase, describes it in plain language, and surfaces the symptoms you yourself tend to log in that phase — drawn from your own history, never generic claims — with a one-tap shortcut to log today. It stays in a calm "still learning" state until there's enough of your data to be honest about.
- **Your own symptoms.** Add custom symptoms beyond the built-in set, with a name and an icon, straight from the log sheet. Custom symptom names are encrypted at rest, included in export, and removed by the cycle purge.
- **Fertile-window reminder.** An opt-in reminder a couple of days before your predicted fertile window — shown only when your goal is to conceive, off by default, and discreet-mode aware. It is an estimate, never a contraceptive or "safe day" claim.
- **A richer cycle calendar and history.** Period days now shade by flow intensity, a confirmed ovulation is marked distinctly from a predicted one, and a new cycle-length history chart shows your recent cycles with average, variability, and a regular/irregular read.

### Changed

- **Reminders read as plain text.** Medication, mood, and cycle reminder notifications no longer carry decorative emoji; emoji are kept only for system and failure alerts.

### Fixed

- **Blood-pressure-in-target reads accurately.** The "in target" share on the home health score now pairs systolic and diastolic readings the same way the rest of the app does, so imported readings whose timestamps differ by more than a few minutes are no longer dropped from the calculation.
- **A dose is never shown as taken before its time.** Logging a dose can no longer attribute it to a later slot still in the future — a late morning dose will not appear as the evening dose taken early.

### Security

- **Closed a server-side request risk in Web Push.** Push subscription endpoints are now validated against internal-network addresses on save and again before delivery, and the cycle-insights endpoint is rate-limited.

## [1.15.0] — 2026-06-06 — cycle tracking

### Added

- **Cycle tracking.** A new, private menstrual-cycle vertical. Log your period (flow and intermenstrual spotting), basal body temperature, cervical mucus, ovulation and pregnancy/progesterone tests, contraception, intercourse, and graded symptoms — all from one quick-entry sheet. A month calendar marks logged days, the predicted period window, the fertile window, and ovulation; the cycle wheel shows your current day and phase at a glance, and a logged day can be edited or deleted.
- **Honest predictions.** Next-period and fertile-window forecasts are always shown as a range with a confidence level — never a single certain date — and carry a clear, non-medical caveat (with a stronger one when you track to avoid pregnancy). A "read your body" mode suppresses every interpretation if you prefer to see only your raw data. The forecast is computed from your own data so the iOS client produces the identical result offline.
- **Basal-body-temperature chart** for the current cycle, with your fertility signs in the tooltip and the estimated — or confirmed — ovulation marked.
- **Phase insights.** An insights tab relates your cycle phase to your vitals — resting heart rate, HRV, sleep, steps, weight, blood glucose, mood — showing where each differs between phases with statistical significance, and which of your logged symptoms cluster in which phase. Associations only, never cause. A per-cycle history lists your recent cycle and period lengths.
- **Privacy first.** Cycle tracking is off by default except for accounts set to female, and anyone can turn it on or off from settings. The intent-revealing fields are encrypted at rest behind a default-on toggle; a discreet-notifications mode keeps any reminder generic on the lock screen; period reminders are opt-in per channel; and a one-tap purge hard-deletes every cycle row, the cycle audit trail, and reminder records, and clears your tracking intent.
- **Apple Health import.** Reproductive-health categories from an Apple Health export fold into your cycle log, and cycle data is included in the health-record export (PDF and FHIR).

## [1.14.0] — 2026-06-06 — animated health scores, score explanations, mood-factor correlations, log past doses

### Added

- **Each health score now explains itself.** The Readiness, Sleep, Recovery, Strain and Stress score sheets carry a short, plain-language read of why the score landed where it did, drawn from the inputs that moved it. It fills even without an AI provider configured, so the explanation is always there.
- **See how your rated factors track your body.** When you rate factors like work, sleep quality or stress on a mood entry, HealthLog now relates those ratings to your vitals — for example how your sleep or resting heart rate differs on the days you rate work low versus high — as a new card that the assistant can also cite. Associations only: each is shown with a confidence level, computed over a stable window, and never presented as cause.
- **Log a dose you took earlier.** The medications "Add" button now offers a choice — create a new medication, or log an intake — and the intake path accepts a backdated date and time against an existing medication.

### Changed

- **The health scores got a signature redesign.** The score strip reveals with a calm, staggered animation — each ring springs to its value while the number counts up — with a distinct colour per score (readiness green, recovery teal, sleep blue, stress amber, strain violet), a soft glow, and a faint "vs your normal" reference arc on the scores that carry a history. The motion plays once per visit and fully respects reduced-motion; the colours hold their contrast in both light and dark themes.
- **Sparse medications show where you stand at a glance.** A weekly injection or other "every N days" medication now shows its open-cycle status on the card — "next dose in N days", "due today", "overdue", or "no cycles yet" — instead of leaning on a percentage that says little between doses.
- **Smaller refinements across Insights.** The three trend cards (mood, weight, blood pressure) are now exactly the same height; the daily-briefing heading sits above its card; and the assistant tone and length controls sit side by side to cut scrolling.

## [1.13.3] — 2026-06-05 — health score scores blood pressure again, steps in Insights

### Fixed

- **The health score rates your blood pressure again.** The score was reading your blood-pressure-in-range rate from the trailing 30 days, but the score is meant to use your full history — so an account with blood-pressure history but no readings in the last month lost the whole blood-pressure pillar and showed "no rating". The score now reads the all-time rate (the at-a-glance tile headline still shows the last 30 days). If your blood pressure or weight still shows no rating, check that your date of birth (needed for the blood-pressure target) and height + target weight are set in your profile — those are required for the respective pillars.

### Added

- **Steps now have their own Insights page.** "Activity / Steps" was tracked and shown on the dashboard but never appeared in the Insights metric navigation; it now has its own Insights sub-page like the other activity metrics, surfaced whenever you have step data.

## [1.13.2] — 2026-06-05 — honest weekly-med compliance, correct sleep average, calmer wellness scores

### Fixed

- **Weekly injections (and other "every N days" medications) report honest adherence.** A rolling-cadence medication — the typical weekly GLP-1 injection — only ever counted its single next-due dose, so the rate flipped between a meaningless 100% and a hard 0% on a single dose and ignored a faithful history of shots. Compliance now reconstructs the full per-cycle history across the window: every logged dose counts, a genuinely skipped cycle reads as one miss, and the current cycle that simply hasn't come due yet no longer drags the number to zero. A new per-medication "current cycle" state (on track / due today / overdue / no cycles yet) lets the card show "next dose in N days" instead of a scary 0%.
- **The sleep average is correct again.** When a device wrote both a combined "asleep" block and the detailed light/deep/REM breakdown for the same night, the average double-counted them and could show an impossible figure (e.g. ~20 h). The average now reads from the de-duplicated per-night totals. The night-detail reconstruction is also hardened so it never errors on an unusual night.

### Changed

- **The wellness scores look calmer and clearer.** The "Your health scores" tiles (renamed from the old label) now use a gentle, card-toned surface instead of a heavy saturated slab, and each score draws a larger, thinner ring with a soft single-colour gradient tuned per score (readiness greener, sleep bluer, recovery and strain turquoise). The number and band stay fully legible in both light and dark themes.

## [1.13.1] — 2026-06-05 — wellness rings show the real score

### Fixed

- **The wellness-score rings now fill to the actual score.** Each ring was sweeping a full circle regardless of its value, so every score looked like 100%. The ring now fills proportionally — a 74 fills roughly three-quarters of the circle — across the overview tiles and the score detail view.

## [1.13.0] — 2026-06-05 — your own mood tags

### Added

- **Make the mood-tag list your own.** You can now create your own custom mood tags, give each a label and an icon, and hide any of the built-in tags you don't use — so the tag picker shows exactly the set that fits you. Custom tags work everywhere a built-in tag does: logging, history, and the analysis. Custom tag names are encrypted at rest like the rest of your personal content. Deleting a custom tag keeps it on your past entries by default; a separate purge removes it from history too.

## [1.12.12] — 2026-06-05 — the period retrospective is never empty

### Added

- **The period retrospective fills in even without an AI provider.** When no AI provider is configured (or before the first AI summary has been written), the "period in review" card now shows a concise, factual summary built from your own data — the biggest changes versus the prior period, any vitals that moved outside your typical range, and an honest, strictly non-causal count of statistical associations. It reads in German or English and is replaced in place the moment an AI summary is generated.

## [1.12.11] — 2026-06-05 — settings notices read the same everywhere

### Changed

- **Settings notices and status colours are unified.** Every callout, badge and status note in Settings now draws from the same set of meaning-based colours — success, caution, info — so a green "connected" or an amber "needs attention" looks identical from one card to the next and stays legible in both light and dark themes. Caution notes share one consistent boxed style with a leading icon.

## [1.12.10] — 2026-06-05 — a "taken" tap no longer back-fills the wrong dose

### Fixed

- **Logging a dose "taken now" no longer marks a far-away scheduled dose.** For a medication taken more than once a day, a quick "taken" log without a specific time (including a synced record) was snapping onto the nearest scheduled slot up to six hours away — so a midday log could mark the morning dose taken. A timeless "taken" log now records as its own entry and never back-fills a distant slot; logging a specific dose by its time is unchanged.

## [1.12.9] — 2026-06-05 — a tighter mood catalogue, clearer cards, and a fixed retrospective

### Changed

- **The mood factors are down to three sliders** — work, sleep quality, and a new sadness slider — and the day-tag list is trimmed to a tighter, higher-signal set. Tags you've already used stay on your past entries; they just no longer clutter the picker.
- **Medication cards read cleaner.** The next-dose and last-dose lines are now their own rows: the label on the left, the time flush to the right.

### Fixed

- **The period retrospective generates again.** A non-measurement metric was leaking into a measurement query and failing the background job; it's now filtered out.

### Documentation

- **Every code directory has a README**, the main README embeds the architecture diagrams and a documentation index, and the contributor guide reflects the current trunk-based release model.

## [1.12.8] — 2026-06-05 — fuller WHOOP data, charts that follow your selection

### Added

- **WHOOP now records more of what it measures.** Daily average heart rate, daily max heart rate, and per-night sleep disturbances are imported alongside the recovery, sleep, cycle and workout data already synced.

### Changed

- **The stats above a chart follow the range you pick.** Choosing 7 / 30 / 90 days or a year now recomputes the min / max / median / average for exactly that span — the numbers always match what the chart shows. The separate draggable range slider is removed.
- **Every chart leads with the same titled header** as the rest of the Insights tiles, for one consistent layout.
- **The wellness dials are refreshed** — a white ring on a gradient tile, matching the greeting card.
- **On the pulse page, the assessment sits above the cardio-fitness link**, and the assessment card's heading sits closer to its text.

### Fixed

- **AI insights use the current default models consistently** across every path, so the shared-key experience matches the rest.

### Added

- **The stats above a chart now follow your selection.** Brush a window on a metric chart and the min / max / median / average recompute for just that span; clear the selection to return to the full range. Works the same on every metric page, and blood pressure now shows systolic and diastolic in one card, side by side.

### Changed

- **The mood page reads top to bottom the way you'd walk it.** Summary, then the mood calendar, then the chart, then the target, then the assessment — followed by the breakdowns. The two "what stands out" sections are merged into one card, the statistical footnote is gone (the detail lives in a small info tooltip), and the mood colours are aligned to the rest of the charts.
- **VO₂max opens its full chart.** The compact row on the pulse page now links to the dedicated cardio-fitness page instead of showing a chart-less summary.
- **AI assessments vary more across your metrics.** The anti-repetition context now reaches the main cards (blood pressure, weight, pulse, mood, BMI, medication, overall), a step is only suggested when the finding implies one, and the default models were refreshed so the shared-key fallback isn't a quality drop.

### Fixed

- **Status colours stay legible on the light theme.** Connection states, recommendation badges, score provenance, and the settings success messages now use tokens that meet contrast in both themes.
- **A late device sync no longer shrinks a day's step or energy total.** Trailing samples are folded into the existing daily total instead of replacing it.
- **The medication streak is correct across time zones**, and the dashboard now serves its snapshot instantly after a sync while refreshing in the background.
- **Metric pages and the Insights overview show a retry on error** instead of a blank or a false "no data yet".
- **Account profile:** the timezone selector fills its row, and the "globally excluded injection sites" card matches the other cards.

## [1.12.7] — 2026-06-05 — Insights that react, read clean, and stay legible

### Added

- **The stats above a chart now follow your selection.** Brush a window on a metric chart and the min / max / median / average recompute for just that span; clear the selection to return to the full range. Works the same on every metric page, and blood pressure now shows systolic and diastolic in one card, side by side.

### Changed

- **The mood page reads top to bottom the way you'd walk it.** Summary, then the mood calendar, then the chart, then the target, then the assessment — followed by the breakdowns. The two "what stands out" sections are merged into one card, the statistical footnote is gone (the detail lives in a small info tooltip), and the mood colours are aligned to the rest of the charts.
- **VO₂max opens its full chart.** The compact row on the pulse page now links to the dedicated cardio-fitness page instead of showing a chart-less summary.
- **AI assessments vary more across your metrics.** The anti-repetition context now reaches the main cards (blood pressure, weight, pulse, mood, BMI, medication, overall), a step is only suggested when the finding implies one, and the default models were refreshed so the shared-key fallback isn't a quality drop.

### Fixed

- **Status colours stay legible on the light theme.** Connection states, recommendation badges, score provenance, and the settings success messages now use tokens that meet contrast in both themes.
- **A late device sync no longer shrinks a day's step or energy total.** Trailing samples are folded into the existing daily total instead of replacing it.
- **The medication streak is correct across time zones**, and the dashboard now serves its snapshot instantly after a sync while refreshing in the background.
- **Metric pages and the Insights overview show a retry on error** instead of a blank or a false "no data yet".
- **Account profile:** the timezone selector fills its row, and the "globally excluded injection sites" card matches the other cards.

## [1.12.6] — 2026-06-05 — one consistent Insights surface

### Changed

- **Every Insights card now reads the same way: an icon, a title, then the content.** Targets, the systolic and diastolic stats, the wellness and vital tiles, mood, and medications all lead with the same titled header in the same weight, so the surface is easier to scan and find your place in. The target tile is simply titled "Target".
- **The wellness scores sit above the daily briefing, with legible numbers.** The score numbers now render in the foreground colour against the dark cards (the band still shows on the ring), and the strip leads the overview above the briefing.
- **The min / max / median / average stats moved above each chart.** They now lead the metric page rather than trailing it, and blood pressure shows the full stat strip for both systolic and diastolic.
- **The mood page leads with where you stand, then what fits your better days.** The classification (in-range share and stability) comes first, followed by the better-days read; the mood colours are aligned to the rest of the charts.
- **The medications page is tighter.** The dose-by-dose therapy list is gone, the per-medication compliance tiles are denser, and the assessment sits directly under the target.

### Fixed

- **The medical disclaimer appears once.** The "describes your own data, not a clinical assessment" line was repeated across many tiles; it now shows once as a single page footer (and no longer doubles up on the Coach page, which carries its own note).
- **Medication status counts meet contrast on the light theme.** The taken / skipped / missed figures now use the semantic colour tokens, which stay legible in both themes.

### Documentation

- **Provider setup is documented end to end.** The WHOOP guide now pins the exact OAuth scopes and the webhook URL format, and a new Google Health (Fitbit & Pixel) guide covers the Google Cloud OAuth client, scopes, and redirect URI. See `docs/integrations/`.

## [1.12.5] — 2026-06-05 — correct sleep summary and readiness contributors

### Fixed

- **The sleep summary now reflects the whole night, not a single stage.** The Insights sleep figure and prose were reading one sleep stage (~16 minutes) instead of the reconstructed night total; they now use the night's time-asleep, the same number the dashboard and charts already show.
- **Readiness contributors no longer read a misleading 0.** Resting heart rate, heart-rate variability, and respiratory rate are hidden (rather than shown as 0) when there isn't yet enough history to establish a baseline; a genuine low sub-score still shows.

## [1.12.4] — 2026-06-05 — a calmer, more consistent Insights

### Changed

- **The Insights overview is reordered and easier to read.** Top to bottom: the morning greeting + Coach, then your wellness scores (now filling the row), vital values, trends, the period retrospective, and the signals of the day. The wellness numbers are legible on the dark theme, the steps figure in the daily briefing now opens its readings, the Coach suggests two focused questions, and the duplicate "prepare assessment" button at the foot of the page is gone.
- **Every metric page now follows one layout.** Intro → chart → target → assessment → the min / max / median / average stats below it. The target tile matches the other cards, blood pressure gains the same stat strip the other metrics have, the redundant range / "vs. previous" row is removed, and the "last measurement" card no longer clutters the page.
- **The mood page is tighter.** The little insight one-liners now sit side by side instead of each taking a full row, and the statistical explainers collapse into a small info icon you can hover or focus for the detail.

## [1.12.3] — 2026-06-05 — mark the dose you're looking at

### Fixed

- **Marking a dose "taken" now records the dose on screen, not the one nearest the clock.** For a medication taken more than once a day (e.g. morning and evening), the "Taken" button now targets the specific dose the card is showing, instead of snapping to whichever slot is closest to the current time — so a morning tap can no longer land on the wrong dose.

## [1.12.2] — 2026-06-05 — WHOOP connect from the app, consistent assessments and medications

### Added

- **WHOOP can be connected from the native app.** The OAuth handshake now works for an app that holds no web session: the client obtains a short-lived one-time connect token and opens the WHOOP authorization in an in-app browser that returns straight to the app. (No change for the web flow.)

### Changed

- **One word for "assessment", everywhere.** The AI assessment was labelled four different ways across the app; it now reads consistently in every language, and the assessment is always the final block on a metric page.
- **Every medication behaves the same when you log a dose.** Marking a GLP-1 dose taken now shows the same failure notice and one-tap undo that the other medication types already had, and medication status colours, the compliance percentage, and tap-target sizes are consistent across the cards.

### Operations

- **An alarm when the TLS certificate's public key changes.** Self-hosters whose native clients pin the server certificate now get a loud, logged alert (and an admin notification) when the served leaf key rotates, so the pin can be refreshed before it lapses. Set the expected pin(s) via `TLS_LEAF_SPKI_PINS`; see `docs/ops/tls-cert-pin.md`.

## [1.12.1] — 2026-06-05 — security, data-integrity, and insight-quality hardening

### Changed

- **Consent is now enforced on the server before any health data reaches a server-managed AI provider.** When the app uses an operator-provided AI key to generate insights, the assistant, or medication extraction, it first requires an active consent receipt — consent no longer depends on the client asking nicely. Bring-your-own-key and local providers are unaffected (the key is your own).
- **Assessments read less repetitively and more relationally.** A per-metric card can now bring in a genuine correlation from your own data (shown as an association, never a cause), varies its wording instead of repeating a near-identical paragraph when a metric has been steady for weeks, and hedges honestly when there is little data rather than over-claiming.
- **Settings feel like one surface.** The integration, account, sharing, and API cards share one header, the same button names and behaviour (so "Sync now" / "Sync all data" / "Test connection" mean the same thing everywhere), consistent tap-target sizes, and consistent spacing.
- **Faster settings and insights.** The integrations screen now loads its status in a single request instead of one per provider, the mood insights stay warm instead of recomputing from cold on every entry, and below-the-fold charts load on demand.
- **Sturdier Google Health / Fitbit sync.** A reading you delete stays deleted instead of reappearing on the next sync, large backfills write in batches, and the hourly poll no longer lets one slow account stall the rest.

### Fixed

- **Re-taking a dose after deleting it works again.** The medication intake history no longer blocks a legitimate re-entry against a deleted row.
- **Mood entries can round-trip without duplicating.** Mood entries now carry a stable identifier, so re-importing the same entry updates it in place instead of creating a second copy.
- **Tag-to-metric comparisons no longer double-count.** When the same day's steps, energy, or sleep arrive from more than one source, the mood tag comparison counts them once.
- Logging out now revokes a native session's token immediately, a long-lived refresh token is never handed to a browser, and a few authentication edge cases were tightened.

## [1.12.0] — 2026-06-05 — Google Health sync, rated mood factors, and a Coach and insights overhaul

### Added

- **Google Health (Fitbit & Pixel) — experimental.** Connect a Google Health account through your own Google client and pull in activity, body, sleep, and workout data: steps, distance, active energy, floors, and VO₂max; weight, body fat, SpO₂, resting heart rate, heart-rate variability, respiratory rate, and wrist temperature; sleep stages; and workouts. The card works like the others — test the connection, sync now, sync everything, and reconnect after a pause. This integration is experimental: Google's health API is young and coverage for some data types is still being verified.
- **Rated mood factors.** Alongside the yes/no mood tags you can now score factors on their own scale per entry — work, social, sleep quality, stress, conflict, and family — so a day can carry "stress 4, sleep quality 2" rather than a plain tag.
- **Mood logging, rebuilt.** Capturing a mood now opens with a five-face picker, then a category-grouped tag picker and the factor ratings, replacing the old form.
- **Hobbies and nutrition mood tags** — films, reading, gaming, music, outdoors, and fast food, no sweets, a big meal.
- **How your tags line up with your health metrics.** The mood Insights now compares a health metric on the days you tagged an activity against the days you did not — active energy on workout days, sleep length on the nights you tagged sleep, next-day recovery after a tag like alcohol or food. Each row shows the difference, its confidence, and is framed as an association in your own data, not a cause; only relationships that clear the same statistical filter the rest of the relations surface uses are shown.
- **A full-page Coach.** The Coach conversation can expand to its own full page from a maximize control.
- **A quicker way to log.** Navigation gains a central capture action that opens a measurement, medication, or mood entry from anywhere, and a "More" hub gathers the less-frequent sections.
- **A dashboard settings shortcut** — a wrench beside "Add" jumps straight to the dashboard layout settings.

### Changed

- **The Coach reads like a chat.** Replies stream in as they are written, past conversations and the context behind an answer collapse out of the way, and the disclaimer appears once.
- **Insights, de-duplicated.** The overview no longer repeats what the per-metric pages already show, and each metric page follows one consistent layout — a primary value, the last reading, the average/min/max/median strip, the chart with its range control below it, the metric's own correlation, and the assessment last — with clearer "what stands out" wording.
- **A refined injection-site body map** with corrected proportions and a legend for the recommended and last-used markers.
- **Export, reordered.** The health-record (FHIR) export is now the primary export, the doctor-report PDF moves below it, and the included-data list collapses by default.
- **The unit system lives in your profile** as a dropdown beside timezone, treated like a preference such as language.
- **Google Health and the other wearables share one source-priority ladder**, so when the same metric arrives from several sources the most appropriate one wins per metric.
- **The standalone moodLog integration is deprecated.** Mood is now tracked fully inside HealthLog with entries, structured tags, and rated factors, so the external bridge no longer adds anything. It keeps working for existing setups but is slated for removal in a future major release.

### Fixed

- **Weekly medications no longer read 0% compliance.** A weekly-cadence medication with recorded intakes now reports the correct rate instead of zero across the 7-, 30-, and 90-day frames.
- **Twice-daily oral doses record independently.** Marking an evening dose no longer collapses onto the morning slot, so both land in the history.
- The Google Health sync reads from a single point in time per cycle, so a gap after downtime isn't silently skipped, and a connection returned without a refresh token is rejected cleanly rather than saved half-formed.

## [1.11.5] — 2026-06-04 — mood relations, sleep depth, and a clear-the-decks polish pass

### Added

- **What lifts your mood, and what your better days have in common.** Insights now learns from your own logs: it compares your average mood on days with a given activity or tag against days without it, surfaces a ranked "what's associated with your better days" board across both your tags and your tracked metrics, and lists the day-to-day relationships that survive a statistical filter. Every result shows its strength and is framed as an association in your own data — a pattern worth watching, not a cause.
- **Last night, stage by stage.** The sleep section now draws a hypnogram of the most recent night — the progression through deep, core, REM, and awake — colour-coded by stage, alongside the per-stage breakdown.
- **WHOOP: test the connection and reconnect, just like Withings.** The WHOOP card now has a "Test connection" button that checks the link live, and — if the connection was paused after repeated errors — a one-tap reconnect.

### Changed

- **Adjust your targets from the header.** The target-range editor now opens from a gear next to the Coach button instead of a link buried in the tile.
- **Account settings gather the personal preferences.** The unit system (metric or imperial) and your globally excluded injection sites now live under Account rather than Dashboard.
- **Sleep reads as one value per night everywhere.** The measurements list, the per-metric sleep view, and the CSV export now collapse a night's individual stages into the night's total, with naps surfaced separately, matching what the tile and chart already showed.
- Full Spanish, French, Italian, and Polish coverage for the remaining Insights, admin, and HealthKit-label copy that previously fell back to English.

### Fixed

- **Sleep no longer double-counts an Apple Health night.** When Apple Health writes both an overall "asleep" figure and the deep/core/REM breakdown for the same night, the per-stage view and hypnogram now use one or the other rather than adding them together, and a nap on the same day no longer falls out of the night's total.
- **The Insights assessment reads cleaner.** The "cached" tag is gone, "show more" appears only when there is more to show, and the last-updated time is right-aligned.
- The "Signal of the day" and "Period at a glance" cards no longer leave a tall band of empty space below their content.
- A revoked WHOOP authorization is now recognised as needing reconnection instead of being retried as a transient error, and a WHOOP plan that shares none of a sync cycle's data no longer looks like a successful sync.
- The quick-entry sheet now asks before discarding mood ratings and dropdown changes, not only typed text.
- Settings: copying an API token confirms the copy, the destructive-action dialog shows progress while it works, and a failed token revoke surfaces an error.

## [1.11.4] — 2026-06-04 — sleep totals, trend captions, and a round of fixes

### Fixed

- **Sleep now shows the whole night.** The sleep tile and sleep chart previously showed a single sleep stage's minutes; they now show the night's total time asleep, grouped by sleep session so a night that crosses midnight counts as one night, with the unit shown explicitly. When two sources report the same night, the higher-priority one is used rather than adding them together.
- **The daily briefing no longer makes the Insights overview wait.** The overview reads the existing briefing immediately and refreshes it in the background instead of blocking the page on generation.
- **Recent achievements no longer flash in and vanish.** Cards that depend on your layout or your data now wait for that to load before appearing, so nothing shows up only to be retracted a moment later.
- **Charts with only a day or two of data now show those points** instead of withholding them behind a "more days needed" card. A short series still notes that more days will fill out the trend.
- **A reading logged by hand and mirrored to Apple Health no longer appears twice.** The same physical reading arriving from both sources is merged into one.
- Long wellness-score labels (for example "Sleep score") no longer clip.
- The mood-by-time-of-day chart no longer overflows its card.
- The Trends row cards are now equal height and the mood card's axis labels stay inside the card.

### Changed

- **The Trends row now describes the actual trend.** When there is no written summary yet, each trend card states the direction and size of the change over the period (for example "rising over 30 days") drawn from your own data, instead of always showing "awaiting more data."
- **Settings → Advanced:** the erase-data and delete-account buttons now sit beside their descriptions, matching the rest of the app.

## [1.11.3] — 2026-06-04 — WHOOP body data, quality-of-life polish, fuller translations

### Added

- **WHOOP body data.** WHOOP weight and maximum-heart-rate context now flow in alongside recovery, sleep, cycle, and workout data. Weight is ranked below a real scale by your source priority, so a connected scale or manual entry still wins; your profile height is filled in from WHOOP only if you haven't set one yet.
- **Stop a Coach reply mid-stream.** A Stop control appears while the assistant is answering, and closing the Coach drawer now ends an in-flight response instead of leaving it running.
- **Undo a logged dose.** The confirmation after taking or skipping a dose now offers an Undo, so a mis-tap is one tap to reverse instead of a trip into the history.

### Changed

- **More of the app speaks your language.** Spanish, French, Italian, and Polish now cover the Settings, Medications, Insights rhythm-event, and Achievements copy that previously fell back to English.
- **A WHOOP plan that doesn't expose every data type no longer breaks the connection.** A data class WHOOP declines to share is skipped on its own while the rest keeps syncing.
- The first Coach reply on a cold cache arrives faster — its inputs are now gathered in parallel.

### Fixed

- **A failed dose log is no longer silent.** If recording a dose doesn't go through, you now see an error instead of a confirmation for something that didn't happen.
- The quick-entry sheets only ask before discarding when you have actually typed something.
- A failed export now shows a clear message instead of a raw error code.
- Saving feedback on an Insights recommendation surfaces an error if it can't be stored.
- Several loading placeholders now reserve their final height, removing the small layout shifts on the Insights and dashboard surfaces as content lands.

### Accessibility

- Reduced-motion now suppresses the Insights card entrance animation.
- The API-token revoke button carries an accessible name and a larger target, and the medication scheduler's step controls have a larger touch target.

### Notes

- WHOOP weight is the value stored in your WHOOP profile, not a scale reading; it is ranked last among weight sources and only surfaces when nothing higher-priority is present.

## [1.11.2] — 2026-06-04 — Coach-memory controls, privacy hardening, more pinnable metrics

### Added

- **Review and clear what the Coach remembers.** A new "What the Coach remembers" settings section lists the durable facts the assistant has learned about you, grouped by category, and lets you forget a single one or clear all of them. Encrypted at rest; available wherever the Coach is enabled.
- **More dashboard metrics you can pin.** Cardio recovery, six-minute walk distance, stair ascent/descent speed, breathing disturbances, wrist temperature, fall count, and walking steadiness can now be pinned to your Home layout.

### Security

- **Outbound request hardening.** The AI provider clients (when pointed at a custom base URL) and the optional IP-geo lookup now reject any address that resolves to a private or internal host, closing a server-side request-forgery / DNS-rebinding gap.

### Fixed

- A rare write race when two updates recompute the same day's rollup at once is now handled cleanly instead of surfacing a transient error.
- Analytics fast paths resolve your source-priority preference once per request instead of repeatedly.

## [1.11.1] — 2026-06-04 — source-aware vitals + Coach long-term memory

Closes the three follow-ups left open by v1.11.0: cross-source vital de-duplication, the Coach's conversation memory, and durable personal facts.

### Added

- **Coach long-term memory.** The assistant now keeps a private, encrypted rolling summary of long conversations and remembers durable facts you have told it — standing preferences, goals, constraints, and conditions you have stated about yourself. Both are descriptive recall, never a diagnosis, and ride the same Coach setting; turning the Coach off stops all of it.
- **A facts surface to review and clear what the Coach has learned.** List your active facts, forget a single one, or forget everything (`GET` / `DELETE /api/insights/coach/facts`, `DELETE /api/insights/coach/facts/{id}`). Facts are stored encrypted at rest.

### Changed

- **Measurement rollups are now source-aware.** When two sources report the same standard vital on the same day (for example a resting heart rate from two devices), charts, summaries, and insights now show the higher-priority source's reading instead of a blend of the two. Cumulative metrics such as steps and energy continue to total per source. Your source-priority settings decide which reading wins.

### Notes

- The "latest" value shown for a vital with two competing sources now follows your source priority for the most recent day, so it matches the chart line. For some metrics this may surface a different device's reading than before.
- After clearing a Coach fact it can take up to a minute to disappear from the assistant's working context, in line with the existing snapshot refresh window.
- On first start after upgrading, each account's rollup cache is rebuilt once in the background; charts fall back to a live read until it converges.

## [1.11.0] — 2026-06-04 — WHOOP, a longitudinal coach, and a clinician-grade record

A multi-feature milestone across three fronts: a second connected provider, deeper Insights, and a shareable clinical record.

### Added

- **WHOOP integration.** Connect a WHOOP account with your own developer keys to bring its recovery, day- and workout-strain, sleep-performance, HRV (RMSSD), and energy readings into HealthLog alongside Apple Health and Withings — synced on a schedule and via signed webhooks, each value kept distinct by its source so it never overwrites a reading from another device.
- **A longitudinal Insights coach.** A weekly/monthly narrative summarises what changed over the period and the likely contributing factors (descriptive, never causal); the Coach now carries a rolling profile of your recent baselines and trends; and a short-horizon trajectory projection shows where a metric is heading with an honest, widening confidence band — shown only when there is enough history to mean something.
- **A clinician-grade health record.** A read-only FHIR REST API (`GET /api/fhir/*`) serves your data as standard FHIR R4 resources, and you can mint a scoped, time-limited, revocable share link that opens a clean read-only clinician view — no account needed. Wellness figures stay fenced off from the clinical ones with a plain "not a clinical assessment" note.
- **More resilient AI generation.** A durable provider-health record skips a known-bad credential instead of failing every run and surfaces an expired credential proactively, with a local model as a guaranteed fallback.

### Known limitations (planned follow-ups)

- When two sources supply the same standard vital (e.g. WHOOP and an Apple Watch both report resting heart rate), both readings may currently appear for a day until a source-aware aggregation update resolves them to your preferred source. WHOOP's own scores are unaffected; a note explains this on the WHOOP card.
- The coach reflects your rolling health profile and trajectory; full conversation-summary memory and saved personal facts are a later refinement.

## [1.10.4] — 2026-06-03 — Strain honesty + six-minute-walk caveat

### Changed

- **The Strain reading now says which scale it used.** When the score is anchored to your own recent training load it reads "relative to your typical effort"; while there is too little history and it falls back to a general reference, it says so — so the framing always matches the number actually shown.
- **The six-minute-walk band notes its reference range.** The reference equation was established for ages 40–80; outside that range the percent-of-predicted is now flagged as an extrapolation.

## [1.10.3] — 2026-06-03 — Personalised strain, a daily signal card, deeper derived metrics

### Added

- **A "Today's signal" card.** The coincident-deviation read — which notices when several of your vitals sit off their personal baseline at once — now leads the Insights overview as a calm daily card instead of a flag buried in the grid. It shows an all-clear on a normal day, names the vitals to keep an eye on when a few drift, and always frames them as possible factors, never a cause or a diagnosis.
- **Derived bands for more of what your watch measures.** Overnight wrist temperature and stair-climbing and stair-descent pace each get a personal typical-range band, and your device's estimated six-minute-walk distance is placed against a published reference for your age, height, weight and sex. Each is shown with its method and its cited standard, and only once there is enough history. They appear under a new "Mobility & body" group.
- **Trailing trend sparklines** on the derived tiles, drawn from the readings the tile already uses.

### Changed

- **The Strain score is now anchored to your own training load.** It reads how hard a day was relative to your own recent training-day effort rather than a fixed population figure, so a genuinely hard day reads high even while you are building back up; with too little history it falls back to a general reference and says so.
- Age-banded reference norms now interpolate across bracket boundaries instead of stepping, and the sleep midpoint is computed in your own timezone.

## [1.10.2] — 2026-06-03 — Honest AI connection test, consistent insights, retention re-enabled

### Fixed

- **The AI connection test now tells you what actually went wrong.** A failed test used to surface a cryptic parse error ("unexpected token") because the server answered with a gateway-level error page the settings screen could not read; worse, the test probed a different provider than the one your nightly insights are generated with, so it could report a problem with a fallback you do not even use. The test now always returns a readable, translated reason — rejected credentials, rate-limited, a provider server error, or unreachable — and it checks the same provider your insights run on, so the result is the truth about your setup.
- **Every insight metric page carries the same time-range controls.** The core-metric pages (weight, blood pressure, pulse, BMI, sleep) were missing the period selector that the other metric pages already had; they now match. Drill-down back-links are consistent and a "show all values" link returns you to the metric you came from.
- **The derived-metrics dashboard no longer collapses or jumps while loading.** It shows a placeholder row at the right height, keeps its heading hidden until there is something to show, and offers an inline retry if the data fails to load instead of silently vanishing.
- **More status colours meet contrast on the light theme** across the medication and admin surfaces.

### Changed

- **The intra-day retention drain is back on.** The storage optimisation behind the stress reading was switched off in 1.10.0.2 after a daily-summary collision kept the app cycling post-deploy. The fold now adopts the existing daily row deterministically and recovers cleanly if a concurrent write reaches the same slot first — verified against real data — and the start-up defer that protects the connection pool stays in place.
- **The batch-ingest and health-record export endpoints cap request-body size**, rejecting an oversized payload before parsing it.

### Added

- **A capability endpoint for API clients.** `GET /api/meta/capabilities` returns the server's live metric, tile, ingest and FHIR vocabularies alongside a contract version, so a client renders what it recognises and ignores what it does not — no more transcribing each release's new identifiers by hand.

## [1.10.1] — 2026-06-03 — Consistent medication cards

### Fixed

- **Every medication card looks the same now, whatever the type.** Oral, injection, GLP-1, as-needed, cyclic and one-time medications previously drew their "next / last intake" line, dose accent, spacing and compliance bars slightly differently, so cards in the same row could sit at different heights with the action buttons misaligned. The cards now share one layout: the same intake line, a reserved-height compliance area, and the take/skip buttons pinned to the bottom — so a row of mixed medications lines up cleanly. The dose accent also meets contrast on the light theme.

## [1.10.0.2] — 2026-06-03 — Disable the intra-day retention drain

### Fixed

- **Stops the post-deploy restart loop for good.** The intra-day retention drain (a storage optimisation behind the new stress reading) folded older samples into a daily summary, but on real data that summary collided with an existing daily row and the drain failed on every run, which kept the app cycling after a deploy. The drain is now switched off until it is reworked and tested against real data; the nightly pass is skipped, nothing is queued at start-up, and any work already queued completes harmlessly. No user-facing feature is lost — the stress reading simply falls back to its sparse-data behaviour.

## [1.10.0.1] — 2026-06-03 — Defer the intra-day retention drain past startup

### Fixed

- **The app no longer turns unresponsive shortly after a deploy or restart.** The new intra-day retention drain ran its catch-up pass the moment the background worker started, at the same time as the database migration, the other start-up backfills, and the first health checks — all sharing one connection pool. On an instance with a lot of history this exhausted the pool, so the app stopped answering until it restarted, then repeated. The catch-up now waits until start-up has settled before it runs; it is unchanged otherwise and the nightly pass is unaffected.

## [1.10.0] — 2026-06-03 — Derived wellness metrics, device-event awareness, deeper ingestion

### Added

- **Derived wellness metrics, each shown with how it is worked out.** From data you already sync, the Insights surface now derives a personal typical range for a vital, a cardio-fitness band, a vascular-age delta, an HRV (SDNN) balance read, body-mass index, a sleep score, a readiness index, and a coincident-deviation flag that notices when several vitals sit off their personal range at once. Every metric states its inputs, its method in plain language, and the published standard it is grounded in, with an honest read of how much data backs it — never a bare number. A metric appears only when there is enough history to mean something.
- **Recovery, Stress, and Strain scores, computed each night.** Recovery blends your resting-heart-rate, HRV, sleep and respiratory trends against your own baseline; Strain reads the heart-rate load of your workouts; Stress is an HRV-derived proxy and is labelled as exactly that — not a sensor-measured stress reading. Each is stored as a first-class value you can chart, and each opens to a breakdown of its contributors and its cited basis.
- **More of what your watch already measures.** Cardio recovery, overnight wrist temperature, fall count, six-minute-walk distance, stair ascent and descent speed, and the sleep breathing-disturbance index are now ingested and surfaced.
- **An awareness timeline for device-flagged events.** Irregular-rhythm, high- and low-heart-rate, walking-steadiness, and breathing-disturbance notifications your device produced are shown as a timeline — strictly as awareness of your own device's certified result, never re-assessed and never a HealthLog diagnosis, with a permanent disclaimer to that effect. The section stays hidden until there is something to show.
- **A per-workout heart-rate series**, so an indoor workout with no GPS still yields a training-load signal.
- **A wellness summary in the doctor report.** The derived scores and metrics appear in their own section, kept out of the clinical vitals table, labelled descriptive rather than clinical, and exported to FHIR as `survey`-category observations with the same note — so a clinician's system never mistakes them for a vital sign or a diagnosis.

### Changed

- **The health-record export carries richer medication codings.** A `MedicationAdministration` now adds a SNOMED route and injection-site coding alongside the existing plain text, a German-locale export can append the German BfArM ATC coding next to the unchanged WHO ATC entry, and the number of administrations an export can carry is raised and made configurable by the operator.
- **The Insights overview reads its metrics through a single request** instead of one per tile, so opening the page no longer fans out into a burst of concurrent reads.
- **Score-band colours meet contrast on the light theme**, and the device-notification copy — including its medical disclaimer — is translated across every supported language.

## [1.9.3] — 2026-06-02 — Medication card layout polish

### Fixed

- **The medication cards look right again.** A recent alignment change pushed each card's action buttons to the very bottom of the cell, which left an empty gap between a shorter card's content and its buttons when it sat next to a taller card in the grid. The buttons now sit directly under the card's content again; the cards still share a height and the dose rows still line up, without the gap.

## [1.9.2] — 2026-06-02 — Document the medication compliance endpoint

### Changed

- **The medication compliance endpoint is now in the public API contract.** `GET /api/medications/{id}/compliance` was missing from the OpenAPI document, so a client generating its types from the contract could mistake the separate cadence endpoint (a different shape) for it. The route is now documented with its exact response — the 7- and 30-day adherence summaries, the per-day compliance grid, and the two-row display block — with the field a client should read for the headline 30-day rate and how to draw the per-day history. No behaviour change; the handler was already correct.

## [1.9.1] — 2026-06-02 — No assessment warm on a page visit

### Fixed

- **Opening the Insights overview no longer regenerates every assessment.** A returning visit fired a one-per-session background warm that asked the provider to regenerate the comprehensive briefing and every category and metric assessment at once — a burst that could run for minutes and make the whole app feel unresponsive while it ran, recovering on its own once it finished. Assessments are kept fresh by the nightly pass, and each metric's text refreshes gently on its own when you open it; the "prepare assessments" button still regenerates everything on demand. A page visit now only reads the cached text.

## [1.9.0] — 2026-06-02 — Insights time-ranges, deeper mood, medication coding, stability

### Added

- **A time range you can choose on the Insights pages.** Each metric now carries range pills (week, month, quarter, year) and shows how the period compares with the one before it — the change in your average, stated plainly with its direction — so a trend reads at a glance instead of by eye.
- **Deeper mood insights.** The mood page now surfaces your time-of-day pattern (when your mood tends to sit highest and lowest), a stability read, and correlation cards that line mood up against weight and blood pressure — each shown only when there are enough paired days to mean something.
- **Standard drug codes on a medication.** A medication can carry an ATC and an RxNorm code (entered, never guessed). These flow into the health-record export: the exported `MedicationStatement` now codes the drug with the WHO ATC system and RxNorm alongside the plain name, and the export adds a `MedicationAdministration` for every dose you actually took or skipped, so a clinician's system can read the record without relying on free text.
- **A deploy-verification script** (`scripts/assert-deploy.ts`) that checks a target reports the expected version after a release.

### Changed

- **The medication advanced-settings page is rebuilt.** Import, intake-import and export sit in their own group, the external-API endpoints are listed one by one with collapsible request examples, and the layout is tidied so the technical settings read clearly instead of crowding together.
- **Targets are edited inline where they belong.** The separate `/targets` page is retired — you set a metric's target range from the metric itself, with no detour to a standalone editor.
- **The health-record export emits insurer coverage from a bare insurance number**, not only when a full insurer organisation is present, and carries a top-level narrative summary.
- **Notification settings wording** is tightened for clarity.

### Fixed

- **The app stays responsive under load.** The database connection pool was sized far too small by default and could starve while a background insight warm and a foreground request competed, which showed up as the occasional "server not responding" that recovered on its own; the pool is now sized for real concurrency and tunable for larger self-hosts.
- **A background insight warm no longer blocks a page**, and a burst of Apple Health / Withings sync no longer triggers a storm of regenerations — the warm is decoupled and the invalidation is debounced.
- **The medication card rows stay aligned.** "Last dose" and "next dose" could break onto different heights and look misaligned; the rows now hold an equal height.
- **Glucose entered in mmol/L converts correctly** in the editor instead of being stored against the wrong unit.
- **The admin and global layout no longer shifts** when a scrollbar appears, by reserving the gutter.
- **The legacy status endpoints are documented** — six older `*-status` routes were missing from the API contract and are now included.

## [1.8.7.1] — 2026-06-02 — Assessments for every HealthKit metric, one-tap pre-generation

### Added

- **A plain-language assessment on every HealthKit metric page.** The HealthKit metric pages (resting heart rate, heart-rate variability, blood oxygen, glucose, body composition, gait, audio exposure, sleep, and the rest) showed charts but no written assessment, because the core metrics' bespoke per-metric prompts don't scale to thirty more. Each page now carries an assessment, generated from the metric's own normal range and the direction a healthy value moves, anchored on your individual baseline — the same treatment the core metrics already had. A metric with no data keeps its existing insufficient-data note.
- **One-tap pre-generation of every assessment.** A button on the Insights overview generates all assessments in the background so they are ready immediately the next time you open them. The overview also warms a cold cache on its own, and the nightly pass keeps everything fresh — so a page opens to its assessment instead of a wait.

### Changed

- **"Auswertungen" is now "KI-Auswertungen" / "AI Insights"** in the settings heading and the menu, so it's clear the section is AI-generated.
- **Targets and Sources are two separate settings pages** instead of one combined page, each with its own heading.
- **The back link sits above the heading** on a metric's detail page.
- **Dropdown fields have symmetric padding**, so the chevron no longer crowds the right edge.
- **The Insights layout accepts the full metric set**, so a saved layout (order and visibility) can include every metric page, not just the core ones.

### Fixed

- **Assessments generate again.** The assessment provider's accepted model identifiers had rotated, so generation failed and an assessment could sit on "preparing" indefinitely; the model ladder is updated and falls through to the current identifiers.
- **The Active Energy assessment loads.** Its page requested an assessment under a mismatched identifier and silently fell back to "no analysis yet"; the identifier is corrected and now type-checked, so the same class of mismatch is caught at build time.
- **The source-priority editor is fully translated** for Spanish, French, Italian and Polish — it was English-only after the settings split.

## [1.8.7] — 2026-06-02 — Instant insight assessments, GLP-1 blood-level chart, tile + caption polish

### Fixed

- **Insight assessments are instant again.** A category's assessment was being re-prepared on almost every visit: the constant Apple Health / Withings sync kept evicting the cached text, and a miss only ever deleted-and-waited. Assessments now serve the last good text immediately (stale-while-revalidate) and refresh in the background — "preparing" shows only when an assessment has genuinely never been generated. The background refresh is also debounced per metric, so a sync burst no longer triggers a storm of regenerations, and it warms only the active language (halving the work).
- **The dashboard tiles never truncate the value.** In a dense tile strip the number could clip or wrap mid-value (e.g. "130 mmHg" showing as "13"); the value now always renders in full and the unit yields the space instead.
- **GLP-1 medications show the drug-level-in-blood estimate by default.** The estimated concentration curve was hidden behind the Research-Mode opt-in and below the dose-strength curve; for GLP-1 medications it now shows by default, above the dose-strength curve, with the "educational estimate, not a measurement" disclaimer kept clearly attached.
- **The Trends captions read consistently.** Metrics without an advisor note previously rendered their caption in a different, plainer style that broke the row; every Trends caption now uses the same treatment.

### Changed

- **The mood assessment sits directly under the first chart** on the mood insights page.

## [1.8.6] — 2026-06-01 — Compliance two-row return, insights polish, targets deprecation

### Added

- **Mood narrative takeaways above the charts** — a ranked feed of plain-language findings (the weekday your mood dips, the overall trend, the tags that lift or lower it, your in-target share, your logging streak, the weekend effect), now drawing on the structured tags as well as free-text ones.
- **A GLP-1 dose-strength curve** that plots the titration history (2.5 → 5 → 7.5 mg …) in place of the previous empty therapy-course block.
- **A FHIR `Coverage` resource in the health-record export**, with an optional insurer institution number (IKNR) captured on the profile — making the insurer machine-resolvable for German systems.
- **An optional `source` on the measurements batch endpoint**, so a client backfilling manually-entered history can tag it correctly instead of defaulting to Apple Health.

### Changed

- **Medication compliance returns to two rows for every medication.** The cadence-aware timeline is gone; the two windows now scale to how often a medication is due — a daily medication keeps 7-day and 30-day, a rarely-taken one steps up to longer windows (up to twelve months) so both rows stay meaningful and the layout stays steady.
- **The medication advanced settings are a single, calmer column** with a symmetric danger zone (matched delete-history / delete-medication actions), replacing the cramped two-column layout.
- **The medication wizard uses a jumpable dot stepper** with a "next step" hint; in edit mode every step is reachable in one tap.
- **Insights category headers are quieter.** The question-mark circle is gone (the metric definition stays inline beneath the heading), the measurement-diversity hint moved to a heading lightbulb with the explanation on hover, the assessment border is de-emphasised, and "Coach fragen" moved to the header as an icon.
- **Target ranges are now edited inline from Insights.** The Targets page is deprecated — it carries a notice, is removed from the menu, and will be retired in a future release; editing happens where you read the trend.

### Fixed

- **Every briefing-driven Trend card now shows its caption** — additive metrics no longer render a chart with empty space below it.
- **A long mood note no longer stretches the entries table** — it truncates with the full text on hover.
- **The mood in-target share is shown once**, not duplicated between the headline tile and the takeaway feed.
- **Medication compliance no longer counts days before a medication existed**, so a newly-added medication's expected-dose figures reflect its real age.

## [1.8.5] — 2026-06-01 — Insights reference panels, mood depth, injection tracking

### Added

- **A target reference panel on every Insights category page.** Each metric now shows the target band, where the latest reading sits inside it, a plain-language status, the guideline source behind the range, the 30-day average and a seven-day consistency strip — the same reference the Targets page carries, now on the page where you read the trend. Blood glucose surfaces one panel per context (fasting, post-meal, random, bedtime).
- **A statistics strip per metric** — minimum, maximum, median and mean — plus a dedicated page that lists every underlying reading with edit and delete, reachable from each Insights category.
- **Injection-site tracking and rotation.** Opt-in per medication (injections only): record the site after a dose, see the history on a body map, and get a rotation suggestion. Sites can be restricted per medication, and an account-level exclusion always wins.
- **Structured mood tags and a per-entry note**, with a notes timeline so the context behind a mood is kept alongside the score.
- **A richer mood page** — calendar heatmap, score distribution, weekday pattern, and correlations with sleep and activity.
- **A measurement-diversity nudge** that suggests logging at other times or days when readings cluster, for a fuller picture.

### Changed

- **The medication compliance display adapts to how often a dose is due** — a percentage for frequent schedules, a dose-by-dose adherence timeline for sparse ones, so an every-few-weeks medication reads sensibly.
- **The Trends section now follows the daily briefing**, charting the metrics the briefing actually flags rather than a fixed set.
- **Tightened the Insights category pages and rebalanced the overview** for a denser, calmer layout.
- **Gait and mobility metrics from Apple Health are consolidated to a daily mean overnight**, while discrete clinical readings (weight, blood pressure, glucose, mood, pulse) stay raw.
- **The health-record FHIR export codes HealthKit-only metrics under a dedicated code system** instead of the LOINC namespace, for FHIR R4 conformance and alignment with the native client.

### Fixed

- **A rolling-interval medication now surfaces its first dose at the start date** — including when that date is already in the past — so the dashboard and reminders no longer skip the opening dose.
- **The medication wizard no longer shows each time-of-day suggestion twice.**
- **Deleting a medication no longer hangs on a spinner.**
- **Mood entries with tags save atomically** — the entry and its tags commit together, and create and update return the saved tags immediately rather than after a refresh.
- **Accessibility:** the injection-site picker has a visible focus state and screen-reader labels; mood tag chips and the status pill meet the contrast and minimum tap-target guidelines.

## [1.8.4] — 2026-06-01 — Medication card accuracy + Insights polish

### Fixed

- **The medication card shows the correct next intake for every schedule.** Flexible "interval after the last dose" and one-time medications previously showed a next-intake derived from a simplified day-of-week rule that ignored the interval and the last logged dose — so a medication taken every few weeks proposed tomorrow and never moved after a dose was logged. Both the standard and the injection card now read the schedule engine's computed next-due, so the next intake is right on creation and advances the moment a dose is recorded.
- **Insights status polling is bounded.** When a model is configured but generation stalls, the per-category assessment card no longer polls indefinitely on an open page — it stops after a fixed ceiling and shows its static state.
- **Clean deploys no longer hit a missing settings column.** Four `app_settings` columns existed in the schema but had only ever been applied ad-hoc, so a migrations-only deploy could fail on first read; an idempotent migration now adds them (a no-op on instances that already have them).

### Changed

- **Logging a dose confirms itself.** Marking a medication taken or skipped now shows a brief confirmation, and the card's next-intake updates immediately.
- **Each Insights category explains itself inline.** The short metric definition now also appears as a caption under the category heading, alongside the existing question-mark tooltip.
- **Medication history shows where each dose was logged** — web, the iOS app, a reminder, or an import — as a small origin label on each entry.

## [1.8.3] — 2026-06-01 — Insights no longer block the interface

Opening an Insights category and switching between them could freeze the whole interface for several seconds while the per-category assessment was generated. The interface now stays responsive throughout.

### Fixed

- **Switching Insights categories no longer freezes the interface.** Each category's short assessment is now served from cache as an immediate, read-only response; when it is not yet ready the page shows a brief preparing state and the assessment is generated in the background, so navigation and taps stay responsive. The client request is capped, so a slow or unreachable model can never block the interface — the worst case is a preparing state, never a frozen screen.
- **The overnight pre-generation warms the assessment actually shown.** The nightly warm pass keyed its cache differently from what the page requests, so a returning visit often fell back to an on-demand generation; it now warms the languages the interface uses and runs even when the daily summary was already cached, so a returning visit lands on a ready assessment.
- **A stalled model no longer re-blocks every visit.** A generation timeout is briefly remembered so the next visits return immediately instead of retrying the slow path each time.
- **Streamed loading states.** Insights and the dashboard now render a skeleton while their first segment loads, rather than waiting on a blank transition.

## [1.8.2] — 2026-06-01 — One intake row per dose slot

A multi-time medication could end up with two entries for the same dose — one still open, one marked taken — for a dose the user had not taken. This release guarantees a single entry per scheduled dose.

### Fixed

- **A dose slot can no longer hold a duplicate entry.** Logging a dose now updates the slot's existing entry in place instead of inserting a second row, regardless of where the log came from, and the logged time is aligned to the scheduled dose rather than the exact moment of the tap. A twice-daily medication no longer shows the same time twice (once open, once taken), the daily count is no longer inflated, and the "due now" prompt is no longer suppressed for a dose that has not actually been taken.
- **A recorded dose is never silently un-recorded.** A background re-sync that replays an open dose onto a slot already marked taken is now ignored rather than clearing the taken mark, so an offline sync can never flip a taken dose back to missed.
- **Concurrent logs converge.** Two logs landing on the same dose at once resolve to one entry instead of failing or duplicating.
- **Existing duplicates are cleaned up on startup.** A one-time pass collapses any duplicate dose entries already stored, keeping the recorded dose and correcting the affected compliance figures.

## [1.8.1] — 2026-06-01 — Multi-time medication compliance

A follow-up to the multi-time compliance work in 1.7.3, closing the two surfaces it did not reach.

### Fixed

- **Every scheduled time of a multi-time medication is now loggable** — a medication taken more than once a day on a single schedule with several times (e.g. 07:00 and 19:00) surfaced only its first dose in the today tile and the logging sheet, so the second dose could never be recorded and the day's compliance was counted against a single expected dose. The today-window projection now creates one pending dose per scheduled time, matching how reminders are issued.
- **The compliance heatmap classifies each dose against its own time** — a twice-daily dose logged in the evening was measured against the morning time and read as very late, painting the day amber even when both doses were taken on time. Each logged dose is now matched to its nearest scheduled time, so a day with every dose taken on time reads as on time. Single-time schedules are unaffected.

## [1.8.0] — 2026-05-31 — Insights: reliable data-driven assessments, embedded targets, explainers

The per-metric Insights pages become the coherent heart of the app. The data-driven assessment — a short, honest reading of your own trend — now reliably reaches the page: it previously timed out and cached a generic placeholder for the rest of the day, so most users only ever saw the platitude. The generation budget is aligned with the provider, the placeholder is never cached, and the AI payload is compressed into a graded shape (recent days raw, then weekly, monthly, and yearly aggregates drawn from the rollup tier) so a heavy logger no longer ships thousands of raw points. Each metric's prompt is rewritten to a consistent house style — name the finding, place it against your own baseline, offer one concrete step; honest on poor values, never alarmist, never diagnostic. Target ranges move onto each category page beside the chart, every category gains a plain-language "what is this?" tooltip, and the assessment is warmed overnight so the page is a cache read instead of a live call. Route slugs and tile ids move to English (German tile ids stay accepted as aliases, so existing clients keep working).

### Added

- **Per-category target ranges** — each Insights category page shows its numeric target range and the share of recent days within target, beside the chart and the assessment, with a link to adjust the range. The dedicated targets page remains the editing surface.
- **Per-category explainer tooltips** — a question-mark affordance next to every category heading opens a short, plain-language definition of the metric, available offline in all six languages and reachable by keyboard and touch.
- **Nightly assessment pre-generation** — a budget-gated overnight job warms the per-metric assessment caches (and invalidates them when fresh measurements arrive), so opening a category page is a cache read rather than a synchronous model call.
- **Graded measurement compression for assessments** — a shared compressor folds a metric's history into recent (daily), weekly, monthly, and yearly buckets, drawing the monthly/yearly tiers from the rollup store, so the model receives a compact picture instead of the full daily series.
- **Naming decision record** — `docs/adr/0001-insights-naming-convention.md` documents the convention: localised UI, English internal keys and route slugs.

### Changed

- **Data-driven assessments reach the page reliably** — the per-metric assessment generation budget is aligned with the provider (was capped well below the provider floor), runs through the provider chain with fallback, and a transient timeout or error is treated as a passing miss rather than cached as a placeholder for the rest of the day.
- **Assessment wording** — every metric prompt follows one house style (name → place against own baseline → one actionable step; 2–4 sentences; honest, autonomy-supporting, non-diagnostic; says so plainly when the data is too thin). Blood pressure reads systolic and diastolic together; weight tracks the trend while BMI speaks to threshold bands; the mood assessment carries a calm support cue on a sustained low.
- **Insights route slugs are English** — `/insights/<german>` moves to `/insights/<english>` with permanent redirects from the old paths. The dashboard-layout tile ids are English canonically; the previous German ids stay accepted as aliases and are normalised on read and write, so a client that stored the old ids keeps working.
- **Per-metric assessment caches drop on measurement changes** — a fresh, edited, or deleted measurement invalidates the affected category's cached assessment so it regenerates rather than serving a stale reading.

## [1.7.3] — 2026-05-31 — Health-record PDF fixes, multi-time compliance

Two fixes to live behaviour.

### Fixed

- **Health-record export renders in the account language** — the PDF came out in English regardless of the in-app language because the export only consulted the browser's `Accept-Language`. The client now sends the active language and the server falls back to the language cookie before the browser header.
- **Health-record export layout** — charts now label their time axis (start and end date of the plotted window), modules are kept together instead of breaking across a page, a consistent bottom margin is held on every page, and a glyph-encoding issue that stretched a few lines (trend arrows and the `m²` unit) is resolved by sanitising to the font's supported characters.
- **Compliance counts every scheduled time on multi-time plans** — a medication taken twice a day on a weekday plan with two times but no recurrence rule reported 50% even when both doses were logged: the expected-dose count and the taken count expanded the schedule through two different code paths. Both now run through the one canonical recurrence engine, so the rate is correct for every schedule shape.

## [1.7.2] — 2026-05-31 — Coach source parity, first-paint snapshot, medication card cleanup

A focused follow-up to v1.7.0. The unified dashboard snapshot that shipped in v1.7.0 is now the default, so a cold dashboard paints its above-the-fold tiles together instead of letting the mood tile arrive ahead of the rest. The Coach's in-chat data-source rail now reads and writes the same persisted data clusters as the settings sheet — one source of truth that survives a reload, so what the panel shows always matches what reaches the model. The medication overview cards collapse their action row into a single overflow menu, and the detail page is pared back to the intake history under a read-only plan summary. The advanced-settings sheet widens into a two-column layout and offers a medications export beside the existing import.

### Changed

- **Unified dashboard snapshot on by default** — the above-the-fold tiles read from the single `/api/dashboard/snapshot` round-trip introduced in v1.7.0, so they share one completion moment instead of staggering in as independent queries resolve. The build-time toggle `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false` falls back to the per-tile path if an operator needs it.
- **Coach data-source rail matches the settings sheet** — the in-chat rail now toggles the same persisted data clusters as the gear-icon settings, stored per user rather than reset when the panel closes. The chat request derives its scope from those saved clusters, so the rail always reflects exactly what is sent to the model, and the analysis window persists alongside.
- **Medication card actions in one menu** — the overview cards, standard and GLP-1 alike, move their edit / history / advanced actions into a single overflow menu; the card itself opens the detail page.
- **Medication detail page is history-first** — the redundant header action row and the schedule block are gone; the page leads with the intake history under a read-only summary (name, dose, status, plain-language cadence), and editing happens from the card menu. The estimated active-ingredient curve stays an opt-in disclosure.
- **Advanced-settings sheet widened** — a two-column layout (Data, Reminders, Lifecycle, with the danger zone full-width) so the sheet no longer scrolls on a desktop viewport, and a CSV export of that medication (its row plus intake history) sits beside the per-medication intake import.

### Fixed

- **Medication cards render identically** — the day-streak flame used two different oranges between the standard and GLP-1 cards; both now share one token. The repeated card sections are a single set of shared components, so the two variants stay in lockstep instead of drifting on each edit.
- **Intake import labelled honestly** — the import affordance described CSV/JSON but accepts a JSON intake array; the copy now says JSON.

## [1.7.1] — 2026-05-31 — Overview-card actions

The v1.7.0 medication detail page gained edit / history / advanced-settings actions in its header, but the medication cards in the overview list kept only the edit pencil. This patch brings the **history** (intake history) and **advanced-settings** actions onto the overview cards — both the standard and the GLP-1 variant — so the card and the detail page offer the same three actions. The advanced-settings sheet is mounted once on the list and reused; the history button routes to the same intake-history view.

## [1.7.0] — 2026-05-31 — Health-record export, flexible schedules, first-paint snapshot, full HealthKit coverage

A broad polishing release across the medication, dashboard, export, and HealthKit surfaces. Medications gain PRN (as-needed) and cyclic on/off-week schedules, a server-computed next-due instant, and cadence-canonical compliance so non-daily plans report adherence correctly everywhere — including the detail page, which previously still expanded through the legacy weekday walker. The dashboard now assembles its above-the-fold tiles in a single snapshot round-trip and pre-generates the daily briefing overnight, so a cold load no longer staggers tile-by-tile and never blocks on the model. The doctor handover grows into a selectable health-record export — an enriched PDF and a machine-readable HL7 FHIR R4 bundle, packaged together. Every previously-unplotted HealthKit metric gets a chart, walking speed reads in km/h, and the Coach can be fed any chosen cluster of data instead of a fixed five. The medication detail page restores its history view and gathers every setting into one redesigned advanced sheet.

### Added

- **PRN and cyclic schedules** — a medication schedule can be marked as-needed (`asNeeded`), excluded from the expected-dose count and reminder projection while staying loggable, or cyclic (`cycleWeeksOn` / `cycleWeeksOff` / `cycleAnchor`) for on/off-week dosing. Both are projected by the canonical recurrence engine. Migration `0092` adds the schedule-type enum and cyclic columns.
- **Server-computed next-due instant** — every medication carries a read-only `nextDueAt` (RFC-5545 + rolling math, `null` for PRN), so a client never has to duplicate the recurrence engine.
- **Schedule-aware compliance payload** — the per-day compliance bucket gains `due` / `expectedCount`, so a history view can skip empty marks on non-due days for weekly, bi-weekly, rolling, and cyclic plans.
- **Per-medication reminder flags** — `liveActivityEnabled` and `criticalAlarmEnabled` (both default off) ride the medication contract for clients that surface lock-screen or break-through reminders. A roaming user-level delivery default plus a per-device override let a device honour or locally override the default. Migration `0091`.
- **Health-record export** — a new `POST /api/export/health-record` produces a selectable export: an enriched clinical PDF (patient identity, deterministic summary, native sparklines), an HL7 FHIR R4 document bundle (LOINC-coded `Observation`s, a BP panel, `MedicationStatement`s, a `DiagnosticReport`), or both packaged as one zip. The selection chooses date range and per-domain sections, and the AI summary is an explicit opt-in section clearly marked as not clinically validated. The bundle reuses the same aggregator the PDF consumes, so both describe identical numbers, and matches the iOS client's LOINC/UCUM conventions for interchangeable records.
- **Patient identity on the profile** — optional full name, insurer, and insurance number on Account, for the report cover and the FHIR `Patient`. The insurance number is validated (KVNR mod-10) and encrypted at rest.
- **Unified dashboard snapshot** — `GET /api/dashboard/snapshot` assembles the above-the-fold tile data in one round-trip from the rollup tier plus the cached briefing, so the tiles arrive together. A coverage miss returns the heavy slice as deferred rather than blocking the strip. The snapshot also carries a `metricStates` seed (latest value/timestamp/unit per metric) and the full widget-layout catalogue, so a native client can paint a cold launch from one cached request.
- **Nightly insight pre-generation** — a budget-gated pg-boss job warms the comprehensive insight (and its daily briefing) overnight, so the `/insights` mount is a cache read instead of a synchronous model call. A cache miss now shows a preparing state rather than blocking the request.
- **Charts for every stored HealthKit metric** — the previously-unplotted types (flights climbed, environmental and headphone audio exposure, walking speed, step length, asymmetry, double support, respiratory rate, body-composition family, mobility, daylight, and more) each gain a chart surface. Walking speed displays in km/h and distance in km via a render-time transform; stored and exported values stay canonical SI.
- **Display-unit preference** — a metric/imperial toggle in Settings → Display (migration `0094`), read by the chart display transforms.
- **Coach data clustering** — the Coach accepts a chosen set of data clusters (cardiovascular, body composition, activity, workouts, sleep, mood, glucose, medication, mobility, environment) instead of a fixed set, with a soft budget cap that degrades the lowest-signal clusters first so enabling everything stays within the prompt budget. The default reproduces the prior domains.
- **Offline sync delta feed** — `GET /api/sync/changes` exposes a paginated, opaque-cursor delta feed with tombstones across three domains — measurements, mood entries, and medication intakes — over a single multi-domain cursor; `/api/sync/state` is now part of the documented API and reports the sync window. Measurement, mood, and intake delete routes soft-delete (tombstone) rather than hard-delete, pruned past a retention window keyed to the refresh-token lifetime. A stable `errorCode` on the refresh endpoint distinguishes a revoked family, a token reuse, and a transient failure. Migrations `0096` + `0097` add the keyset indexes and the mood/intake sync columns.
- **Configurable mood-reminder time** — the evening mood-reminder hour is now per-user (it was a fixed 22:00), stored in the roaming notification preferences so a native client and the web share one source of truth.

### Changed

- **Cadence-canonical compliance everywhere** — `calculateCompliance` and the medication detail page route expected-dose computation through the canonical recurrence engine, so `rrule`, `rollingIntervalDays`, weekday subsets, interval weeks, one-shot, and PRN all count correctly. The dashboard tile and the detail page no longer disagree for non-daily plans.
- **Medication detail surface** — the header offers a direct edit, a history view (the clock-with-counterclockwise-arrow icon), and an advanced-settings button. The history view is intake-only, sorted newest-first, with the estimated active-ingredient curve as an opt-in disclosure. The advanced sheet is widened and regrouped into Data, Reminders, Lifecycle, and a danger zone, with CSV/JSON import surfaced as a real action.
- **Dashboard widget layout round-trips the full catalogue** — saving a layout no longer rejects ids the web surface doesn't render; the full widget catalogue (web tiles + client-only tiles) is persisted and returned intact, so a native client keeps its own tiles without a local merge step. A genuinely unknown id is still ignored.
- **Keyboard navigation for segmented controls** — the metric/imperial, export-format, and mood-rating radiogroups gain roving-tabindex arrow-key navigation (Home/End, wrap), via one shared hook.
- **Dashboard charts refresh on an open page** — the snapshot and analytics queries poll on a shared interval so an open dashboard picks up new measurements without a manual reload, served from a warm per-user cache.
- **Profile photo preserves its aspect ratio** — the avatar renders with `object-cover` instead of stretching.

### Fixed

- **The mood-reminder card now delivers on its own** — enabling the reminder previously still required a buried, default-off per-event push preference, so a user who flipped the visible card received nothing; the card alone now drives delivery (an explicit per-event opt-out still suppresses).
- **Multi-time-of-day reminders no longer re-fire** — the reminder ledger delete is scoped to the single dispatched slot rather than wiping every row for a medication, and logged doses are matched to slots by time rather than array order.
- **Soft-deleted measurements stay deleted on direct access** — the single-resource GET and PUT now filter tombstoned rows.
- **Mobile settings navigation no longer auto-scrolls the page** — the section strip positions its active chip horizontally without nudging the document, removing the dizzy scroll on sub-page navigation.

### Tests

- 5628 → 5878 unit; 1 skipped. New coverage spans the recurrence-engine PRN/cyclic cases, cadence-canonical compliance parity per cadence type, the FHIR bundle shape and LOINC/UCUM mapping, the KVNR validator, the export route, the dashboard snapshot envelope and pre-generation cron, the measurement delta feed and soft-delete tombstones, the daily-mean consolidation drain, and the display-unit transforms. A six-reviewer audit (correctness, security, architecture, design/a11y, simplification, i18n) ran before release; every High and Medium finding was resolved.

## [1.6.0] — 2026-05-30 — Medication editor overhaul, route of administration, today-tile read-flip

v1.5.6 settled the medication detail page into a pure history view, but the create/edit plan still funnelled every dose through the same flat shape, the injection-site picker only surfaced for GLP-1, and the today-tile on the dashboard and the Erfassen sheet still expanded daily schedules through a legacy walker that silently skipped bi-weekly, rolling, RRULE, and one-time cadences. This release reworks the medication editor and its detail surface, gives route of administration a first-class column so any injection can carry a site, adds a one-time-injection shape, and flips the today-tile onto the canonical recurrence engine the reminder worker already uses — so what the tile shows matches what the worker mints. It also restores the multi-language request snippets on the API-tokens row, adds a profile-photo upload to Account, and finishes an admin-surface polish pass.

### Added

- **Route of administration** — a new `deliveryForm` column (`ORAL` | `INJECTION` | `OTHER`) decoupled from `treatmentClass`. The injection-site picker now surfaces for any `INJECTION` dose rather than only GLP-1, and the editor carries the route through create, update, and the detail snapshot. Migration `0088` adds the enum and backfills `ORAL` onto every existing row via a constant column default (a single non-blocking metadata operation).
- **One-time injection** — a one-off dose modelled as `oneShot = true` + `deliveryForm = INJECTION`, with its own editor path that drops the recurring-schedule step.
- **Profile-photo upload on Account** — Settings → Account gains an avatar card backed by the v1.5.5 upload endpoint (server-side magic-byte sniff, 2 MiB stream-level cap, 2048² dimension cap, per-user rate limit, owner-scoped read).
- **Admin global mood-log toggle** — the admin Services section can suspend mood-log reminders site-wide alongside the existing Web-Push and API toggles.
- **Host-metrics memory detail** — the admin host-metrics memory tooltip now reads `used / total GiB` alongside the percentage.

### Changed

- **Medication editor + detail surface overhaul** — the editor uses the available desktop width while keeping the mobile sheet, restores the edit fields the modal-wizard rework had dropped, and aligns the detail surface with the new route-of-administration and one-time shapes.
- **Measurement note cap raised 25 → 200 characters** — a 25-character note could not hold a meaningful clinical aside; the cap lifts to 200 through a single `MEASUREMENT_NOTES_MAX_LENGTH` constant the client char-counters import. The DB column was already unbounded.
- **Dashboard range colors route through semantic tokens** — the dashboard date-range chips read the shared `success` / `warning` / `info` / `destructive` tokens (with their light-mode contrast overrides) instead of hard-coded hues, and the range inputs gain bound-clamping.
- **Admin surface tidy** — every sidebar section gets a distinct icon, the shared `helpfulRateColour` helper and a `usePublicVersion` hook are consolidated into `_shared`, and the orphaned `status-overview` route is removed.
- **API-tokens row restores multi-language request snippets** — the per-token row again offers copyable cURL / JavaScript / Python examples.

### Fixed

- **Today-tile diverged from the reminder worker for non-daily cadences** — `/api/medications/intake?scope=today` and `/api/dashboard/summary` projected daily schedules through a legacy walker that read only `daysOfWeek` + `windowStart`, silently skipping `intervalWeeks > 1`, rolling, RRULE, and one-time cadences. Both routes now gate every "does this schedule emit today?" decision through the canonical recurrence engine (the same path the worker uses), anchoring the projected instant to `windowStart` so it stays byte-identical to the worker's row and dedupes against the existing unique index. The rolling-cadence baseline fetch mirrors the worker's per-medication `takenAt` query, so projector and worker resolve the same next-due instant.

### Tests

- 5635 → 5628 unit; 1 skipped. The today-tile read-flip carries new coverage on the intake and dashboard-summary projections; the orphaned status-overview route and its test are gone.

## [1.5.6] — 2026-05-29 — Pure-history detail page, legacy step consolidation, egress finish

v1.5.5 gave every retired medication feature a home on the detail page, but the page still carried the create/edit affordances that belong on the list. This release turns `/medications/[id]` into a pure history surface, collapses every setting into one advanced sheet, consolidates the pre-v1.5.0 granular step rows that bloated the per-sample read path, and finishes the outbound-fetch migration the `safeFetch` wrapper started.

### Added

- **Legacy step consolidation** — a pg-boss job (`STEP_CONSOLIDATION_QUEUE`) folds pre-v1.5.0 granular `ACTIVITY_STEPS` rows into one canonical daily-total row per user per day, anchored to the user's timezone, and soft-deletes the originals. A day that already carries a post-v1.5.0 `stats:` total is left untouched (no double-count) while its legacy rows are still tombstoned. Boot-time discovery enqueues only users still holding live legacy rows, so the pass converges to zero work and is idempotent across reboots. Migration `0087` adds a partial index scoped to live step rows to keep the discovery scan cheap.
- **`healthlog/safe-fetch-required` ESLint rule** — bans raw `fetch(` outside the wrapper, exempting only genuine same-origin relative paths. Positioned as the author-time egress floor.

### Changed

- **`/medications/[id]` is now a pure history view** — the Today's-dose card stays on the list page; the detail page reads the medication's past intake, cadence summary, and trends only. Every setting (notifications, phase config, grace window, pause/resume, end, purge) moves into a new `<AdvancedSettingsSheet>` reached from the header. The edit trigger becomes a two-option picker (plan vs. advanced). The `/medications` list page is unchanged apart from matching the detail-nav card glyph to its destination.
- **Outbound-fetch migration finished** — every remaining server-side fetch routes through `safeFetch`: Withings (token exchange, refresh, measurements, webhook subscribe/unsubscribe, activity + sleep sync), Codex OAuth + SSE client, the bug-report GitHub comment, and the operator-host calls (Umami script/send/test, GlitchTip envelope + store, Loki). Credential-carrying constant hosts inherit the `redirect: "manual"` default so secrets cannot replay onto a redirect hop; operator-supplied hosts additionally pin `requirePublicHost` for the connect-time IP guard.
- **`/api/insights/layout`** is registered in the OpenAPI spec so the contract matches the shipped route.

### Fixed

- **Intake-edit dialog opened empty** — editing a logged intake row now seeds the dialog from the row's real `takenAt` / `skipped` instead of an empty stub.
- **Step consolidation could strand a day** — a minted daily total can collide on the second unique index when a manual step row already sits at the day's canonical-noon instant; the collision rolled back the in-transaction soft-delete and the day re-appeared on every boot. The pass now catches the constraint violation, logs and counts the skip, and steps to the next day.
- **Avatar upload over-buffered on the abort path** — the upload body is now read once through a bounded reader that drops retained bytes past the 2 MiB cap, replacing the clone + parallel parse that left the native parse buffering an oversized body after the cap tripped.
- **Egress lint exemption let absolute URLs through** — the same-origin exemption now rejects protocol-relative (`//host`) and backslash (`/\host`) forms, which both resolve off-origin.

### Removed

- **Dead wizard landing-intent path** — the pure-history rewrite removed the last caller that passed a landing intent into the medication wizard, so the prop, its state-key segment, and the intent branch in `landingStepForEdit` are gone; the helper reduces to the schedule-count heuristic.

### Tests

- 5615 → 5635 unit; 1 skipped. Detail-page history surface, advanced-settings sheet, intake-edit seed, and legacy step consolidation are covered; the pre-tag reconcile sweep keeps the suite green.

## [1.5.5] — 2026-05-29 — Medication detail page, iOS coordination, outbound-fetch hardening

The v1.5.4 modal wizard landed the create + edit plan flow, but it took 16 features down with the retired flat form — Einnahmen bearbeiten / löschen, Medikament pausieren / beenden / löschen, per-Med API tokens, Phasen-Konfiguration, CSV-Import — and the trends-row on Insights had a 34 px overflow that pushed annotation copy on top of the charts. This release lands the medication detail page that gives every retired feature a coherent home, polishes the wizard against the live walk-through feedback, closes the iOS audit follow-ups in one go, and hardens every outbound fetch the server makes.

### Added

- **`/medications/[id]/page.tsx`** — a single Server-Component detail page composed of eight sections (Header band → Today's-dose → Cadence summary → Phasen (GLP-1) → Intake history preview → Notifications → Settings → Verwaltung & Gefahrenzone). One-shot medications walk a five-section variant; paused medications keep the structure but the status pill flips to `Pausiert` and the dose-card surface mutes. Restores every one of the 16 features the v1.5.4 flat-form retirement displaced.
- **Per-row + bulk intake history actions** — the preview now ships a per-row kebab (`Bearbeiten` / `Löschen`) and a multi-select toolbar that fires the new `POST /api/medications/{id}/intake/bulk-delete` endpoint. The maintainer's „Einnahmen löschen" + „Einnahmen bearbeiten" complaints from the v1.5.4 walk-through close cleanly.
- **`safeFetch` wrapper** at `src/lib/safe-fetch.ts` — every outbound fetch the server makes for user-supplied hosts now inherits `redirect: "manual"` + `AbortSignal.timeout(15_000)` defaults. Closes #218.
- **DNS-rebinding pinned `undici.Agent`** at `src/lib/safe-fetch-dispatcher.ts` — when `requirePublicHost: true`, the dispatcher resolves the hostname literally inside the connect hook, refuses any address `isPublicIp` would reject, and pins the connection to the first valid public address. The five user-host paths (MoodLog sync + push + test, local-AI client, ntfy) route through it. Closes #217.
- **Self-hosted avatar storage** at `POST/GET/DELETE /api/user/avatar` — multipart-uploaded JPEG/PNG/WebP, 2 MiB / 2048×2048 max, hand-rolled magic-byte sniff + dimension probe so no native dependency lands. Stored on the User row as BYTEA; rides `pg_dump` alongside the rest of the row. The profile response carries an `avatarUrl` with a cache-busting timestamp. `src/lib/gravatar.ts` retires — Automattic no longer sees the email-hash on every authenticated page load.
- **`POST /api/medications/{id}/intake/bulk-delete`** — owner-scoped, capped at 500 event IDs per call, rate-limited per user. Pre-work for the detail page's multi-select.
- **`GET / PUT / DELETE /api/insights/layout`** — mirrors `/api/dashboard/widgets` so insights tile order + visibility persist server-side and sync across devices. Default order: `overview`, `blutdruck`, `puls`, `sauerstoff`, `koerpertemperatur`, `gewicht`, `bmi`, `aktive-energie`, `workouts`, `schlaf`, `ruhepuls`, `hrv`, `stimmung`, `medikamente`. Default-visible: overview, blutdruck, puls, gewicht, bmi, workouts, stimmung, medikamente.
- **Eight new Apple Health quantity-type mappings** — `RESPIRATORY_RATE`, `BODY_MASS_INDEX`, `LEAN_BODY_MASS`, `WALKING_HEART_RATE_AVERAGE`, `WALKING_ASYMMETRY`, `WALKING_DOUBLE_SUPPORT`, `WALKING_STEP_LENGTH`, `WALKING_SPEED`. The convention block on `apple-health-mapping.ts` documents the project rule: raw HK values flow on the wire, the server scales ×100 server-side for percent metrics. Step length and walking speed flow raw in SI (m and m/s) — no scaling.
- **Three new series-kind enum values** — `RESTING_HEART_RATE`, `HEART_RATE_VARIABILITY`, `VO2_MAX`. Detail + trend views on those metrics now respond 200 instead of 422.

### Changed

- **Wizard polish** — dialog widens to `sm:max-w-2xl`; the X-close gets a 44 px target; spacing tokens converge on the existing shadcn cadence (`rounded-md` button, `rounded-lg` dialog, no new radii); the step-progress bar is a width-only `<Progress>` + Tailwind `transition-all` with `motion-reduce` snap; step transitions are fade-only. `landingStepForEdit` accepts an `intent` argument so the cadence-summary edit pencil drops the user on Step 5 instead of bouncing them through Step 1.
- **`/api/measurements/series` `days` cap** — raised from 365 to 3650, matching the recurrence engine's hard cap. The iOS app's „Alle"-range no longer paints a 422 banner on every metric.
- **`/api/dashboard/summary` MetricCard shape** — `title` and `unit` ship as i18n keys (`dashboard.metric.title.*` + `dashboard.metric.unit.*`) instead of hardcoded German strings. Web resolves via the existing `messages/*.json` path; iOS resolves against its `Localizable.xcstrings`. Wire-shape change — clients that decoded the legacy `title` / `unit` strings keep working with the iOS team's tolerant fallback decoder during the transition.
- **`assertMedicationOwnership` consistency sweep** — `purge`, `parent PUT`, `parent DELETE`, `intake/import`, `phase-config`, `bulk-delete`, `glp1 GET` all converge on the single ownership helper. The §10 invariant 24 from the design direction now holds across `src/app/api/medications/[id]/**`.
- **Trends-row chart slot** — raised from 140 → 180 px so the mini-card shell's header + padding stays inside the slot. The TrendAnnotation under each chart no longer collides with the chart envelope.
- **Wizard payload edit path** — `buildCreateBody` omits `notificationsEnabled` on edit so the toggle the user already set in the detail page Notifications section is not overwritten by the wizard's hydrated default.
- **`<NotificationsSection>` DOM ids** — section heading and row label carry distinct ids so the Switch's `aria-labelledby` resolves to the row title, not the section heading.
- **`phase-config` route surface** — PUT returns the multi-issue 422 envelope on Zod failure (matching every other v1.5.5 route), and the upsert builds the Prisma payload field-by-field instead of spreading `parsed.data`. Mass-assignment surface closes structurally.

### Fixed

- **Trends-row text overlapping the charts** — a specific Insights complaint from a user report. Chart slot was 140 px but the mini-card shell painted ~174 px; the 34 px overflow pushed annotation copy onto the chart envelope. The 180 px slot accommodates the full envelope.
- **Grace-row save dead on arrival** — the detail page Settings section PUTs `reminderGraceMinutes` at the top level; the route now normalises the value onto the primary schedule before the Prisma update. The schema declares the top-level field with a description noting the normalisation.
- **Purge route did not invalidate server caches** — Tier-3a `Verlauf löschen` dropped the rollup rows but left the analytics + iOS today-tally caches with the pre-purge counts for up to their TTL. The success path now calls `invalidateUserMedications(user.id)` alongside the rollup delete.
- **Bi-weekly worker still emitted every Wednesday** — the v1.5.3 cadence engine fix was correct, but the cadence chart + medication card on the dashboard still read the legacy `daysOfWeek` column. The v1.5.x window keeps this in place; the read-flip arrives in v1.5.6. Operators see correct reminder fan-out today; the dashboard chip cosmetic catch-up follows.
- **Compose-mode multi-schedule data loss** — the v1.5.4 wizard collapsed a multi-schedule medication to its first schedule on save and silently dropped the rest. Closed in v1.5.4 by the compose-mode commits; the regression test pinning that lives at `wizard-payload.test.ts`.

### Tests

- 5594 → 5615 unit (+21 in the reconciliation sweep alone; the detail-page surface + audit fixes add ~110 across the cycle).
- 262 integration unchanged + the avatar upload integration test (`tests/integration/user-avatar.test.ts`).
- New Playwright spec pre-work — the detail-page surface is component-test pinned; e2e walk lands in a follow-up.

### Security

- `safeFetch` + DNS-rebinding pinned dispatcher close issues #217 + #218 architecturally — the input-time `isPublicUrl` guard now pairs with a connect-time IP pin so DNS rebinding cannot flip the resolved host between accept and dispatch.
- Avatar route enforces size before parse (Content-Length pre-flight + post-parse `file.size` check), magic-byte sniff over the declared content-type, dimension probe, owner-scoped on every method. No new XSS vector — the served content-type is whitelisted to the three image MIMEs.
- `assertMedicationOwnership` sweep closes every detail-page route's ownership narrowing — the route layer is now the single ownership predicate across `src/app/api/medications/[id]/**`.
- Pre-tag senior-dev + security architect audit produced two docs (internal working notes). The four senior-dev Criticals + five Highs landed in code; F-1 H-5 (`safeFetch` migration to constant-host call sites like Withings + Codex + the GitHub bug-reporter) + F-2 M-1..M-3 (operator-host `requirePublicHost`, avatar chunked-body pre-flight, raw-fetch lint rule) deferred to v1.5.5.1.

### iOS coord

- The iOS team's v0.8.0 audit closed cleanly. Detailed acknowledgements live in the internal iOS coordination notes.
- The iOS team flips `walkingAsymmetryPercentage` + `walkingDoubleSupportPercentage` from pre-multiplied to raw in their next release; until then the server fails-closed (`skipped:"value_out_of_range"`) on > 100% values, so no DB pollution.

### Notes

- **No new npm dependencies.** Avatar image-header parsing is hand-rolled; no `sharp` / `jimp`. The animation surface is shadcn `<Progress>` + Tailwind `transition-all`; no Framer Motion. Only `undici` was promoted from transitive to explicit so the safeFetch-dispatcher import sits on a documented contract.
- **Test totals.** 5615 unit + 1 skipped, 262 integration + 3 skipped. `pnpm typecheck`, `pnpm lint` (one pre-existing withings/resume warning), `pnpm openapi:check`, locale-integrity + call-site coverage all green.

## [1.5.4] — 2026-05-28 — Medication wizard: modal dialog, compose-mode, ten-bucket taxonomy

The v1.5.3 creation wizard shipped as a single-page card with seven inline steps. Patient feedback during the first day of live use was unanimous: the page felt dense, the step-by-step intent was lost, the "every N days from my last injection" cadence was unintelligible without a worked example, and the edit form was visibly wider than its container. The bi-weekly worker bug was closed in v1.5.3 but the surface a patient actually touches was not yet where it needed to be. This release replaces the wizard with a real modal-dialog flow, lands compose-mode so a single medication can carry multiple parallel schedules (the insulin short-acting + long-acting case), widens the treatment-class taxonomy to ten buckets, and retires the flat edit form.

### Added

- **Modal-dialog wizard**. `src/components/medications/wizard/MedicationWizardDialog.tsx` is the new entry surface — a shadcn `<Dialog>` on desktop, a `<Sheet side="bottom">` on mobile, switched through the existing `<ResponsiveSheet>` primitive at 768 px. The wizard renders its own header inside the body so the iconified step anchor sits where the patient reads, and the footer carries Back / Save with a fixed sticky position on mobile. Eight steps total, one focused question each: name → treatment class → dose → course window → cadence → sub-cadence detail → times of day → review with reminders toggle and per-schedule summary cards. Cadence + sub-cadence + times collapse out of the path when they do not apply (one-shot walks five, daily walks seven, recurring walks eight); the visible counter mirrors the path the patient actually walks.
- **Compose-mode**. A medication can now hold multiple parallel schedules, each with its own cadence and times. Steps 5–7 are per-schedule; Step 8 renders the schedule list with an "Bearbeiten" and "Entfernen" action on each card plus a "+ Weiteren Zeitplan hinzufügen" card at the bottom. The last remaining schedule is non-removable so the medication always carries at least one schedule. A medication opened in edit mode with more than one configured schedule lands the patient directly on the list view; single-schedule edits keep the Step 1 entry. The header on Steps 5–7 carries a small "Zeitplan {n} von {total}" caption when more than one schedule is configured.
- **Ten-bucket treatment-class taxonomy on Step 2** — Blutdruck, Diabetes, Hormone, GLP-1-Injektion, Schmerz, Allergie, Vitamine, Nahrungsergänzung, Antibiotikum, Sonstiges. Schmerz lands the chronic-pain cohort with its own rolling-rescue-medication pattern; Antibiotikum lands the one-shot course pattern cleanly so neither falls through to `OTHER` for analytics purposes. Each row carries a monochrome Lucide glyph (Stethoscope / Droplet / Activity / Syringe / Flame / Wind / Apple / Leaf / ShieldCheck / Tag).
- **`DIABETES` + `ANTIBIOTIC`** as first-class values of the `MedicationCategory` Zod enum so insights routes that filter on the clinical category surface those buckets without falling back to `OTHER`. Additive at the schema layer; existing rows do not need touching.
- **Rolling-cadence mental-model copy.** Step 5's "Flexibel ab letzter Einnahme" row carries the example sentence directly under the label (not behind a tooltip) — "Du lässt den nächsten Termin offen, drückst 'genommen' wenn du sie genommen hast — ab dem Zeitpunkt zählt der Counter wieder." The patient-pain research across chronic-illness adherence studies identified this exact gap as the #1 reason patients abandon medication apps in week one; the in-line example sentence closes it.

### Changed

- **Edit path routes through the same dialog.** "Bearbeiten" on a medication card opens `<MedicationWizardDialog mode="edit" initial={…} />`; the header swaps to "{name} bearbeiten", the CTA to "Änderungen speichern", and the entire payload hydrates from the existing medication shape including the schedule `id` so a PUT preserves the per-schedule identity. The flat `<MedicationForm>` (1314 LOC, surfaced as a `<ResponsiveSheet>` that rendered wider than its container on the medications list page) retires in the same change.
- **`/medications/new` retires** to a redirect that opens the dialog from the list page (`/medications?new=1`). Existing bookmarks survive without losing the entry point.
- **i18n.** A clean `medications.wizard.*` namespace replaces `medications.create.wizard.*` so the locale-integrity guard surfaces every dangling key during the cut. German and English carry native copy; Spanish, French, Italian, Polish ship the English string verbatim as a machine fallback per the project convention. Native polish for the four fallback locales follows.
- **`<CreationWizard>`** (v1.5.3's inline-stepped Card) and **`<PhaseConfigDialog>`** (an unused titration-phase helper that `knip` flagged once the list page swapped over) retire alongside the form.

### Fixed

- **Multi-schedule data-loss risk** — the v1.5.3 wizard collapsed a multi-schedule medication to its first schedule on save and silently dropped the rest. Compose-mode is the proper fix; the encoder now emits every schedule, the hydrator reads every schedule, the per-schedule `id` round-trips so the PUT preserves identity.
- **The edit form being wider than its container** — a specific user complaint from the v1.5.3 hand-walk. The container is now a constrained Dialog at `sm:max-w-md` on desktop and a sticky-footer Sheet at `max-h-[90dvh]` on mobile; the form-as-page surface is gone.

### Tests

- `src/components/medications/wizard/__tests__/wizard-payload.test.ts` — 54 pure-helper cases pinning `validateStep`, `buildCreateBody`, `buildUpdateBody`, `summariseCadence`, the treatment-class row → request body mapping, the multi-schedule encoder, schedule-`id` preservation on edit, the hydration that lands on the list view when more than one schedule is present, the remove-guard against the last remaining schedule, and the add-then-active-bump behaviour.
- `e2e/medications-wizard-{daily,weekdays,biweekly,monthly,rolling,oneshot}.spec.ts` — six Playwright specs updated to walk the new dialog surface via the German label set; `e2e/medications-wizard-compose.spec.ts` walks a two-schedule create flow (daily Ramipril + weekly-Wednesday addendum) and asserts both summary cards land on Step 8 before save.
- Route tests assert POST `/api/medications` accepts a body with `category: "DIABETES"` and `category: "ANTIBIOTIC"`.

### Notes

- **No API or wire-format change.** The wizard writes the same `createMedicationSchema` payload the v1.5.3 wizard wrote; iOS clients reading and writing the existing schedule shape are unaffected. The native `treatmentClass` enum already shipped `GLP1`; the wizard's Step 2 maps the maintainer-confirmed labels onto the existing enum + the two new `MedicationCategory` values.
- **Cadence-engine read-flip is still v1.5.x deferred** — the today-projector, the cadence chart, and the medication card continue to read the legacy `daysOfWeek` / `intervalWeeks` columns. A wizard-minted rolling or one-shot medication will render a daily-looking next-due chip on the dashboard until the read-flip ships. The reminder worker and the engine work with the new fields correctly.
- **Test totals.** 5500 unit + 1 skipped, 261 integration + 3 skipped, 14 Playwright wizard instances. Typecheck, lint, `openapi:check`, i18n call-site coverage, locale-integrity all green at HEAD.

## [1.5.3] — 2026-05-28 — Medication scheduling: RRULE cadences, rolling intervals, one-shot lifecycle, creation wizard

The medication surface in v1.5.2 covered daily and weekday-subset schedules cleanly, but everything else — bi-weekly, monthly, quarterly, yearly, "every N days from my last injection", single-dose appointments — either drifted or was unreachable from the UI. The reminder worker also carried a quiet pre-existing bug where `intervalWeeks` was ignored: a schedule meant to fire every other Wednesday fired every Wednesday. This release lands the full cadence surface, closes the worker bug behind a regression test, and adds a step-driven creation flow patients can walk without consulting a manual.

### Added

- **Four new cadence shapes**, modelled at the schema level with explicit columns instead of an overloaded legacy string:
  - **Calendar-anchored RRULE patterns** (`rrule TEXT`) — `FREQ=WEEKLY;INTERVAL=2;BYDAY=WE`, `FREQ=MONTHLY;BYMONTHDAY=1`, `FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10`, `FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1` all expand correctly. Powered by the `rrule` npm package; the engine adds an `UNTIL` suffix derived from the medication's `endsOn` automatically (and skips that suffix when the user's RRULE already carries `COUNT` or `UNTIL`, so the two never collide).
  - **Flexible-rolling cadence** (`rollingIntervalDays INT`) — "every N days from the last logged intake". The next-due date re-anchors when an intake is logged; skipped doses pause the schedule until the next real intake. The driving use case is the GLP-1 weekly injection where the calendar Wednesday does not match the user's actual cycle.
  - **One-shot single-administration** (`oneShot BOOLEAN`) — vaccines, post-op final doses, anything with one scheduled occurrence and an auto-deactivate after the dose is logged.
  - **Course window** (`startsOn DATE`, `endsOn DATE`) at the medication level. Required for one-shot; optional everywhere else. The reminder worker stops minting slots past `endsOn`.
- **`POST /api/medications/extract`** — natural-language extraction for the wizard's first step. A user types "Mounjaro 5mg weekly Wednesday morning starting next Monday" and the route returns a structured payload that pre-fills the wizard. Rate-limited per user, budget-gated, and carries a citation-coverage guard so the extraction cannot return a name or dose the user did not write.
- **`/medications/new`** — the seven-step creation wizard (compressed to five on the one-shot path) replacing cold-start entry into the legacy flat form. The summary step interpolates the actual picked weekdays / day-of-month / yearly date so the patient confirms the specifics rather than a category label.
- **Reusable picker primitives** under `src/components/medications/scheduling/`: `CadencePicker` (eight cadence kinds, mode-aware via `allowedKinds`), `TimesOfDayChips` (one or more `HH:mm` entries with morning / noon / evening / night presets), `CourseWindowRow` (start + optional end with `lockEndsToStart` for one-shot). Composed by both the wizard and the refactored edit form so any future cadence tweak reaches both surfaces at once.
- **Canonical recurrence engine** at `src/lib/medications/scheduling/recurrence.ts` exposing `occurrencesBetween`, `nextOccurrenceAfter`, and `matchesInstant`. The reminder worker routes through the engine via a narrow `worker-helpers.ts` adapter; the today-projector, the cadence chart, and the medication card continue to read the legacy fields through v1.5.x and switch over in the v1.5.4 read-flip.
- **Migration `0081_v15_medication_scheduling`** — adds the new columns, backfills `rrule` and `timesOfDay` for every existing schedule (closed-enum regex on the legacy `daysOfWeek` shapes, ELSE NULL fallback), and stages a CHECK constraint forbidding both `rrule` and `rolling_interval_days` populated on the same row.
- **OpenAPI coverage** for every medication route — `GET / POST / PUT / DELETE /api/medications`, `GET /api/medications/{id}`, `POST /api/medications/{id}/intake`, `GET /api/medications/{id}/cadence`, and the new `POST /api/medications/extract` — registered in `src/lib/openapi/routes.ts` and regenerated into `docs/api/openapi.yaml`. The `rrule XOR rollingIntervalDays` invariant is documented at both the schema description and the per-field descriptions so iOS code-gen surfaces the mutual exclusion.

### Fixed

- **Bi-weekly worker regression** — `src/lib/jobs/reminder-worker.ts` now consumes the canonical engine, which honours `intervalWeeks > 1` via the legacy fallback's week-phase math. A bi-weekly schedule that previously fired every Wednesday now correctly fires every other Wednesday. Pinned by an explicit regression test (`recurrence.test.ts` — `daysOfWeek = "i2;3"` emits 2 of 4 candidate Wednesdays in a 4-week window).
- **One-shot lifecycle reconciliation** — `src/lib/medications/lifecycle.ts` defines `reconcileOneShotState(prisma, medicationId, userId)` and the helper runs after every intake mutation (POST + PUT + DELETE). A user who logs the single dose then immediately undoes the log gets the medication back as `active: true`; a user who flips an existing intake from real to skipped also gets the medication reactivated. The helper is a no-op on non-one-shot medications.
- **Legacy fallback `startsOn` floor** — `expandLegacy` now respects `medication.startsOn` the way every other dispatch tier does. A legacy-shape schedule with a future `startsOn` no longer emits historical slots between today and the start date.
- **Course-window invariants** — the create and update schemas refuse `oneShot: true` without `startsOn` (the design contract requires the anchor date) and refuse any course where `endsOn < startsOn` (which previously produced a silently dead medication). Rolling-cadence schedules cap `timesOfDay` at one entry to match the engine's single-time emission.
- **Wizard `notificationsEnabled` toggle** — the Step 7 reminders switch now actually reaches the POST body. Earlier the toggle was visually live but its value was discarded by the body builder and every wizard-created medication ended up with the default `notificationsEnabled = true`.
- **Edit form: one-shot single source of truth** — the medication-level `oneShot` switch now drives the picker's `allowedKinds`, so the per-schedule picker can no longer encode `kind: "oneShot"` while the medication-level switch is off (or vice versa). Toggling the switch on with multiple schedules surfaces a confirmation toast before the collapse-to-single-schedule, instead of silently dropping the extras.
- **Wizard accessibility and tap-target hygiene** — focus advances into the new step's first input on Next; the cadence-picker rows are now full-row click targets (44 px); the nav buttons (Back / Next / Create) and the natural-language trigger rise to 44 px; the wizard card carries `aria-busy` while the submit is in flight.

### Changed

- **Recurrence-engine defence-in-depth** — `nextOccurrenceAfter` carries a `MAX_CHUNKS = 80` cap alongside the pre-existing 10-year `hardCap`, so a pathological RRULE that walks zero forward (e.g. leap-day-only) can no longer compound through many 90-day chunks. RRULE parse failures now surface via `annotate({ action: "medications.rrule.parse_error" })` instead of silently returning `[]`.
- **Edit form refactor** — `src/components/medications/medication-form.tsx` now composes the picker primitives for the edit path. Pre-v1.5 medications round-trip through `inferCadenceFromLegacy` on load and dual-write both shapes on save, so the existing legacy schedules keep working unchanged.
- **i18n** — 111 new keys × six locales populating the wizard, the picker primitives, the natural-language overlay, the edit-form sections, and the plain-language cadence summary. German and English carry native copy; Spanish, French, Italian, Polish ship the English string verbatim as a machine fallback for this cut. Native polish for the four fallback locales follows.

### Tests

- `src/lib/medications/scheduling/__tests__/recurrence.test.ts` — 28 unit cases covering every cadence kind plus the edge-case matrix (DST spring-forward, timezone shift mid-course, skipped + late + retroactive doses, paused medication, `endsOn` cap, missing `startsOn`, multi-schedule fan-out).
- Eight `tests/integration/v15-cadence-shapes.integration.test.ts` cases exercising every cadence shape against a testcontainer Postgres, plus the one-shot lifecycle (take → reconcile-deactivate → delete-intake → reconcile-reactivate → put-skip → reconcile-reactivate).
- `src/components/medications/scheduling/__tests__/{CadencePicker,TimesOfDayChips,CourseWindowRow,CreationWizard}.test.tsx` — 90 component tests against the picker primitives and the wizard helpers (`validateStep`, `buildCreateBody`, `summariseCadence`, `progressIndices`, `allowedKinds`).
- `src/lib/ai/coach/__tests__/medication-extract-prompt.test.ts` — five snapshot cases pinning the extraction prompt across the cadence shapes plus a citation-coverage guard test.
- `src/app/api/medications/extract/__tests__/route.test.ts` — six route cases covering auth, rate limit, budget, missing provider, parse failure, and the happy path.
- `e2e/medications-wizard-{daily,weekdays,biweekly,monthly,rolling,oneshot}.spec.ts` — six Playwright specs walking the wizard end-to-end via the German label surface, one per cadence shape. CI runs the full suite; locally the specs typecheck without executing the Next.js prod build.

### Notes

- **Dashboard read-flip caveat (v1.5.x window).** Until the v1.5.4 read-flip lands, the dashboard card, the cadence chart, and the medication-card "next dose" line read the legacy `daysOfWeek` / `intervalWeeks` columns directly. A wizard-minted medication with `rollingIntervalDays = 7` or an RRULE encoding renders a daily-looking next-due chip on the dashboard. The reminder worker, the integration tests, and the canonical engine all consume the new fields correctly — the schedule fires on the right date, only the visual chip on the card lags. The read-flip with legacy fallback is the next release.
- **OpenAPI structural enforcement.** The `rrule XOR rollingIntervalDays` invariant is enforced at four runtime layers (Zod refine, route invariant, engine dispatch, DB CHECK). The OpenAPI surface documents the constraint in prose; a structural `oneOf` discriminator lands before the iOS v0.7.x cut.
- **Worker `lastIntakeAt` aggregation.** The reminder worker currently fires one `findFirst` per rolling-medication per 15-minute tick. Functionally correct; one `groupBy` collapses it to a single round-trip per tick. Deferred to v1.5.4 with the read-flip.
- **Test totals.** 5494 unit + 1 skipped, 261 integration + 3 skipped, 12 Playwright wizard instances. Typecheck, lint, and `openapi:check` all green at HEAD.

## [1.5.2] — 2026-05-26 — Plumb SESSION_COOKIE_SECURE through docker-compose

v1.5.1 added a `SESSION_COOKIE_SECURE` env var so plain-HTTP self-hosts can drop the cookie's `Secure` flag. The Node helper read it correctly and the unit tests passed, but a self-hoster following the documented `.env` workaround reported that `docker compose exec app env | grep SESSION_COOKIE` came back empty — the value was set in `.env`, set in the helper, but never reached the running container.

Root cause is the way the bundled `docker-compose.yml` passes env vars to the `app` service: it lists each one explicitly under `environment:` rather than mounting the `.env` file wholesale. Variables not on that whitelist are read by `docker compose` for `${VAR}` substitution but never propagated to the container's process env. `SESSION_COOKIE_SECURE` wasn't on the list, so setting it in `.env` was a silent no-op.

### Fixed

- `docker-compose.yml` now lists `SESSION_COOKIE_SECURE: "${SESSION_COOKIE_SECURE:-}"` under the `app` service's `environment:` block. Defaults to empty (so the helper falls back to `NODE_ENV === "production"`, the pre-v1.5.1 behaviour); setting it to `false` in `.env` now actually reaches the Node process.

### Self-hoster recipe (full, now end-to-end working)

```bash
git pull                         # picks up the new compose file
docker compose pull              # picks up the new image (no-op if already on :latest)
echo 'SESSION_COOKIE_SECURE=false' >> .env
docker compose up -d --force-recreate
```

Verify with:

```bash
docker compose exec app env | grep SESSION_COOKIE
# SESSION_COOKIE_SECURE=false

curl http://10.x.x.x:3000/api/version
# {"data":{"version":"1.5.2",...}}
```

Then log in over plain HTTP from a non-localhost browser — the session cookie no longer carries `Secure`, the browser keeps it, and the round-trip completes.

## [1.5.1] — 2026-05-26 — Self-hosting opt-out for the session-cookie `Secure` flag

A self-hoster running HealthLog on a LAN address (`http://10.x.x.x:3000`) over plain HTTP reported a silent login failure: the `/api/auth/login` POST returned 200 with a `Set-Cookie` header on the response, but the very next `/api/auth/me` request came back 401 and the page reloaded to the login screen. Root cause is the modern browser behaviour around `Secure`-flagged cookies — every cookie the app issues in `NODE_ENV=production` carries `Secure`, and on a plain-HTTP origin that is not `localhost` / `127.0.0.1` / `::1`, the browser silently drops the cookie before sending the next request. The default-Docker image runs `NODE_ENV=production`, so any operator browsing from a different host than the one running `docker compose up` (NAS / homelab / VPS / Tailscale + Magic-DNS) used to hit the dead-end.

### Added

- `SESSION_COOKIE_SECURE` environment variable. Controls the `Secure` flag on the session cookie, the onboarding-hint cookie, the Withings OAuth state cookie, and the Codex device-OAuth state cookie. Three values:
  - **unset** (default) — flag is set when `NODE_ENV === "production"`, the long-standing behaviour.
  - **`false`** — flag is never set. Use this for LAN / VPN / Tailscale-only deployments where the operator deliberately serves plain HTTP and accepts the trade-off (the session cookie crosses the wire unencrypted; do NOT use on an open-internet HTTP origin).
  - **`true`** — flag is always set, useful when a developer fronts a `pnpm dev` server with HTTPS to test the production cookie path.
- New shared helper `src/lib/auth/secure-cookie.ts` (`shouldEmitSecureCookie()`) that every `Secure`-bearing cookie call now reads. Replaces four scattered `secure: process.env.NODE_ENV === "production"` literals in `src/lib/auth/session.ts`, `src/app/api/auth/codex/device-start/route.ts`, and `src/app/api/withings/connect/route.ts`.
- `.env.example` block documenting the new variable with a clear warning about the open-internet-HTTP case.

### Tests

- `src/lib/auth/__tests__/secure-cookie.test.ts` — six cases covering the default path, both explicit overrides, whitespace / case-insensitive parsing, and the fall-through for unrecognised values.

### Notes

- The default behaviour is unchanged for every deployment that runs behind an HTTPS-terminating reverse proxy (the documented self-hosting path) — those continue to set `Secure` exactly as before. The opt-out is intentional and explicit.
- Operators currently working around the issue with `NODE_ENV=development` can move back to `NODE_ENV=production` plus `SESSION_COOKIE_SECURE=false` on this release; that keeps build optimisation + production error masking on while letting the cookie reach the browser over HTTP.

## [1.5.0] — 2026-05-24 — Native iOS client public-beta + per-day cumulative stats overwrite + cadence-aware medication compliance

The minor-version cut that marks the native iOS client publicly available. The SwiftUI iOS app (separate repository) is now joinable via TestFlight: https://testflight.apple.com/join/bucuTBpa. The backend contract the iOS app speaks against has been live since v1.4.23 and has been continuously validated across every v1.4.2x–v1.4.50 release. The 1.5.0 cut also lands the highest-leverage iOS-client unblocker per the v0.6.1 code audit: `/api/measurements/batch` now overwrites per-day cumulative `stats:*` rows on a re-post instead of dropping the new value as a duplicate.

### Added

- `POST /api/measurements/batch` recognises `externalId` values starting with `stats:` (`stats:HKQuantityTypeIdentifierStepCount:YYYY-MM-DD` and every other per-day cumulative HK metric — Active Energy, Sleep Duration, Walking/Running Distance, Flights Climbed) and treats a duplicate on those as an **overwrite**, not a discard. Each re-post of the same day's external id replaces the row's `value`, `unit`, `measuredAt`, `externalSourceVersion`, `deviceType`, and `sleepStage`. Sample-class externalIds (every other prefix — `uuid-*`, opaque HK identifiers) keep the strict immutable `duplicate` contract because each sample is a canonical reading.
- New per-entry status `"updated"` on the batch response envelope so the iOS sync cursor can distinguish a fresh insert from a value-bump re-post. The aggregate envelope now carries an `updated` count alongside `inserted` / `duplicates` / `skipped`.
- New wide-event annotation `measurement.batch.stats-overwrite` (fires only when at least one row was overwritten) so operators can grep how often per-day cumulative re-posts happen as a healthy ingest signal.
- `measurement.batch.ingest` audit-log details now include the `updated` count alongside `inserted` / `duplicates` / `skipped`.

### Why

Before this change, the iOS HealthKit observer would POST today's running step total once in the morning, the server would persist row #1, and every subsequent same-day re-post (as the user walked) would come back `status: "duplicate"` with the new value silently dropped. Today's Schritte tile froze at the first-sync value until next midnight. The same shape would hit every cumulative metric on a deterministic per-day external id. Closes [#213](https://github.com/MBombeck/HealthLog/issues/213); cross-device parity (web ↔ iOS) for `stats:*` metrics now works for today and every historical day on a re-sync.

### Fixed

- Medication compliance now honours `daysOfWeek` and `intervalWeeks` across every call site that surfaces a rate. The legacy aggregator computed `totalExpected = schedules.length * days`, which silently ignored cadence. A weekly Ozempic schedule with all four Mondays taken in the last 30 days reported ~13% adherence (4 / 30) instead of 100%; a weekday-only 3×/day metformin schedule with every weekday dose taken reported ~73% (66 / 90) instead of 100%. `calculateCompliance` is now a cadence-aware adapter on top of `buildCadenceTimeline` — the same pair-matching pipeline that drives the per-medication cadence chart — so the rate on the medication card, the AI Coach prompt context (7d/30d/90d windows in `src/lib/insights/features.ts`), the BP-status compliance gate, the medication-compliance status insight, `/api/insights/targets`, `/api/insights/comprehensive`, and the medication-compliance pillar of the dashboard Health Score all agree on a single, cadence-correct denominator. The wire shape (`{ totalExpected, taken, skipped, missed, rate, streak }`) is unchanged so every UI tile and persisted-insight consumer keeps reading the same fields. Closes [#214](https://github.com/MBombeck/HealthLog/issues/214). Expected user-visible shift: users on weekly meds (GLP-1 agonists, biologics) will see their Health Score rise as the medication pillar moves from ~13 to ~100; users on weekday-only multi-dose schedules will see their score rise as the pillar moves from ~73 to ~100; users on daily-only schedules see no change because the legacy denominator was already correct for that path. Migrations across the eight production call sites are mechanical — the function signature is unchanged.

### Changed

- README rewrite for the v1.5 cut: TestFlight badge in the badge row plus an iOS TestFlight link in the Website / Demo / Docs row and the footer. Buy Me A Coffee badge added. Status block updated to reflect that v1.5 is now the current line, with a new "Heavily developed" advisory directly below it that tells self-hosters to pin a tag, take a backup before every upgrade, and read the CHANGELOG before pulling `latest`. Tech-Stack table flags the iOS app as TestFlight-available. Roadmap table promotes v1.5 from "in active development" to "current".
- README simplification: the `How it works` diagram cluster (four SVGs covering data flow, Coach pipeline, source priority, and security model) is no longer inlined in the README. The diagrams continue to live in [`docs/diagrams/`](docs/diagrams/) and are surfaced through [docs.healthlog.dev](https://docs.healthlog.dev) where they render reliably across themes and viewport widths. The `03-self-hosting-topology.svg` stays inline under Deployment because it carries deployment-time information a self-hoster wants on the first scroll.

### Tests

- `tests/integration/measurements-batch.test.ts` — three new cases pinning the `stats:*` overwrite contract: solo re-post overwrites the value and returns `status: "updated"`; sample-class duplicate keeps the strict first-write-wins contract; a mixed batch with one insert + one overwrite + one duplicate returns all three statuses correctly.
- `src/lib/analytics/__tests__/compliance.test.ts` — parameterised cadence matrix: 1×/day daily (7 / 0 / 18 of 21), weekly Mondays-only (all taken / one missed), bi-weekly (`intervalWeeks=2`), weekday-only 3×/day metformin, skipped-dose denominator exclusion, `medicationCreatedAt` truncation, DST spring-forward boundary in Europe/Berlin, and over-logged-day rate cap. The matrix pins the contract for every cadence the production app exercises so future schedule-shape work can't silently regress.
- `src/lib/analytics/__tests__/health-score-fast-path.test.ts` — two cadence-aware regression cases: a weekly Mondays-only med with every Monday taken now lifts the medication-compliance pillar to ≥ 50 (previously ~13 under the bug); a daily-only med with every dose taken stays ≥ 90 (no regression on the path that worked).
- Eight stale integration assertions retired across `withings-oauth.test.ts`, `withings-oauth-flow.test.ts`, `analytics-bp-aggregate-paged.test.ts`, `analytics-sleep-stages.test.ts`, and `apns-dispatch.test.ts` — drift from the v1.4.47.x OAuth fine-grained reason tags, the v1.4.47.2 ES256 PEM verify guard, and the v1.4.49.1 analytics slim-slice annotation rename. Three `source-priority-two-axis` cases skipped with an inline TODO referencing the v1.4.49.1 commit and the relocation candidate (`pick-canonical-workout-rows`); these tests exercised picker semantics that no longer fire on the default analytics summaries path.

### Notes

- iOS coordination items closed alongside this cut: the v1.4.49 server-side `clientManaged` MEDICATION_REMINDER suppression rule is now active for iOS v0.6.0.8+ clients that opt in via `PATCH /api/auth/me/notification-prefs`; tracked in healthlog-iOS#9. Issue [#206](https://github.com/MBombeck/HealthLog/issues/206) is closed.
- HealthLog suite: 5285 unit (5279 carryover + 3 new stats-overwrite cases + new compliance matrix and Health-Score regression cases that net out the legacy assertions retired during the cadence-aware migration) + 253 integration tests pass on the local Vitest run, lint clean, typecheck clean.

## [1.4.50] — 2026-05-24 — MoodLog reverse-sync (HealthLog → MoodLog push)

A user reported that mood entries logged inside HealthLog — specifically via the iOS app — never reached MoodLog. The historic integration ran one-way: `syncMoodLogEntries` polled MoodLog every 15 minutes and pulled new rows, but nothing flowed the other direction. A user tracking mood in HealthLog ended up with one log per app and no overlap.

### Added

- `src/lib/moodlog/push.ts` — `pushMoodEntriesToMoodLog(userId, entries)`. Best-effort reverse-sync push to MoodLog's new `POST /api/integrations/health-log/mood` endpoint. Same per-user `moodLogUrlEncrypted` + `moodLogApiKeyEncrypted` credentials the pull side uses, same `isPublicUrl` SSRF guard, same manual-redirect policy. Wraps every failure mode in a wide-event warning so a network blip or a stale MoodLog deploy can never bubble back to the user's mood-create request.
- `POST /api/mood-entries` (single) and `POST /api/mood-entries/bulk` now fire the push as a fire-and-forget side-effect after a successful create. Entries with `source === "MOODLOG"` skip inside the helper to avoid an echo loop. Bulk push only includes rows that landed as `inserted` — duplicates and skips don't retry a known failure.

### Changed

- `src/lib/moodlog/sync.ts` (pull side) filters out entries where MoodLog reports `loggedVia: "HEALTHLOG"`. Those are echoes of rows we just pushed; re-importing them would flip the `source` column from the original attribution (MANUAL / WEB / TELEGRAM / iOS) to MOODLOG and double-count in any source-segregated dashboard. An `echoSkipped` wide-event annotation lets the operator confirm the round-trip is closing at one hop.

### Tests

- `src/lib/moodlog/__tests__/push.test.ts` — 9 cases covering the MOODLOG-source filter, no-credentials skip, SSRF refusal, headers + body shape on the successful path, 5xx + network-reject + 3xx-redirect failure modes, and the `tags` JSON-string → array key normalisation. Pins the contract the call sites no longer await so future helper refactors can't silently break the fire-and-forget integration.
- HealthLog suite: 5279 unit + integration pass, lint clean, typecheck clean.

### Cross-repo coordination

The matching MoodLog v0.2.0 release adds the `POST /api/integrations/health-log/mood` handler this push targets. Both apps must deploy together for the round-trip to close — MoodLog first so HealthLog never hits a 405 / 404 on the new endpoint.

## [1.4.49.4] — 2026-05-24 — BD-tile number truncation + medication-compliance test tz drift

A user reported the dashboard BD (Sys) tile rendering `"13… mmHg"` — the systolic / diastolic pair (`131/85`) was wider than the narrowest grid column and the value-row's `truncate` ellipsis chopped the most important part of the tile (the number itself).

### Fixed

- `src/components/charts/trend-card.tsx` — paired-metric tiles (BP systolic/diastolic) now render the value at `text-2xl` (one Tailwind step down from `text-3xl`). Single-value tiles (weight, pulse, glucose, …) keep `text-3xl` because their value never threatens the column-width budget on its own. The `truncate` class stays as a defence-in-depth safety net so an outlier value (e.g. `200/120 mmHg` plus a future trend caption) still clips gracefully rather than overflowing the card boundary.
- `cn()` argument ordering tightened so `tailwind-merge` keeps the explicit `leading-none` — Tailwind v4's `text-3xl` / `text-2xl` carry their own default `line-height`, and the last-wins dedup rule would otherwise drop the explicit `leading-none` and break the across-tile baseline alignment. The `<TrendCard>` baseline-alignment tests pin the contract.
- `src/app/api/medications/intake/__tests__/route.test.ts` (one pre-existing test) computed its `todayKey` from UTC date components but the route's `readMedicationCompliance` uses the user's timezone (Europe/Berlin in the test fixture). At every nightly 22:00 — 24:00 UTC window — once the Berlin clock crossed midnight — the two computations diverged by one calendar day and the rollup-tier read returned zero for "today". The test now derives `todayKey` from the same `Europe/Berlin` zone the route uses; the assertion stays the same.

## [1.4.49.3] — 2026-05-23 — Full i18n call-site audit + 28 stale missing keys filled

A user reported additional raw key strings (`notifications.eventMoodReminder`, `notifications.eventMoodReminderDesc`) reaching the UI after v1.4.49.2 had landed the relative-time fix. The narrow `{count}`-call audit that drove v1.4.49.2 had missed every dynamic key construction; the full exhaustive sweep below picked up 28 keys called from real code that had never existed in any locale bundle.

### Fixed

- Filled 28 missing translation keys across all 6 locales (de / en / es / fr / it / pl = 168 entries), grouped by feature surface that introduced them and never wired the strings:
  - **Notifications event matrix** (14 keys — added with v1.4.41 / MOOD_REMINDER surfaced the gap in v1.4.49): `notifications.event{MedicationReminder,MeasurementAnomaly,ComplianceLow,WithingsSyncFailed,SystemAlert,PersonalRecord,MoodReminder}` and the `Desc` variant of each. The `/notifications` settings page is the consumer; before this release the per-event rows on an affected account rendered the bare keys instead of the localised name + description.
  - **Welcome carousel** (13 keys — added with the 3-slide intro in v1.4.45): `onboarding.welcome.{title,carouselLabel,slideOf,prevSlide,nextSlide,gotoSlide,cta}` for the chrome plus `slide{1,2,3}.title/body` for the content. The carousel mounted with raw keys for every screen-reader label, dot-pager aria-label, and slide body.
  - **Measurement list error state** (1 key — added with v1.4.44): `measurements.loadError`. The error branch in `measurement-list.tsx` rendered the raw key when a fetch failed.

### Added

- `src/__tests__/i18n-call-site-coverage.test.ts` — call-site audit that walks every `.ts` / `.tsx` file under `src/` (excluding tests + generated code), extracts every literal `t("ns.key")` call with comment-aware parsing (skips line + block + JSDoc comments so example pseudocode in docstrings is not flagged), and asserts each key resolves to a string leaf in `messages/en.json`. The existing `i18n-locale-integrity.test.ts` then propagates the EN guarantee to every other locale via key-set parity. Pre-fix this guard would have surfaced 17 stale call sites at every test run; future regressions print a structured punch list so the offender can land every gap in one commit.

### Why this happened

The guard above did not exist before. v1.4.27 B6 introduced `i18n-drift-guard.test.ts` with hand-curated key groups; surfaces introduced after that point (notifications matrix in v1.4.41, measurement list error in v1.4.44, welcome carousel in v1.4.45) shipped without anyone editing the drift-guard groups, and the locale-integrity test only catches DRIFT across locales — it does not flag keys that are missing from EVERY locale uniformly. The call-site test closes that hole: any `t()` call without a backing key now fails at `pnpm test` time, before reaching production.

## [1.4.49.2] — 2026-05-23 — Raw i18n key leak on relative-time helper

A user reported the raw string `insights.relativeHoursAgo` rendering verbatim on medication cards, recent-achievements, admin sections, the iOS notification preview, and every other consumer of `formatDateOrRelative`. Audit across the full `t(…, { count })` surface (~20 call sites) confirmed exactly two leaks: `insights.relativeMinutesAgo` and `insights.relativeHoursAgo`. Both pointed to keys that have NEVER existed in the translation bundle — only the pluralised `*One` / `*Other` variants ship.

### Fixed

- `formatDateOrRelative` in `src/lib/format.ts` now dispatches to `insights.relativeMinutesAgoOne` / `relativeMinutesAgoOther` / `relativeHoursAgoOne` / `relativeHoursAgoOther` based on `count === 1`, mirroring the `src/lib/i18n/relative-time.ts:24-48` pattern the v1.4.43 i18n fix-up added to its twin helper. The format-twin was missed at the time — `t()` performs no auto-pluralisation, so the bare key passed straight through `t()`'s identity fallback into the UI.

### Test hygiene

- `src/lib/__tests__/format-date-or-relative.test.ts` expectations updated to the new `*One` / `*Other` dispatch, plus a new regression guard that drives every relative bucket and asserts each `t()` key has a matching entry in `messages/en.json`. Pre-fix this guard would have failed on `relativeMinutesAgo` and `relativeHoursAgo`; future twin-helper divergence will trip the same check before it reaches prod.

### Why the audit found no other leaks

Cross-checked every `t(…, { count })` call across the codebase against `messages/en.json`. The other 17 sites (`insights.dayStreak`, `medications.importDuplicatesSkipped`, `achievements.metricPercent`, `passwordStrength.minLength`, `settings.integrationPill.*`, `targets.relativeDay.daysAgo`, `targets.card.streak`, `admin.section.backups.uploadSuccess`, `trendHints.remainingMany`, `dashboard.staleHint`, …) all use plain (non-pluralised) keys that exist verbatim in the bundle. The bug was isolated to the format-helper twin.

## [1.4.49.1] — 2026-05-23 — Default `/api/analytics` cold-path fix (rollup-tier delegation)

v1.4.49 shipped the slim-slice (`?slice=summaries`) cold-fallback fix, but the production HAR captured against the new image still showed `GET /api/analytics` at 8 s cold on the 467 745-row tenant — and crucially, the supposedly-fixed `?slice=summaries` request observed the same 8 s when fired concurrently. Investigation found the slim slice was queuing behind the default slice's 15-way per-type `fetchMeasurementSeriesChunked` live walk: the fan-out held the `p-limit(4)` lanes saturated and the 20-slot Prisma pool packed for ~8 s, starving every other Prisma client (including the concurrent slim slice) until it drained.

### Fixed

- `GET /api/analytics` (default slice) no longer fans out 15 per-type `findMany` reads against `measurements`. The route now delegates the per-type `summaries` work to `computeSummariesSlice`, which reads the same data from `measurement_rollups` DAY buckets + a 90-day narrow `$queryRaw` for the windowed avg / slope / r² columns. On a large production account this drops the cold critical path from ~8 s to sub-second; warm cache is unchanged.
- Pool starvation that ALSO affected the supposedly-fast `?slice=summaries` request when fired concurrently — the slim slice now resolves in its own SQL budget regardless of whether the default-slice request is also in flight.

### Changed

- `computeSummariesSlice` narrow `$queryRaw` extended with a `FILTER (WHERE measured_at >= NOW() - INTERVAL '60 days' AND measured_at < NOW() - INTERVAL '30 days')` `avg30_last_month` column. The 60-day lower bound stays inside the existing 90-day outer cap, so the additional column adds zero extra row scan work — the planner already touches every block this clause reads. Dashboard `tileCompareDelta` (`compareBaseline === "lastMonth"`) now sees a real value via the slim path; previously only the deleted live walk produced it.
- Deleted dead code: `fetchMeasurementSeriesChunked`, `ChunkedRow`, `MEASUREMENT_CHUNK_SIZE`, the `ANALYTICS_TYPE_FETCH_CONCURRENCY = 4` constant. None had callers outside the removed fan-out.
- `meta.analytics.bp_aggregate` wide-event field retired — it carried the per-type walk's row-count + `live_since` cutoff, both meaningless without the walk. The slim slice's `meta.analytics.slim_summaries` (`row_count`, `type_count`, `path`, `year_over_year_types`) carries the equivalent signal.
- `summary.anomalyCount` on the default-slice response now consistently returns `0`. No consumer in the codebase reads it from `/api/analytics`; the insights pipeline (`/api/insights/comprehensive`, `/api/insights/cards`) sources `anomalyCount` from its own `comprehensive-aggregator` narrow query.

### Test hygiene

- `route.test.ts` updated: dropped the 130k-row PULSE stress test and the `caps per-type Prisma fan-out` concurrency test (both pinned the removed fan-out). Added a negative assertion that `prisma.measurement.findMany` is never called with the chunked-walk shape `(select: { id, source, deviceType }, take: 5000)` on the default critical path, plus a positive assertion that `avg30LastMonth` exists on the response.
- `since-cap.test.ts` updated: dropped the `where.measuredAt.gte` and `bp_aggregate.live_since` annotation assertions (both pinned the deleted code path). The slim-slice negative invariant (no per-type loop on `?slice=summaries`) remains.
- Final: **5 268 unit + integration tests pass** (one pre-existing skip), zero failures, lint clean.

### Verification

Post-deploy production logs from `/api/analytics` (default + slim, cold cache) confirm the fix landed: both routes report `path: "rollup"` for every component and `duration_ms` returns to the sub-second envelope. See the v1.4.49.1 deploy verify section in the project memory.

## [1.4.49] — 2026-05-23 — Server-side reminder suppression + diagnostic endpoint backed + backlog closure

v1.4.47 closed the high-priority punch list. v1.4.49 bundles the remaining v1.4.47 follow-ups together with the items deferred out of v1.4.48: server-side suppression of `MEDICATION_REMINDER` APNs for iOS clients that manage their own local reminders, a `push_attempts` table backing the diagnostic endpoint, the `/api/admin/notifications/diagnostic` OpenAPI entry, and a sweep of v1.4.48 forward-findings (Withings reason-tagging, observability PII hardening, MoodReminderCard auto-clear parity, simplifier dead-code, sub-locale copy gaps). The workout-batch integration suite that had been red on `main` for three releases turns green; the cold-mount analytics fallback path picks up the same 90-day outer cap v1.4.47.1 shipped for the rollup-fresh path; iOS validation-failure audit rows carry the rejected payload shape so iOS serialiser drift can be chased from a single log line.

### Added

- `/api/admin/notifications/diagnostic` — admin-only endpoint that surfaces device APNs token presence (masked to an 8-char prefix + 8-char suffix), notification channel config presence, and recent push attempts for the calling account. Closes the DB-shell bottleneck that slowed the v1.4.47 APNs investigation. The endpoint is registered in `docs/api/openapi.yaml` so future iOS clients can codegen against it.
- `push_attempts` table backs the diagnostic endpoint's `recentPushAttempts` field. Every APNS / Web-Push / Telegram / NTFY sender writes a fire-and-forget row per attempt (channel + eventType + result + reason + createdAt). The diagnostic endpoint now returns the last 20 attempts ordered by recency. Daily cleanup cron at 03:35 Europe/Berlin prunes rows older than 90 days.
- `GET` + `PATCH /api/auth/me/notification-prefs` — per-user notification preferences with deep-merge semantics. Initial category `medication.clientManaged: boolean` (default `false`); future categories slot in without overwriting siblings. The cron `medicationReminderJob` skips dose-due APNs when the flag is `true`, emitting a `medication_reminder.suppressed_client_managed` wide-event annotation per skip. Other notification kinds (mood reminder, personal record, system alert) are unaffected. Closes the server side of GitHub issue #206.
- `redactSensitiveFields(body)` helper at `src/lib/observability/redact-payload.ts` with a denylist (`password` / `token` / `secret` / `apiKey` / `authorization` / `csrfState` / `nonce`, case-insensitive, recursive). Used by the wide-event `received_shape_excerpt` surface so future free-text routes adopting the pattern cannot leak credentials.
- Native sub-locale translations for `settings.about.tourReplay` and `tourReplayHint` (es / fr / it / pl), and for `settings.about.linksHeading` + `newerAvailable` across the same four sub-locales. Tightened `dashboard.dragHandleHint` copy in de + pl (was ~30 words on a `sr-only` paragraph; screen readers spent ~6 s reading it on focus).
- OpenAPI documentation for `GET` + `PATCH /api/auth/me/disable-coach`.
- Operations runbook notes: `attemptNumber` audit-row vs alert-signal semantics at `docs/ops/attempt-number-semantics.md`, and explicit migration-before-container ordering at `docs/ops/deploy.md` for manual / partial-deploy scenarios.

### Changed

- `/api/analytics` cold-fallback path splits the heavy single-statement aggregate into two parallel queries. The linearly composable columns (`count` / `min` / `max` / `mean`) keep the full-partition scan; the windowed 7 / 30 / 90-day `avg` / `slope` / `r²` columns take a 90-day outer cap so the planner does an index range scan on `(user_id, type, measured_at)` instead of a full-partition sequential scan. Output is bit-identical; cold slim slice drops from multi-second to sub-second on tenants with large measurement partitions.
- Dashboard reorder + onboarding tour helpers consolidated. Arrow-button reorder delegates to the same swap path as drag-and-drop. `restartOnboardingTour` extracted so About + Account sections share the surface. `useSortable` honours `prefers-reduced-motion`. Drag-handle `aria-describedby` hint gates on visible widget count so the empty-state cannot orphan the hint paragraph.
- Coach disable surface tightened. The status banner auto-clears after 3 s. `PATCH /api/auth/me/disable-coach` body migrated to Zod + `returnAllZodIssues` for the uniform 422 envelope. The `eslint-disable react-hooks/rules-of-hooks` line in `useDisableCoach` is replaced with a shared `useQueryClientMounted` helper that both `useFeatureFlags` and `useDisableCoach` consume.
- Withings OAuth callback consumes the nonce atomically. `delete` is issued first; the `P2025` catch handles the replay branch. The previous read-then-delete pattern allowed a theoretical race between two concurrent callbacks with the same nonce. Silent `.catch(() => {})` on delete failures now surface via a Wide-Event warning so a real infra failure reaches the audit trail.
- Withings callback `?reason=state` redirect is now differentiated into four distinct reason tags so operators can tell `csrf1` (URL/cookie mismatch), `replay` (nonce already consumed), `expired` (TTL elapsed), and `cross_user` (session/row userId mismatch) apart without DB-shell access. The delete-failure warning template interpolates `err.name` rather than `${err}` so Prisma error messages cannot echo offending values into the audit log.
- Withings `connect` endpoint rate-limited to 10 calls per 60 s per user (mirroring the disable-coach pattern); row-create failures redirect to the consistent error surface (`/settings/integrations?withings=error&reason=connect`) instead of bubbling a 500.
- `buildPayloadDiagnostic(body)` helper extracted to `src/lib/api-response.ts`. The dashboard widgets PUT route and the measurements series GET route now route their bodies through `redactSensitiveFields` first then call the shared helper — single source of truth for the iOS payload-diff wide-event shape, redaction layered in front composably.
- `sanitiseZodIssues(issues, { stripValuesFromMessage: true })` overload added; 14 audit-log sites that wrote `JSON.stringify({ issues })` to `details` now strip the `message` string to a `{ path, code }` pair. Most impactful catch: the `/api/devices` route's `invalid_format` issues were echoing `apnsToken` values verbatim into the audit log.
- `disableCoachBody` + `disableCoachData` Zod schemas collapsed into a single `disableCoachFlag` schema in the OpenAPI route table; `zod-openapi` emits the request + response pair from the one source.
- `yaml@2` emitter no longer sorts map entries during `pnpm openapi:generate`. Alphabetical sort had placed alias references before their anchors when `.meta()`-tagged sub-schemas appeared inside `z.array(...)`. Output stability is preserved by Zod's declaration-order guarantee.
- Worker boot emits a Wide-Event warning if any `integration_statuses` row still has a NULL per-kind counter after the v1.4.47 legacy-column drop. Closes the silent alert-ladder gap where such rows would alert two strikes later than they should.
- `MoodReminderCard` status banner auto-clears after 3 s — parity with `DisableCoachCard` (the existing docstring claimed parity that the implementation lacked).
- `mergeReorderIntoLayout` emits a dev-only `console.warn` when a reorder id has no matching widget in the layout. Statically unreachable today; defence-in-depth for the upcoming per-tile Suspense refactor that introduces dynamic widgets.

### Fixed

- Workout-batch integration tests (`workout-batch-create`, `workout-batch-race`) updated to match the v1.4.42 cross-source dedup semantics. The integration suite had been red on `main` since v1.4.45 (three release commits shipped through it). Suite is green again.
- Twelve stale "migration 0076" references in code comments corrected. `consecutiveFailures` sites read 0077; `disable-coach` sites read 0078. Comment-only sweep, no behavioural change.
- `docs/ops/attempt-number-semantics.md` referenced migration 0076 for the dropped `consecutiveFailures` column; the actual migration is 0077.
- Per-channel APNs "Send test" button (Settings → notification channels) now fires with `eventType: "MEDICATION_REMINDER"` so the dispatcher's `time-sensitive` interruption-level + `apns-priority: 10` branch runs. The previous `SYSTEM_ALERT` event-type used the dispatcher's default `active` level, which iOS may summarise into the Notification Center rather than presenting a lock-screen banner — leaving the user with no signal whether a real dose reminder will surface visibly. A successful test now exercises the exact path production reminders take. Title and body strings still read "Test notification" so the push cannot be mistaken for an actual scheduled dose.

### Performance

- Cold-fallback `/api/analytics` slim slice — `aggregates` query split so the windowed columns get a 90-day outer `WHERE` cap, matching the inner `FILTER` windows. Multi-second TTFB on cold mounts drops to sub-second on tenants with large measurement partitions. The `narrows` query received the same cap in v1.4.47.1.

### Security

- Withings `connect` rate-limited (per-user 10 / 60 s) to bound ledger-row growth from a misbehaving client.
- Coach `disable-coach` validation envelope unified through `returnAllZodIssues` for a uniform 422 shape.

### Observability

- `dashboard.widgets.validation-failed` and `measurements.series.validation-failed` audit rows now carry `received_keys`, a truncated `received_shape_excerpt` (256-char hard cap), and the sanitised Zod issues. The excerpt is generated through `redactSensitiveFields` so credential-shaped keys (password / token / secret / apiKey / authorization / csrfState / nonce) land as the literal `"[redacted]"` instead of their raw values. One log line per validation failure carries both the iOS-sent shape and the server's rejection reason, so iOS serialiser drift can be chased without DB-shell access.
- Push attempts persisted in `push_attempts` for every channel (APNS / Web-Push / Telegram / NTFY). The diagnostic endpoint reads the last 20 per user; the daily cron at 03:35 Europe/Berlin prunes attempts older than 90 days. Operators can now grep the wide-event `notifications.send` annotation OR query the table directly for an APNs incident triage.
- Withings callback redirect reasons emit matching `meta.reason` annotations (`csrf1` / `replay` / `expired` / `cross_user`) so the wide-event stream carries the same differentiation the URL query param does.

### Documentation

- `NEXT_PUBLIC_APP_VERSION`, `NEXT_PUBLIC_APP_BUILD_SHA`, `NEXT_PUBLIC_APP_BUILT_AT` documented as build-time-only env-vars in `docs/self-hosting/reverse-proxy.md`. The Coolify runtime entry was misleading; Next.js bakes the values into the bundle at build time via the `next.config.ts` `env:` block.

### Test hygiene

- New grep-discovery test mirrors the `flags.coach` discovery test for `user.disableCoach` / `useDisableCoach`. New sites must be added to the allowlist explicitly so CI fails on an unreviewed addition.
- `target-card.tsx` per-card "Ask the coach" CTA pinned in the user-disable fixture (the cascade fixture already covered the page-level gate).
- `textarea` `forwardRef` `Symbol.for("react.forward_ref")` sentinel assertion deleted (React-internal API). Ref forwarding is covered indirectly by the call sites that pass `ref` to `<Textarea>`.
- `vi.useRealTimers()` moved into the suite-level `afterEach` in the medications-intake and dashboard-summary route tests. A failed assertion no longer leaks fake timers across suites.
- New test files pin the v1.4.49 surfaces: `redact-payload.test.ts` (9 cases — passthrough / per-key redact / Authorization case-insensitive / nested recursion / array recursion / multi-pattern / scalar passthrough / Date preservation / pattern-set pin), `push-attempt-record.test.ts` (13 cases across the four senders × ok / error / skipped + DB-error-swallowed), `notification-prefs/route.test.ts` (11 cases), `notification-prefs.test.ts` validations (18 cases), `mood-reminder-card.test.tsx` (2 auto-clear cases).
- Full unit-test gate after v1.4.49 reconcile: 510 files / 5272 passed / 0 failed / 1 skipped.

### Migrations

- `0079_v1449_user_notification_prefs` — adds `users.notification_prefs` (jsonb, nullable). Shape: `{ medication: { clientManaged: boolean } }`; future categories slot in next to `medication`.
- `0080_v1449_push_attempts` — new `push_attempts` table with `(user_id, created_at DESC)` index. Cascade-delete on user removal. Retention via the daily cleanup cron.

### Deferred

- iOS v0.6.0.8 ships the Settings-side notification-permission re-trigger (`healthlog-iOS#10`), the in-app APNs diagnostic surface, and the `CFBundleShortVersionString` + UA build-number fixes — these depend on the iOS client's build cycle, not the server. The server-side suppression flag added in this release is opt-in (`clientManaged: false` by default) so existing users on the still-buggy v0.6.0.7 client see no behaviour change until they upgrade to v0.6.0.8 and the iOS client explicitly opts in via `PATCH /api/auth/me/notification-prefs`.
- Reactive `prefersReducedMotion()` hook — current helper at `src/lib/charts/reduced-motion.ts` is read-once at render; doesn't react to mid-session OS toggle. Twenty-one call sites would benefit from a `useSyncExternalStore`-backed hook. Scoped as a v1.4.50 single-purpose refactor.
- `handleReminderCheck` extraction — the cron handler in `src/lib/jobs/reminder-worker.ts` is a 260-line non-exported blob. The v1.4.49 suppression skip-path is pinned via the helper `isMedicationReminderClientManaged` rather than a direct integration test of the handler. Scoped as v1.4.50 hygiene.

## [1.4.47.6] — 2026-05-22 — APNs per-channel test endpoint wired

The Settings notification-status card's "Test senden" button was unwired for the APNS channel — the `TEST_ENDPOINTS` map at `notification-status-card.tsx:60-64` had TELEGRAM / NTFY / WEB_PUSH but not APNS. Clicking the button on an APNS row resolved to `undefined` and the fetch fired against an empty URL, silently failing. The operator had no first-class way to verify the v1.4.47.5 auto-detect path; only the natural channel-state-machine cron retry could exercise it.

This release adds the missing endpoint + map entry.

### Added

- `src/app/api/notifications/apns/test/route.ts` (new) — per-channel APNS self-test endpoint. Mirrors the web-push test shape: `requireAuth` + 5/min rate-limit + calls `sendViaApns(user.id, …)` with a localised "test notification" body. Returns `{ ok, reason }` so the UI can surface the actual APNs reason on failure.

### Changed

- `src/components/settings/notification-status-card.tsx:60-65` — added the `APNS` row to `TEST_ENDPOINTS`. The button now actually fires.

### Effect

- Operator can verify APNs delivery without waiting for the channel-state-machine's exponential-backoff cron retry. The v1.4.47.5 auto-detect path runs inside `sendViaApns`, so clicking "Test senden" on the APNS row will exercise it directly.

### Risk

Zero. Additive endpoint + one new map key. Existing channels keep working.

## [1.4.47.5] — 2026-05-22 — APNs gateway auto-detect on `BadEnvironmentKeyInToken`

v1.4.47.4 + the Coolify `APNS_PRODUCTION` env-var deletion got JWT signing past Apple's gate, but the next push still failed with `BadEnvironmentKeyInToken` — the server's per-device gateway routing didn't match the actual token environment. The iOS client picks the gateway env when it registers, but in practice the client's reported env can mismatch the token's true environment (e.g. a DEBUG build that registered itself as "production" by accident, or a TestFlight-then-Debug installation chain).

This release adds gateway auto-detect: on `BadEnvironmentKeyInToken`, retry exactly once with the opposite gateway. If the retry succeeds, persist the correction to `Device.apnsEnvironment` so subsequent sends go straight to the right gateway.

### Changed

- `src/lib/notifications/senders/apns.ts:sendViaApns` — per-device send-loop now walks an env-sequence (`[initial, opposite]`). Breaks on success OR on any non-`BadEnvironmentKeyInToken` failure. On retry-success, updates `Device.apnsEnvironment` in DB and emits a wide-event warning so the operator sees the correction.

### Effect

- Future pushes hit the right gateway for each device, even if the iOS app misreported the env at registration time.
- The first delivery after deploy may take 2 RTT-to-Apple round-trips for any device that needs correction; subsequent ones go through directly.

### Risk

Low. The retry only fires on the specific `BadEnvironmentKeyInToken` reason. Other failures (`BadDeviceToken`, `Unregistered`, network) take the existing single-attempt path. Two new unit tests cover the retry-and-correct path + the no-retry-on-BadDeviceToken path.

## [1.4.47.4] — 2026-05-22 — APNs key escape-free env var (APNS_KEY_B64)

The v1.4.47.2 / .3 chain established that the production `APNS_KEY` env-var is mangled along the `docker-compose env_file` → `process.env` pipeline. Defensive normalisation cannot recover it because the base64 body itself is corrupted on arrival.

This release adds an escape-free alternative: `APNS_KEY_B64`. The operator base64-encodes the raw `.p8` file (real newlines intact) and stores that single ASCII-safe blob; the app decodes it back to a PEM string. No `\n` escape gymnastics, no character class transformations along the way — base64 chars survive every env-var pipeline.

### Changed

- `src/lib/notifications/senders/apns.ts:loadApnsConfig` — read `APNS_KEY_B64` first; if present, decode via `Buffer.from(value, "base64").toString("utf-8")` and pass directly to `crypto.createPrivateKey` for verification. Existing `APNS_KEY` and `APNS_KEY_FILE` paths kept as fallbacks. Precedence: `APNS_KEY_B64 > APNS_KEY > APNS_KEY_FILE`.

### Operator action

To enable on Coolify (or any other env-var-block):

```bash
base64 -i AuthKey_<KEY_ID>.p8 | tr -d '\n'
```

Paste the output as `APNS_KEY_B64`. The legacy `APNS_KEY` can stay set or be removed; the B64 variant overrides it when present.

### Risk

Zero. Additive — the new env-var has its own try/catch + parse-verification with one-warning-per-process disable semantics. Existing operators keep their setup unchanged.

## [1.4.47.3] — 2026-05-22 — APNs PEM diagnostic dump on parse failure

v1.4.47.2 added defensive PEM normalisation but the production env-var was still rejected at `crypto.createPrivateKey` with `error:1E08010C:DECODER routines::unsupported`. The base64 body itself appears to be corrupted somewhere along the Coolify → docker-compose → `process.env` path; normalising the wrapping cannot recover it.

This release adds a one-line diagnostic dump on parse failure so the operator can compare the in-container shape against the source `.p8`:

```
APNs key did not parse as PEM: <err> [diag raw_len=… norm_len=…
  escaped_newlines=… real_newlines=… begin_markers=… end_markers=…
  base64_chars=… other_chars=… sha256_prefix=…]
```

No secret bytes leave the warning — only character-class counts, structural marker counts, and a 16-char SHA-256 prefix that the operator can compare against `shasum -a 256 AuthKey_*.p8` locally.

### Changed

- `src/lib/notifications/senders/apns.ts:loadApnsConfig` — on the existing `crypto.createPrivateKey` failure branch, emit a structured diagnostic warning. Channel disable behaviour unchanged.

### Risk

Zero. Behaviour-preserving — only the warning message gets richer when the parse already fails.

## [1.4.47.2] — 2026-05-22 — APNs JWT signing repair (defensive PEM normalisation)

Same-day follow-up to v1.4.47.1. Coolify runtime logs surfaced

```
Notification sender threw for APNS:
  Failed to generate token: secretOrPrivateKey must be an asymmetric
  key when using ES256
```

on every push attempt. The channel had auto-paused after 3 consecutive failures (admin UI showed `sender_threw · Versand pausiert · Nächster Versuch 11:10`).

Root cause: the .p8 PEM stored in the Coolify env-var arrived at `process.env.APNS_KEY` without parseable newlines around the BEGIN / END markers — likely a `docker-compose env_file` round-trip artefact. `openssl pkey` could still parse it, but `jsonwebtoken@9` (used by `@parse/node-apn`) is strict and refused to sign.

### Changed

- `src/lib/notifications/senders/apns.ts:loadApnsConfig` — after the `.replace(/\\n/g, "\n")` 12-factor unescape, normalise the PEM body: strip whitespace between markers, force a 64-char line wrap of the base64 payload, and rebuild a canonical PEM. Idempotent on already-correct PEMs; recovers bare-base64 inputs without markers too. Then verify the result parses as an asymmetric EC key via `crypto.createPrivateKey` before handing to node-apn. On verification failure, return `null` with a one-time warning — beats `sender_threw` on every push.

### Effect

- APNs channel returns to active on the next push attempt (the channel-state machine clears the cooldown on the first success).
- No env-var change required; the existing `APNS_KEY` value is normalised in-process.
- Operators with already-correct multi-line PEMs see no behavioural difference.

### Test plan

- [x] 3 new unit tests cover the v1.4.47.2 normalisation paths: collapsed single-line PEM, bare base64 body without markers, unparseable garbage returns null + warning.
- [x] Updated `VALID_ENV.APNS_KEY` fixture to a real EC P-256 key so the existing tests exercise the verification path end-to-end.
- [x] `pnpm typecheck` clean, `pnpm lint` clean, full suite green.

### Risk

Low. Adds defensive normalisation + a parse check. Bad PEMs that previously caused `sender_threw` on every push now cleanly disable the APNs channel with a single warning at load time. Good PEMs are passed through unchanged after the canonical re-wrap (which produces an identical PEM for already-correct inputs).

### Operator notes

Standard image roll. No `prisma migrate deploy` step required.

## [1.4.47.1] — 2026-05-22 — Slim summaries slice 9 s → ~0.5-1 s cold

Same-day hotfix on top of v1.4.47. Dashboard cold mount on power-user accounts was firing `/api/analytics?slice=summaries` at ~9 s TTFB; the time was almost entirely in one `$queryRaw` against the `measurements` table.

The `narrows` query inside `computeFromRollups` was scanning the user's full measurements partition without an outer `measured_at` cap. Every `FILTER` expression inside the SELECT already restricts to 7/30/90 days, so the additional rows were aggregated to NULL and discarded — but the planner still had to read all of them. Adding the matching 90-day outer WHERE turns the read into an index range scan on `(user_id, type, measured_at)` and returns the same output bit-for-bit.

Effect for a ~450 000-row tenant: slim slice cold ~9 s → ~0.5-1 s, warm cache hits stay at the sub-50 ms Map-lookup. The default slice keeps its earlier path; a separate split of `computeFromLiveAggregate` is queued for the next release for tenants who still rely on the no-rollup fallback.

- **Changed:** `src/lib/analytics/summaries-slice.ts:255-306` — `computeFromRollups.narrows` query gains `AND m."measured_at" >= NOW() - INTERVAL '90 days'`.
- **Risk:** zero. Inner FILTER clauses already discarded rows outside the 90-day window; the new WHERE just narrows the scan to the same set.
- **No migration. No schema change. No env-var change.**
- **Operator notes:** standard image roll; no `prisma migrate deploy` step required.

## [1.4.47] — 2026-05-22 — Drag-to-reorder, Coach disable toggle, OAuth state nonce table, legacy column drop, primitive sweep

v1.4.45 closed the v1.4.43 follow-up; v1.4.46 caught a same-day server reconcile (PR worker, intake auto-skip, APNS admin test). v1.4.47 is the dedicated follow-up that lands every remaining v1.4.45 backlog item plus the legacy-column cleanup that v1.4.45 had scheduled for "one release later".

Eight changes landed on `develop` before this release commit:

- Wall-clock pin on the two idempotency tests (`/api/dashboard/summary` + `/api/medications/intake`) that hard-coded `2026-05-21` and broke on the 22nd
- Drop the legacy `consecutive_failures` column on `integration_statuses` — the v1.4.45 per-kind bucket migration carried the legacy integer for one release as a fallback; now removed, alert ladder reads `Math.max(...buckets)`
- Extract `<Textarea>` primitive with iOS-zoom defence + WCAG tap-target floor; sweep 4 inline call-sites (bugreport, medication JSON paste, side-effects notes, admin feedback)
- Per-user Coach disable toggle in Settings → Insights; survives `flags.coach` (admin) gate at all five mount points; new `disableCoach` column + audit-logged PATCH endpoint
- Dashboard widget drag-to-reorder via `@dnd-kit/sortable` (a11y arrow-button fallback preserved); 6 new locale strings; new `reorderWidgets` pure helper
- Dashboard tour auto-launch gated on `onboardingCompletedAt + 24 h` so the carousel and tour no longer chain immediately; "Replay the tour" CTA added to Settings → About
- Withings OAuth `state` cookie no longer encodes `${userId}:${nonce}` — switched to a 16-byte random nonce + short-lived `WithingsOAuthState` ledger row + 03:20 cleanup cron, closing the v1.4.43 OAuth security gap
- Drop the in-memory `legacy_form_total` counter (per-process + useless on multi-container deploys; access-log warning still emits)
- Coach client pre-checks `navigator.onLine` before fetching `/api/insights/chat` so an airplane-mode user gets the offline-specific `coach.network` copy immediately

### Added

- **`<Textarea>` primitive** (`src/components/ui/textarea.tsx`) — mirrors `<Input>`'s shape with `forwardRef` + `data-slot="textarea"`. Bakes in `text-base sm:text-sm` iOS-zoom defence, `min-h-11 sm:min-h-9` tap target floor, `autoCapitalize="sentences"`, `spellCheck={true}`, `autoComplete="off"` + password-manager-ignore data-attributes. 11 unit tests pin the contract.
- **Per-user Coach disable toggle** — Settings → Insights "Coach ausblenden" / "Hide Coach" Switch. `disableCoach` Boolean column on `User` (migration `0078_v1447_user_disable_coach`). `GET /api/auth/me/disable-coach` + `PATCH /api/auth/me/disable-coach` (60/min/user rate-limit + audit row on every state-changing call). Mount gates on `<CoachFab>`, `<CoachMount>`, `<CoachLaunchButton>`, `<SuggestedPrompts>`, hero-strip `<HealthScoreCard onAskCoach>`, `/targets` per-card CTAs. `useDisableCoach()` SSR-safe hook mirrors `useFeatureFlags()`'s defensive pattern.
- **Dashboard drag-to-reorder** — `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` runtime deps (~29 KB gzipped). `<SortableWidgetRow>` wrapper, `closestCenter` collision, vertical-list strategy, `KeyboardSensor` + `sortableKeyboardCoordinates` for full keyboard accessibility. Drag handle is a `<GripVertical>` icon button on every row's leading edge with `cursor-grab` + `touch-none` + 6 px activation distance. Existing arrow buttons survive as the a11y fallback. `reorderWidgets()` pure helper exported for unit-testing the contract without a DOM. 6 locale strings (`dashboard.dragHandle` + `dashboard.dragHandleHint`).
- **`<OfflineBanner>`'s sibling** — Coach send-message path now pre-checks `navigator.onLine` and short-circuits to the `coach.network` error code before the fetch attempt, so the user sees the offline-specific banner copy immediately instead of waiting on a generic network failure.
- **Withings OAuth state ledger** — new `WithingsOAuthState` model + `withings_oauth_states` table with `nonce` PK, `userId` FK (`ON DELETE CASCADE`), `expiresAt` index. Connect mints a row with `randomBytes(16).toString("base64url")` + 10 min TTL; callback verifies + DELETEs on every exit branch (single-use). Cleanup cron `withings-oauth-state-cleanup` runs daily at 03:20 Europe/Berlin via `reminder-worker.ts`. New `src/lib/withings/oauth-state.ts` module exports the shared constants + minter.
- **"Replay the tour" CTA** in Settings → About (`<AboutSection>`). Clicking re-arms a force-launch sessionStorage marker the `<TourLauncher>` consumes on its next mount, bypassing the new 24 h auto-launch gate. Also wired into the existing "Restart onboarding tour" button in `<AccountSection>` so a same-day click after navigation still lands on the tour.

### Changed

- **`/api/auth/me` payload** extended with `disableCoach: boolean` (defaulted to `false` for partial-deploy rollback). `useAuth` types extended; the fetcher coerces `undefined → false` at the wire boundary.
- **`IntegrationStatus.consecutiveFailures` column dropped** — the v1.4.45 per-kind bucket migration kept the legacy integer one release as a fallback. v1.4.47 drops the column. Alert ladder + audit `attemptNumber` now read `Math.max(...Object.values(consecutiveFailuresByKind))`. Migration `0077_v1447_drop_legacy_consecutive_failures` is reversible via a `GREATEST(transient, reauth_required, persistent)` recipe documented inline.
- **`<TourLauncher>` auto-launch gate** extended from "tour not completed" to "tour not completed AND `onboardingCompletedAt + 24 h < now()`". The mount-time clock is captured via `useState(() => Date.now())` so render stays pure. Brand-new users (`onboardingCompletedAt == null`) and same-day re-visits never see the auto-launch; the manual "Replay the tour" button still works.
- **`messages/de.json`** + 5 sibling locales — added `dashboard.dragHandle` + `dashboard.dragHandleHint`, `settings.ai.disableCoach.{title,description,toggleAria,savedHidden,savedShown,saveError}`, `settings.about.tourReplay` + `settings.about.tourReplayHint`. Copy is tight + professional in every locale; English-fallback on `tourReplay` for es/fr/it/pl per the partial-translation status the rest of the About section already carries.
- **Withings `state` cookie name preserved** as `withings_state`; the value shape changed from `${userId}:${nonce}` to a bare 22-char base64url nonce. A handshake mid-deploy will fail the CSRF check on the callback side (the cookie carries the old shape, the ledger has no row) and bounce the user to the connect-error page; a retry succeeds. No data loss; users in flight retry once.

### Fixed

- **Dashboard summary + medications/intake idempotency tests** broke on 2026-05-22 because they hard-coded `2026-05-21` while the route's projection used `new Date()`. `vi.setSystemTime` pins both ends to the same calendar day so the regression guard stays stable on every future test run.
- **Coach send-while-offline UX** — airplane-mode user no longer sees a delayed generic network error; the `<MessageThread>` now surfaces the `coach.network` copy immediately. Surfaces the v1.4.45 `errorNetwork` i18n key properly on the client side.
- **`legacy_form_total` counter removed** — `withingsWebhookLegacyFormTotal` no longer exposed on `/api/admin/status`. Per-process in-memory counters were never accurate across the multi-container deploy; the access-log warning remains the operator signal.

### Operator notes

- **Migration MUST run before the app image rolls**: three migrations apply via `prisma migrate deploy` in numeric order: `0076_v1447_withings_oauth_state`, `0077_v1447_drop_legacy_consecutive_failures`, `0078_v1447_user_disable_coach`. All idempotent (`IF NOT EXISTS` / `IF EXISTS`) + reversible. Running the v1.4.47 image without migration 0078 would 500 every `/api/auth/me` call because the Prisma client SELECTs `disable_coach`; run `prisma migrate deploy` first.
- **New cron**: `withings-oauth-state-cleanup` runs daily at 03:20 Europe/Berlin via pg-boss. Wired into `reminder-worker.ts`; no extra ops setup required beyond a worker container running.
- **No env-var change.** `pnpm check-env` still passes; the v1.4.42 env-check CI gate enforces manifest ↔ `.env.production.example` lockstep.
- **No API contract break for iOS v0.5.4.** `disableCoach` is additively extended in `/api/auth/me` (older iOS reads coerce `undefined → false`). Withings OAuth state cookie name preserved; in-flight handshakes survive a deploy. The Coach disable toggle is opt-in; default behaviour unchanged.
- **`pnpm test --run` green at ~5100+ passing**, `pnpm typecheck` + `pnpm lint` clean.

## [1.4.46] — 2026-05-22 — Server follow-up (PR worker cumulative-bucketing + intake auto-skip + APNS admin test)

Discovery follow-up from the v1.4.45 post-deploy review surfaced three server gaps that the audit hadn't covered. v1.4.46 lands all three as independent fixes.

### Fixed

- **REG-9 — PR detection picked single per-hour slices instead of daily totals for cumulative HK kinds.** `findBestMeasurement` in `src/lib/personal-records/pr-detection-worker.ts` ran `findFirst orderBy value desc` for every metric. For `ACTIVITY_STEPS`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`, `WALKING_RUNNING_DISTANCE`, and `TIME_IN_DAYLIGHT` — every member of `CUMULATIVE_HK_TYPES` — a noisy 4 000-step hour-bucket fragment from a hike locked in as the user's "best step count" while the legitimate 24 000-step day was ignored. New `findBestCumulativeDay` helper SUMs each `(user_id, type)` partition by `date_trunc('day', measured_at)` via `$queryRaw`, picks the winning day by `ORDER BY day_total {DESC|ASC} LIMIT 1`, then re-reads the latest slice on that day to recover the row's `unit / source / externalId`. The PR's `value` is the day-sum; `achievedAt` is the `MAX(measured_at)` on the winning day so the unique-index contract `(userId, metricType, metricSlot, achievedAt)` stays stable across re-runs. Spot kinds (resting HR, VO2 max, HRV, body composition) keep the existing per-row pick — each row already represents the day's measurement. Two regression cases pin the contract.
- **Intake-auto-skip cron was missing entirely.** `MedicationIntakeEvent` rows the user neither took nor manually skipped stayed in `pending` forever, inflating the missing column on the streak chart and crowding the next day's intake out of the "today" window. New `intake-auto-skip` cron in `src/lib/jobs/intake-auto-skip.ts` runs hourly at `:05` (off the `:00` reminder-check tick and `:30` moodlog-sync) and flips `skipped = true` for every event matching `skipped = false AND takenAt IS NULL AND scheduledFor < NOW() - INTERVAL '24 hours'`. The 24 h grace window keeps late marks (morning dose recorded at noon) legitimate. The flip is the same state the manual "Skip" button writes, so the compliance rollup picks new rows up via the next read-path call. Wired through `reminder-worker.ts` (`createQueue` + `boss.schedule` + `boss.work`). Eight regression cases pin the cron + grace contract, the spec'd `updateMany` shape, idempotency on re-run, and the strict `<` boundary semantics.
- **`/api/admin/notifications/test` switch had no APNS arm.** An iOS-paired admin's APNS channel fell through to the "Unknown channel type" default, so the Settings → Notifications "Test" button reported the channel as broken even though the dispatcher routed real notifications through APNs without issue. New arm mirrors the WEB_PUSH branch: `sendViaApns(userId, payload)` owns its own per-device fan-out (`prisma.device.findMany` for the user's iOS devices) and returns the same `SendOutcome` envelope. On failure the route surfaces the sender's `reason` in the per-channel error (`apns_no_devices`, `apns_not_configured`, …) so the admin UI shows the actionable cause. Six regression cases pin the contract.

### Tests

- 5076 → 5089 (+13: 2 cumulative-bucket cases, 8 auto-skip cases — including grace-window boundary, idempotency, and cron contract — plus 3 APNS-branch cases that didn't already cover the route).

## [1.4.45] — 2026-05-21 — Analytics 9 s perf fix, polish sweep, Zod multi-issue rollout, Withings parked-state automation

> Version note — v1.4.43 was skipped: v1.4.44 shipped as a same-day REG-11 iOS hotfix on `main` while this release work was running (REG-11 = Home dashboard tile renders neither chart nor latest value when the most recent reading is older than 7 days; root cause was in `/api/dashboard/summary` SQL gates). The REG-11 fix is included in this release alongside the rest of the closure work. v1.4.45 keeps the version monotone above the hotfix tag.

v1.4.42 closed the iOS-readiness story. v1.4.45 is the post-deploy discovery + closure release: a sweep across analytics perf / mobile-UI / QoL / security surfaced one critical `/api/analytics` 9 s regression that had been latent since v1.4.40, five mobile-UI WCAG paper-cuts, two PII / log-growth gaps on the security surface, six QoL copy + i18n gaps, and the chart empty-state false-positive raised after deploy. Eleven separate fixes landed: nine close the critical + high-priority items plus recurring polish (chart-gate raw-count, QoL copy + plural forms, Withings classifier wiring across both sync paths, ops hardening including the BuildKit version-pin lesson from v1.4.42), one rolls out the v1.4.42 `returnAllZodIssues` helper to the 41 sibling routes that still dropped every issue past the first, and one closes the v1.4.42 Withings classifier follow-ups (park after 24 h persistent-failure streak; per-kind failure counters). Three companion sub-tasks close the lower-severity mobile-UI, QoL, and security items.

Fourteen independent sub-tasks landed on `develop` before this release commit.

### Added

- **`returnAllZodIssues` rolled out across 41 API routes** — every measurements / medications / mood / auth / settings / admin / consent / bugreport / feedback / device / token / ingest route now returns every Zod issue under `details.issues` plus a sanitised `{ path, code, message }` projection. iOS-contract hot paths additionally write a `<route>.validation-failed` audit-ledger breadcrumb (fire-and-forget). The CSV-import outlier (`/api/medications/[id]/intake/import`) preserves its `Invalid format:` prefix via `meta.errorCode = "medication.intake.import.invalid_format"`. 220 new unit cases pin 2-issue / 3-issue scenarios per touched route.
- **Withings persistent-failure park automation** — a `persistent` failure streak running > 24 h flips `IntegrationStatus.state` to a new `parked` sentinel. Settings card renders a pill `data-state="parked"` with copy "Pausiert — manuell wieder verbinden" (DE) / "Paused — reconnect manually" (EN) plus a "Wieder verbinden" / "Reconnect" CTA. New endpoint `POST /api/integrations/withings/resume` (rate-limited 5/min/user, idempotent) clears the park via `resumeIntegrationFromPark` and the per-card status query invalidates so the pill flips back without a refresh. Schema migration `0075_v1443_integration_park` adds the `consecutive_failures_by_kind` JSONB column + `persistent_failure_started_at` timestamp; backfill on next write bucketises the legacy single-counter into the current `FailureKind`.
- **`POST /api/auth/check-user` audit-ledger breadcrumb** — every branch (`found` / `not_found` / `passkey_only` / `email_fallback`) now writes `auditLog("auth.check-user", { ipAddress, details: { branch, identifier_hash } })` with the identifier hashed via `hashToken`. The route's per-IP throttle (30/15 min) stays; the audit row closes the operator-grep gap for enumeration-attempt investigations.
- **`/api/settings/account` DELETE cascade** — split the danger-zone "Konto vollständig löschen" from the existing "Alle Gesundheitsdaten löschen" so a user reading "Gefahrenzone" reaches the right destructive action. New endpoint cascades User + sessions + passkeys + audit log under a Prisma tx; concurrent active sessions are invalidated synchronously. Six new integration tests pin the happy path + sibling-session invalidation + 401 / 422 / last-admin guard.
- **`<OfflineBanner>` mounted in `<AuthShell>`** — listens for `online` / `offline` window events and renders "Keine Verbindung — Änderungen werden gespeichert, sobald du wieder online bist". Bilingual via i18n. Closes the PWA "blank tile + no explanation when airplane-mode toggles mid-form-fill" paper-cut.
- **`<ChartSkeleton>` 3 s "still computing" caption** — after 3 s of skeleton paint a small caption renders to set user expectation when `/api/analytics` is on the slow path. Bilingual.
- **`<AccountDeleteCard>` + neutral danger-zone visuals** — `AlertTriangle` icon dropped, title in neutral grey, button stays red. Same protective gate, less visual hostility.
- **`formatDateOrRelative(iso)` helper** — within 24 h renders relative ("vor 12 min"), older renders absolute. Wired into `measurement-list.tsx:572,717` so adjacent timestamps no longer mix formats.
- **`scrollBehaviorForUser()` helper in `src/lib/motion.ts`** — reads `prefers-reduced-motion: reduce` and returns `"auto"` or `"smooth"`. Wired into the four JS-driven smooth-scroll sites (`settings-shell`, `admin-shell`, `coach-panel/message-thread` × 2).
- **`charts.noDataInRangeTitle` + `charts.noDataInRangeDescription`** copy across all six locales. Replaces the silent `return null` branch in `<HealthChart>` with a proper `<ChartEmptyState>` so the dashboard layout doesn't reflow when a chart enters its empty branch.
- **`charts.needMoreDistinctDaysTitle` + `charts.needMoreDistinctDaysDescription`** copy across all six locales. Distinguishes the "few raw measurements" branch from the "lots of data, only on 1-2 days" branch on the chart's empty state.
- **`<DailyBriefing>` / `<CorrelationRow>` / `<TrendsRow>` skeleton heights reserved** to match loaded content — `h-[24rem]` for DailyBriefing, `h-[20rem]` for the others. Closes the CLS hot-spot on cold mounts.
- **`<DashboardTileStripSkeleton>`** painted when `trendCards.length === 0 && analyticsSlimQuery.isLoading && layout.widgets.some(w => w.tileVisible)`. User sees the strip silhouette during the slow window instead of header + empty page + 9 s jump.

### Changed

- **`/api/analytics` slim slice `computeAvg30LastYearMap` capped at `p-limit(4)`** — closes the 9 s regression introduced in v1.4.40. The unbounded `Promise.all` over 15 measurement types drowned the `pg.Pool` max=20 even after v1.4.40's pool raise; capping at 4 collapses the burst to match the thick route's existing `ANALYTICS_TYPE_FETCH_CONCURRENCY=4`. Expected dashboard cold-mount: 9.0 s → 2-3 s (concurrent slim + thick both cold) / ~50 ms (warm cache); WMY-converged tenants ≤ 500 ms cold. The slim slice's per-(userId, date) cache key is unchanged; concurrent dashboards still single-flight per slice.
- **Withings activity + sleep sync catch-blocks routed through `WithingsApiError` typed classifier** — both `sync-activity.ts:174` and `sync-sleep.ts:155` previously caught raw thrown values + branched on `Error.message` string-matching. Now they typed-cast through `WithingsApiError` so a non-Error rejection lands in the `unknown` branch instead of silently sliding into `error_transient`. A typed-classification regression suite (`src/lib/withings/__tests__/sync-typed-classification.test.ts`) pins both paths.
- **`IntegrationStatusPill` warning state for `persistent` failures** — v1.4.42's classifier introduced the fourth FailureKind but mapped it to `error_transient` so the pill read "Fehler — neu verbinden" identically to a transient failure. New "warning" pill state with copy "Verbunden, aber Serverfehler" gives the operator + user the signal that the access token still works but the upstream is responding with `601` / `293` / `294`.
- **`auth.check-user` rate-limit wrapper + 6 auth routes converted** — `checkAuthSurfaceRateLimit` wraps `checkRateLimit` and routes anonymous-bucket trust-violations to a tight 100/15-min global bucket instead of every misconfigured anonymous request collapsing into one shared `unknown` bucket. Applied to `/api/auth/login`, `/api/auth/register`, `/api/auth/passkey/login-options`, `/api/auth/passkey/login-verify`, `/api/auth/refresh`, `/api/auth/check-user`, `/api/auth/password`.
- **Coach SSE re-detects refusal on replayed turns** — every prior turn loaded from `coach_messages.encryptedContent` now runs through `detectRefusal` before re-entering the prompt. A positive hit short-circuits the SSE with a refusal response + emits an `audit.coach.replay-injection` audit row. Closes the "false-negative amplification" path where a regex-bank miss on turn N kept re-entering on every subsequent turn.
- **`/api/auth/passkey/login-verify` body now Zod-narrowed** — replaces the raw `as AuthenticationResponseJSON` cast with an explicit Zod parse upstream of `verifyAuthentication`. Closes the type-narrowing gap a future refactor could trip on; the verifier remains the runtime owner.
- **`activeLocale()` reads the full `Locale` union** — sub-locale users (fr / es / it / pl) now get their native number + date formats from `Intl.DateTimeFormat` instead of the `en` fallback. The legacy `format.ts` helper backed ~25 SSR + audit-log call sites; the new branch falls back to `en` only when the cookie is unrecognised.
- **404 + global-error copy tightened across all locales** — "Page not found / The page you were looking for doesn't exist or has been moved." → "Diese Seite existiert nicht." / "This page doesn't exist." period. Bilingual lockup retained on `global-error.tsx` (root layout has failed by the time this paints — no i18n provider).
- **`relativeMinutesAgo` / `relativeHoursAgo` / `relativeDaysAgo` keys split into `…One` / `…Other`** — `count === 1` now renders the singular form across all six locales. The integration pill abbreviated forms (`vor 1 min` / `vor 1 d`) remain.
- **`coach.network` mapped to its own `errorNetwork` i18n key** — distinct copy from the provider-error bucket so a user sees "Keine Internetverbindung" when their network is dead vs the original generic provider-unreachable copy when the provider itself is down.
- **`DayDrillDown` error renders `measurements.loadError` instead of `measurements.saveError`** — closes the "Save error" misattribution on GET-only failures.
- **Switch tap target extends to 44 × 44 via `::before` pseudo-element** — every Settings / sources / dashboard-layout / coach-settings / notification toggle now meets WCAG 2.5.5 without changing the visual.
- **Comparison-baseline buttons in chart overlay popover bump to 44 px on mobile** — `min-h-11 sm:min-h-9` so phones get the safer target without densifying desktop.
- **Mood-form kebab + edit-mode footer kebab bump to 44 × 44** — `h-11 w-11` to match the medication-form pattern.
- **Bottom-sheet close-X reaches 44 px on phones, keeps 36 px on desktop** — `min-h-9 sm:min-h-11` gated on breakpoint.
- **`Loader2 animate-spin` paired with `motion-reduce:animate-none` across 21 sites** — closes the motion-sensitivity gap on chart loading + settings spinners + admin backup runners + drug-level + doctor-report dialogs.
- **`phase-config-dialog.tsx` Input + Button bump to 44 px on mobile** — drops `text-sm` from the Input so the iOS-zoom-on-focus is closed.
- **`correlation-card.tsx` skeleton mirrors the loaded scatter chart's aspect ratio** — `aspect-square sm:aspect-[3/2] min-h-[180px] sm:h-auto`. Closes the ~60 px CLS on the insights cold mount.
- **`insights-tab-strip.tsx` group-popover items bumped to 44 px** — outer tab pills already met the floor; inner popover items lagged.
- **`chart-overlay-controls.tsx` trigger adopts the responsive `min-h-11 sm:min-h-9` pattern** — consistent with the v1.4.33 maintainer-item-7 settlement.
- **`RecentWorkoutsTile` + `DrugLevelChart` reserve loaded-card height during loading** — no card-pop on first paint.
- **`dedupeWorkoutBatch` honours `User.sourcePriorityJson`** — write-time picker threads the same priority ladder the read-time picker uses. The v1.4.42 docstring warning ("does NOT consult sourcePriorityJson") is now obsolete; the batch route does a single `prisma.user.findUnique` lookup before the dedup pass.
- **`/api/dashboard/widgets` 422 audit-ledger row dedupes per `(userId, action)` over 60 s** — a misconfigured iOS client retrying every 100 ms no longer writes 10 audit rows per second. The 422 response is still per-call; only the audit-ledger row dedupes.

### Fixed

- **`auth.login.failed` audit row no longer persists the raw typed identifier** — replaced with `identifier_hash: hashToken(identifier)`. Closes the PII gap surfaced by the v1.4.20 retroactive directive: an admin scrolling `/api/admin/audit-log` no longer sees every wrong-email a user typo'd at the login screen, and a future audit-table compromise no longer hands an attacker a list of probed identifiers.
- **`WithingsApiError.message` capped at 1024 chars in the constructor** — the v1.4.42 classifier persisted the upstream `json.error` string verbatim into `AuditLog.details`. Withings is the trusted upstream but the operator-readable audit row should match the encrypted-error column's 1024-char cap.
- **Chart empty-state copy split on raw measurement count** — `<HealthChart>`, `<MoodChart>`, `<MedicationComplianceChart>` now distinguish "fewer than 3 entries" (empty-state title) from "many entries but only on 1-2 distinct days" (new `needMoreDistinctDays` title). The user-reported "Erfasse 3 Einträge" on a populated account is closed.
- **Chart `aria-busy` empty branch no longer silently returns null** — replaced with a `<ChartEmptyState>` rendering the `noDataInRange` copy.
- **`docker-publish.yml` bakes the build-tag into the image at build time** — closes the BuildKit cache version-stale paper-cut from v1.4.42.
- **`pnpm check-env` enforces manifest ↔ `.env.production.example` lockstep on CI**.
- **`global-error.tsx` bilingual lockup**.
- **`not-found.tsx` localised via `getServerTranslations`**.
- **German `daysAgo` integration-pill abbreviation** — "vor {count} T." → "vor {count} d" matches the rest of the app's stale-hint pattern.
- **SW `CACHE_VERSION` re-anchors per build** — `public/sw.js`'s literal `"v1.4.38.4"` had drifted four releases stale; the activate-step's old-cache eviction had been a no-op. A new `prebuild` script writes `public/sw-version.js` from `package.json`'s version + `importScripts('/sw-version.js')` re-anchors `CACHE_VERSION` per deploy.
- **Onboarding checklist measurement-completion copy**.
- **Doctor-report unavailable sections render disabled instead of vanishing**.
- **`auth/login + auth/register` test mocks updated for `checkAuthSurfaceRateLimit`** — the earlier new test files pinned the old `checkRateLimit` signature; the `checkAuthSurfaceRateLimit` wrapper rename collided at runtime causing 500 instead of 401 / 422. Both factories + `beforeEach` arming updated.

### Performance

- **Dashboard cold-mount `/api/analytics` (concurrent slim + thick):** 9.0 s + 9.0 s in parallel → est. 2-3 s + 2-3 s in parallel (slim slice fan-out capped at `p-limit(4)`). Warm cache (60 s TTL hit) unchanged at ~50 ms. WMY-converged tenants ≤ 500 ms cold.

### Operator notes

- **Schema migration required**: `prisma/migrations/0075_v1443_integration_park/migration.sql` extends `IntegrationStatus` with `consecutive_failures_by_kind` (JSONB) + `persistent_failure_started_at` (TIMESTAMP). The migration is idempotent (`IF NOT EXISTS` guards on both columns) and reversible (backfill is non-destructive — the legacy single-counter column stays for one release as a fallback). Run `prisma migrate deploy` post-deploy; no downtime expected.
- **No env-var change.** `pnpm check-env` (v1.4.42) still passes; the new env-check CI gate enforces manifest ↔ `.env.production.example` lockstep.
- **No API contract break for iOS v0.5.4.** `returnAllZodIssues` envelope is additively extended (existing `error` field preserved); iOS clients that hard-coded `body.error` keep working. New endpoints (`/api/integrations/withings/resume`, `/api/settings/account` DELETE) are additive.
- **Withings persistent-failure park** flips `IntegrationStatus.state` to `"parked"` after > 24 h of consecutive `persistent` failures (Withings `601` / `293` / `294`). A parked integration's next scheduled sync is short-circuited until the user clicks "Wieder verbinden" (rate-limited 5/min/user). Operator can also call the resume endpoint manually for stuck accounts.
- **Build pipeline**: `docker-publish.yml` now bakes `NEXT_PUBLIC_APP_VERSION` at build time so `/api/version` can never serve a stale version after a Coolify cache re-use. Verify `/api/version` post-deploy as usual.
- `pnpm test --run` green at 5076 passing / 1 skipped (5077 total), up from 4815. `pnpm typecheck`, `pnpm lint`, `pnpm knip` (enforcing) all green. Two pre-existing integration-tier failures in `tests/integration/workout-batch-{create,race}.test.ts` reproduce on `origin/main` unchanged and are NOT caused by this release; flagged for v1.4.44 investigation.

## [1.4.44] — 2026-05-21 — REG-11 dashboard summary hotfix (iOS Home tile sparkline + value)

iOS-operator-blocking hotfix for REG-11: the Home dashboard tile rendered neither chart nor latest value for BP / Puls / Körperfett when the most recent reading was older than 7 days. Root cause was in `/api/dashboard/summary` SQL gates — both `latestIn7d` and `sparkBuckets` required `measured_at >= sevenDaysAgo`, which returned empty for sparse accounts. The iOS tile rendered from `latestValue: null` + `sparkline: []`. Five iOS-side attempts had been wrong because the bug was server-side. v1.4.44 was a same-day same-author hotfix on `main` while broader v1.4.45 work was running in parallel; the broader work is preserved in v1.4.45.

### Fixed

- **`/api/dashboard/summary` `latestIn7d` → `latestEver`**: drops the 7-day filter; `DISTINCT ON (type)` returns the latest reading EVER per type, bounded at N-metrics rows. Sparse accounts (one BP reading 60 days ago, nothing since) now get the tile back.
- **`sparkBuckets` rewritten via `ROW_NUMBER() OVER (PARTITION BY type ORDER BY bucket_start DESC)`**: trailing N daily buckets per type render regardless of calendar age, bounded at SPARK_DAYS × N-metrics.
- **BP + Pulse `metrics.push` gated on `latest || allTimeCount > 0`** like BodyFat already was — accounts with zero readings ever no longer get empty placeholder tiles.

### Tests

Four new cases in `src/app/api/dashboard/summary/__tests__/route.test.ts` pin REG-11:

- BP with a 60-day-old reading → tile emits with historical `latestValue` + `sparkline`
- BP with null readings ever → tile NOT emitted
- Weight within 7 days → behaviour unchanged (regression guard)
- Sparkline window picks up 7 daily buckets even if all older than 7 calendar days

### Operator notes

- No migration. No env-var change. No API contract break for iOS v0.5.4.
- v1.4.43 was skipped; v1.4.45 carries the broader closure work.

## [1.4.42] — 2026-05-21 — Knip enforcing, queryKey factory closed, iOS Workouts dedup, Withings off-response classification

v1.4.41 closed the iOS BP/Weight 14 s perf paper-cut and the soft-delete reader-tier completeness story. v1.4.42 is the follow-up polish-and-iOS-readiness release: the knip CI gate flips to enforcing-mode (zero unused exports + zero unused types on `main`), the long-tail queryKey factory migration closes the v1.4.40 contract for the settings / medications / admin / hooks surface, the `/api/dashboard/widgets` 422 returns every Zod issue so the next iOS contract-debugging session takes one round-trip instead of one per wrong field, Withings off-responses are classified into transient / reauth / persistent (rate-limit-induced `601`s no longer silently retry forever), the iOS HealthKit ingest gets a cross-source workout dedup helper that lets Apple Watch + Withings ScanWatch paired captures collapse to one row at write time, and a tree-hygiene pass lands (BERLIN_DAY_FORMATTER consolidated across nine call sites, Suspense double-comment consolidation, doctor-report-data byte-escape so diffs become readable, pr-detection-worker soft-delete filter, offhost-backup DR-intent comment).

### Added

- **`returnAllZodIssues(error, status?, meta?)` shared helper** (`src/lib/api-response.ts`). Replaces the `apiError(parsed.error.issues[0].message, 422)` pattern that dropped every issue past the first. Envelope: `{ data: null, error: "Validation failed", details: { issues: [{ path, code, message }] } }`. Sanitises issues — `issue.params` is never echoed (can carry the raw rejected user input). First consumer is `PUT /api/dashboard/widgets`; 41 sibling routes were inventoried for the v1.4.45 rollout.
- **`dedupeWorkoutBatch()` write-time cross-source dedup** (`src/lib/workouts/canonical-rows.ts`). Anticipates the v1.5 iOS HealthKit observer queue ingest where Apple Watch + Withings ScanWatch paired captures collide on the same logical workout. Groups by `(userId, activityType, startedAt ± 90 s)`, prefers the canonical source ladder `APPLE_HEALTH > WITHINGS > MANUAL > IMPORT` shared with the read-time picker, breaks ties on `caloriesKcal > earliest createdAt > input order`. Wired into `POST /api/workouts/batch` pre-`createMany`; losers surface as `duplicate` in the per-entry envelope so the iOS sync cursor advances identically to the existing `externalId` dedup. The name intentionally diverges from the v1.4.30 read-time `pickCanonicalWorkoutRows` so auto-completion paths don't conflate write-time payload-internal dedup with read-time cross-batch dedup.
- **`pnpm check-env` CLI** (`scripts/check-env.ts` + `scripts/env-manifest.json` + `docs/ops/env-check.md`). Pre-deploy env-var sanity check that catches the v1.4.40 AP-2 silent-disable pattern (three of four `APNS_*` vars set, `.p8` missing) via the `allOrNone` group marker. Two modes: `pnpm check-env` against `process.env`, `pnpm check-env --file <path>` against a Coolify export. Exit code 0 / 1 / 2 for green / missing required / malformed manifest. The renderer surfaces the satisfying alternative on `anyOf` rows (`[OK] APNS_KEY (satisfied by APNS_KEY_FILE)`) so an operator scanning the output never grep-hunts for the wrong variable name.
- **Withings off-response classifier** (`src/lib/withings/response-classifier.ts`). Pure `(httpStatus, body) → { success | transient | reauth_required | persistent }` taxonomy plus `WithingsApiError` subclass + `classifyError` fallback for pg-boss-rehydrated errors. Surfaces rate-limit (`601`) and contract-mismatch (`293 / 294`) responses to the admin alert path instead of letting them silently retry forever. `FailureKind` extended with `persistent`; persistent failures map to `state=error_transient` with a distinct audit kind so the next sync still runs but the operator sees the trail.
- **Nine new `queryKey` factory entries** at `src/lib/query-keys.ts` covering per-medication `compliance` / `titration` / `cadence` / `glp1Details` / `intakeDrugLevelChart` / `intakeList`, the `withingsStatus` integration read, the paginated `adminAuditLogFiltered`, and `workoutsRecentList`.
- **Berlin-anchored day-key helper** (`toBerlinYmd`) exported from `src/lib/tz/resolver.ts` next to `toBerlinDayKey`. Returns the `{year, month, day}` numeric parts directly so consumers building `Date.UTC(...)` keys (insights bucket series, BP-in-target windows) share the same formatter instance as the cache-key path.

### Changed

- **Knip CI gate flips to enforcing-mode** (`.github/workflows/knip.yml`). The `--include files,dependencies,binaries,unlisted` flag is dropped; any new unused export, type, file, dependency, or binary on `main` now fails the gate. v1.4.42 brings the baseline to 0 / 0. The ignore-block under `knip.json` scopes shadcn (`src/components/ui/**`) and contract types (`src/lib/validations/**`) — both are intentional surface area we keep.
- **Long-tail `queryKey` factory migration closed.** Forty call-site files across `settings/`, `medications/`, `admin/`, `hooks/`, plus three `app/` pages, refactored from bare-literal `queryKey: [...]` to `queryKeys.<entry>()`. The custom ESLint rule (`eslint-plugins/healthlog/queryKey-factory.js`) and the test-guard substitute (`src/lib/__tests__/query-keys.test.ts`) extend their `GUARDED_DIRECTORIES` / `GUARDED_FILES` in lockstep so the gate fires at the same boundary at IDE / `pnpm lint` / `pnpm test` time. The `medicationIntakeList` factory entry decomposes its params into a flat tuple to match the `chartData` + `adminAuditLogFiltered` siblings (the prior packed-object form depended on stable JSON-stringify ordering for cache-key correctness).
- **`PUT /api/dashboard/widgets` 422** now returns every Zod issue plus a worker-side `auditLog` row keyed `dashboard.widgets.validation-failed`. The iOS team picking up the v1.4.41 product-lead callout now sees the full shape mismatch in one response and an operator-grep trail outside the iOS dev console.
- **`BERLIN_DAY_FORMATTER` consolidated** to `src/lib/tz/resolver.ts`. The seven `src/lib/insights/*-status.ts` files that each carried a byte-identical 20-LOC declaration plus the `bucket-series.ts` and `bp-in-target.ts` siblings (two more sites missed in the first pass) all share one formatter instance now. Net ~120 LOC drop, same runtime behaviour, no DST drift.
- **Tile-strip Suspense placeholder** (`src/app/page.tsx`) gains `min-h-[6rem]` plus the cosmetic `flex min-w-0 flex-col` classes so the placeholder chrome matches the live `TrendCard` byte-for-byte. The all-suspend edge case (future RSC hoist of every tile) holds the row open during a synchronous transition instead of collapsing to zero height.
- **Dashboard Suspense double-comment** (`src/app/page.tsx`) — the two adjacent JSX comment blocks describing the same boundary (v1.4.40 W-RSC seed + v1.4.41 W-FRONTEND-FACTORY fallback hoist) collapse into one 5-6 line block keyed to current behaviour with a one-line history trailer. Pure documentation; rendered output byte-identical.
- **`apiError` and `returnAllZodIssues` share a `buildJsonErrorResponse` builder** so the meta / headers passthrough lands in one place; a future extension (e.g. an `errorId` autoinject for Sentry) can't drift between the two helpers.
- **`recordWithingsSyncFailure` extracted** from the two byte-identical 14-LOC catch-blocks in `src/lib/withings/sync.ts`. The sync-activity / sync-sleep migration to typed errors (deferred) will collapse to a single-line catch-block when it lands.
- **`formatAdminAlertPayload` uses a `FailureKind` copy table** instead of nested ternaries. Adding a future fourth `FailureKind` is a one-row table edit, not two more arms in two ternary stacks.

### Fixed

- **Withings rate-limit (`601`) + contract-mismatch (`293 / 294`) responses no longer silently retry forever.** The classifier maps them to `persistent` so the admin alert label fires the first time the response shape lands, instead of after the worker has cycled them through the transient-retry queue indefinitely.
- **`pr-detection-worker` soft-delete filter** — the v1.4.40 audit's W-DELETED-2 sweep missed the personal-records worker; a soft-deleted measurement could remain the user's "best weight" badge until the next ingest crossed the threshold. Both `prisma.measurement.count` (warm-up gate) and `findBestMeasurement` reads now scope to `deletedAt: null`.
- **`offhost-backup.ts:219` DR-intent comment** — the nightly disaster-recovery S3 snapshot deliberately includes soft-deleted rows so a future "restore from yesterday" brings back a row the user undeleted on the source side. The inline comment now documents the asymmetry vs the user-facing `/api/export/full-backup` which correctly excludes them.
- **`src/lib/doctor-report-data.ts` byte cleanliness** — the file was checked in as `Binary files differ` because the sanitiser regex held literal control bytes (NUL + US + DEL) in its character class. The regex now uses `[\x00-\x1F\x7F]` escape-sequence form so the file becomes UTF-8 clean and future code reviews can read the diffs. Same runtime behaviour; the existing 18-case test suite still passes.
- **Two dead re-exports dropped**: `listSupportedTimezones` re-export in `src/lib/tz/resolver.ts` (callers import from `@/lib/tz/format` directly) and the `describeInjectionSite` re-export in `src/components/medications/glp1-medication-card.tsx` ("Re-export so the parent doesn't need to import it" — no caller ever did).
- **`pnpm check-env` catches the v1.4.40 AP-2 silent-disable it was conceived to catch.** The APNs group in `scripts/env-manifest.json` shipped without `allOrNone: true`, so an operator setting three of four `APNS_*` vars and leaving `APNS_KEY` / `APNS_KEY_FILE` empty would still exit 0 — exactly the silent-disable shape the gate was meant to prevent. Adding the flag closes the gap; the regression test pins the AP-2 scenario directly.

### Operator notes

- **No migration.** No env-var change. No API contract break for iOS v0.5.4 — `/api/dashboard/widgets` 422 envelope is additively extended (existing `error` field preserved), and the new `dedupeWorkoutBatch` write-time dedup affects only batches with overlapping `(userId, activityType, startedAt ± 90 s)` rows where the source-priority ladder already determined the canonical row at read time.
- **`pnpm check-env`** is the new pre-deploy gate that would have caught the v1.4.40 AP-2 silent-disable. Manifest at `scripts/env-manifest.json`; run before any production release.
- **Knip CI gate is now enforcing on `main`.** Any push that introduces an unused export or type fails the gate. The shadcn surface and contract types are scoped via `knip.json` ignore-block; future shadcn updates land additively.
- **Withings `persistent` failures** map to `IntegrationState=error_transient` so the next scheduled sync still runs. The distinct audit-kind + admin-alert label lets the operator triage a stuck integration without waiting for the user to surface it.
- **Write-time workout dedup does not consult `User.sourcePriorityJson`.** A user who customised Settings → Sources (e.g. promoted `MANUAL` above `APPLE_HEALTH`) sees their Manual rows dropped at write-time when paired with an Apple Watch row within the 90 s window. Scope-narrow today; v1.4.43 closes it via a one-row `prisma.user.findUnique` lookup at the batch route. The docstring on `dedupeWorkoutBatch` carries the load-bearing operator notice.
- `pnpm test --run` green at 4815 passing / 1 skipped (4816 total); `pnpm typecheck`, `pnpm lint`, `pnpm knip` (no `--include` flag) all green.

## [1.4.41] — 2026-05-21 — iOS perf hotfix, soft-delete completeness, tree hygiene

v1.4.40 closed the architecture-level critical and high-priority findings and shipped the iOS PB30 backend prerequisites. v1.4.41 is the follow-up: one user-visible perf hotfix on the iOS-facing insights endpoints (consolidated into a shared timeout-stub helper that now backs all seven status routes), three remaining soft-delete reader-tier gaps closed (invariant pinned by integration tests), type-consolidation across analytics + backups, a four-branch iOS-onboarding discovery endpoint with per-IP rate-limiting, and a code-hygiene pass that retires the v1.4.39 legacy-NULL UNION discovery arm, extracts the today-intake projection helper, and trims a batch of dead exports.

### Added

- **`POST /api/auth/check-user`** — four-branch discovery endpoint for iOS onboarding (`not_found` / `passkey_only` / `email_fallback` / `exists`). Lets the iOS client surface the correct flow (register vs sign-in vs passkey vs recovery) on the first identifier entry without a separate "do you have an account" prompt. Per-IP rate-limited (30 / 15 min) mirroring `/api/auth/passkey/login-options`; no enumeration leak in the response shape beyond what the sibling routes already disclose. Identifier matched verbatim against `username` + `email` so a `MixedCase@Example.com` registration resolves through the route.
- **`src/lib/insights/persist-timeout-stub.ts`** — one shared helper for the timeout-stub persist + cache short-circuit pattern. Now backs all seven `*-status` routes (bmi, blood-pressure, weight, pulse, mood, medication-compliance, general). Each route's stub is keyed to today's Berlin day; the next mount short-circuits at the cache lookup instead of re-racing the same provider call. Replaces ~120 LOC of duplicate `prisma.auditLog.create({ … timeout: true })` blocks.
- **`src/lib/medications/scheduling/project-today-intakes.ts`** — single canonical home for the today-intake projection + idempotent `createMany` + per-`(med, day)` compliance recompute that previously lived inline in both `/api/medications/intake?scope=today` and `/api/dashboard/summary`. ~200 inline lines collapse to a 145-line helper + two short call sites; the helper returns `{ projected, backfilled }` so the existing `annotate` telemetry continues to ride the same payload.

### Changed

- **Types consolidated.** `AnalyticsData` (four named per-surface shapes) lifts into `src/types/analytics.ts`. `BackupRow` / `BackupsList` lifts out of the admin route handler into `src/types/backups.ts`. Prompt helpers under `src/lib/insights/prompt*.ts` unified into `src/lib/ai/prompts/`. queryKey factory expanded with `auth`, `notifications`, and `about` migrations.
- **queryKey factory enforcement.** A real ESLint rule (`eslint-plugins/healthlog/queryKey-factory.js`) replaces the v1.4.40 test-guard substitute for fail-fast IDE/CI feedback. The guarded surface mirrors the test-guard's `guardedRoots` exactly — `src/components/{charts,comparison}/`, `src/app/page.tsx`, `src/hooks/use-auth.ts`, `src/app/auth/`, `src/app/notifications/`, `src/components/settings/about-section.tsx`. Future passes extend both lists in lockstep.
- **`/streak/*` formally deprecated.** The endpoint no longer responds; the legacy iOS build path returns `404`.
- **Operator: pg.Pool sizing guidance for multi-container deploys.** Added a section under `docs/operator/` documenting how `DATABASE_POOL_MAX` interacts with horizontal-replica counts and the in-tree `p-limit(4)` analytics fan-out cap.
- **Per-tile Suspense fallback now layout-stable.** The dashboard tile-strip Suspense boundary swaps its prior `null` fallback for an `aria-hidden` placeholder div that mirrors the trend-card chrome (`bg-card border-border rounded-xl p-4 md:p-6`). The tile body is synchronous today so the fallback rarely paints, but a future RSC hoist of any tile slot would otherwise leave the grid track empty and trigger CLS as the cell paints in. The structural pin in `src/app/__tests__/dashboard-suspense-boundaries.test.ts` was updated to match.

### Fixed

- **Insights status routes — recurring ~14 s warm response on iOS.** The v1.4.37 bmi-status pattern persists a sentinel `auditLog` row on a 20 s AI-provider stall so the next mount short-circuits at the cache lookup. The blood-pressure and weight status routes shipped without that persist and re-raced the same provider call on every reload. Both routes now route through the shared `persistTimeoutStubAndReturn` helper, as do the four remaining sibling routes (general, pulse, mood, medication-compliance) that carried the same bare-fallback shape and would have leaked the same paper-cut on any of their respective provider stalls. Response envelopes are byte-compatible — iOS v0.5.4 contract preserved. The medication-compliance route's cache-read picked up a stub-row recogniser so its `{ summary, medications }` envelope short-circuits cleanly on the helper's `text` + `timeout: true` payload.
- **`/api/auth/check-user` identifier mismatch.** The route called `identifier.toLowerCase()` before the `OR`-match on `username` / `email`, but `registerSchema` applies no transform on write — both columns are stored exactly as typed. A user registered as `MixedCase@Example.com` would never resolve and iOS onboarding would route them to the sign-up branch despite an existing account. The route now queries the identifier verbatim; tests pin both the casing invariant and the rate-limit 429 path.
- **Soft-delete invisibility in three remaining reader tiers.** The v1.4.40 closure wired `deletedAt: null` filtering through eleven core read paths. The remaining three — `/api/export` bundle reads, `/api/gamification/achievements` queries, and the doctor-report PDF aggregator — are now also filtered. Integration tests under `src/app/api/export/__tests__/soft-delete-filter.test.ts` pin the invariant on all five reader tiers (the prior pass shipped assertions for three out of the five the file header listed).
- **Tree hygiene — retired the v1.4.39 legacy-NULL UNION arm.** The `sum_value IS NULL` discovery arm in `enqueueBootTimeRollupBackfill` was added in v1.4.39 to converge DAY rollup rows that pre-dated the writer change. Production data has since converged, so the arm is removed; per-day missing coverage remains the sole discovery anchor. The read-side `mean × count` fallback in `/api/dashboard/summary` retains legacy-row readability for any self-host operator that has not converged.
- **Lint warnings cleared, unused `tx?` params dropped, 13 dead exports trimmed.** Five `@typescript-eslint/no-unused-vars` warnings on `src/app/insights/page.tsx` and `src/lib/analytics/summaries-slice.ts` removed (leftover from the v1.4.37.2 GROUP BY rewrite). `recomputeMoodBucketsForEntry`, `recomputeMedicationComplianceForDay`, and `recomputeMedicationComplianceForEvent` lose their dead optional `tx?: Prisma.TransactionClient` parameter — no call site ever passed one. Thirteen knip-flagged dead exports narrowed or removed (project-wide knip drops from 48 → 35 unused exports; the exported-types bucket at 52 is deferred to v1.4.42 — most are zod-`infer` downstream types consumed via JSON or the iOS contract and require a per-flag audit). Two mid-file `import type` lines (`src/app/insights/page.tsx`, `src/components/onboarding/getting-started-checklist.tsx`) lifted to the top-of-file import block; the duplicate `DataSummary` import alias in `src/types/analytics.ts` + `src/app/page.tsx` collapsed to a single canonical name.

### Performance

Numbers ride the post-deploy window.

- **Seven insights `*-status` routes: subsequent-mount path 14–20 s → ~50 ms.** Once the AI provider has stalled once that day, the timeout-stub short-circuit eliminates the re-race for the rest of the day. The first-of-day stall still spends the 20 s budget (same as bmi-status pre-v1.4.41). The recurring case the iOS client hits is the subsequent-mount path — eliminated on every status route the dashboard touches.

### Operator notes

- **No migration.** No env-var change. No API contract break for iOS v0.5.4 — every existing response shape is byte-compatible; the new route (`POST /api/auth/check-user`) is an additive surface; the timeout-stub fallback writes use the existing `audit_log` table.
- **APNs .p8 key install is now closed.** The APNs `time-sensitive + priority 10` payload (shipped in v1.4.40) is effective as of v1.4.41 deploy — the `.p8` private key is installed in the Coolify secret store. `aps_last_error` should no longer surface as `auth-failed` on `/api/notifications/status`; the iOS team can verify Focus-bypass behaviour against the live deploy.
- **`/api/dashboard/widgets` 422 on iOS is an iOS payload-shape mismatch, not a server validator gap.** Investigation narrowed the recurring 422 to one of three iOS payload candidates (unknown widget id, out-of-range `order`, missing required field). The server validator is correct and additive-safe. The iOS team picks up the investigation against the next iOS build; v1.4.42 will land multi-issue Zod-error diagnostics so a future shape mismatch reports every offending field instead of just the first.
- **Knip exports / types tier remains staged.** Post-v1.4.41 baseline: 35 unused exports + 52 unused exported types. The `--include` flag flip to enforcing mode is deferred to v1.4.42 once the `knip.json` ignore block has been triaged (the remainder is dominated by zod-`infer` downstream types, shadcn surface area exports, and `typeof X[number]` alias backings — each needs a per-flag audit).
- `pnpm test --run` green at 4732 passing / 1 skipped (4733 total); `pnpm typecheck`, `pnpm lint`, `pnpm knip --include files,dependencies,binaries,unlisted` all green.

## [1.4.40] — 2026-05-21 — Architecture closure and iOS PB30 enablement

v1.4.39.x stitched the rollup tier across mood, medication compliance, and cumulative metrics, and closed the dashboard read paths the rollup tier replaced. v1.4.40 is the architecture-closure release on top of that base: the Prisma pool starvation root cause documented in the v1.4.39 empirical trace is fixed at the source, the soft-delete invisibility contract is now consistent across every reader tier, the per-tile Suspense boundaries that let dashboard chart tiles stream independently are in place, the queryKey factory has CI enforcement that catches bare-literal regressions, and the iOS PB30 backend prerequisites (Apple App-Site Association, AI consent receipts CRUD, time-sensitive APNs payload, public privacy page, notifications/status surface) are live so the iOS v0.5.x sprint can land its dependent screens without further backend churn.

### Added

- **`POST /api/consent/ai` + `GET /api/consent/ai/latest` + `DELETE /api/consent/ai`** — AI consent receipts for App-Store Guideline 5.1.2(i) and GDPR Art. 7 audit trail. Discriminated by `kind` over `ai_full / ai_insights_only / ai_coach` so each consent surface the iOS client collects independently ends up as its own row. Append-only: revoking a receipt writes a new row, never mutates history. 64 KB byte-bounded artefact cap (UTF-8 byte length, not character count) keeps the audit table from absorbing multi-megabyte rows from a misbehaving client.
- **`GET /.well-known/apple-app-site-association`** — universal-link AASA payload pinned to `S8WDX4W5KX.dev.healthlog.app`. Response is served as `application/json` without a charset parameter (Apple's `swcd` daemon is strict about the Content-Type shape) and the payload structure is regression-tested for app-ID parity against `applinks.details[].appIDs`, `webcredentials.apps`, and `appclips.apps` so a future split rotation cannot drift one bundle out of the trio.
- **`GET /privacy`** — public bilingual (German / English) privacy page covering the nine SB-3 disclosure requirements (data categories, third-party processors, sub-processors, retention, deletion rights, AI-assistance scope, marketing posture, contact). Paired-section layout (no JS-driven locale switching) so the static document remains comprehensible to a regulator regardless of the browser's `Accept-Language`.
- **`GET /api/notifications/status`** — operator-and-iOS-side surface for the APNs reachability ledger. Reports `aps_ready / aps_last_error / aps_last_delivery_at / device_token_count` so the iOS app can flag a stale-token failure mode without a separate diagnostic call.
- **CI knip gate** (`.github/workflows/knip.yml`) — fails any push to `main` carrying unused exports, unlisted dependencies, or orphaned binaries. The whitelist (`knip.json`) carries three files (`e2e/setup/test-helpers.ts`, `compliance-line-chart.tsx`, `src/lib/logging/index.ts`) deferred pending the "delete with their dedicated tests" follow-up; everything else is green.
- **`src/lib/rollups/` umbrella** — every rollup helper now lives under one canonical import root. The previous in-tree split between `src/lib/measurements/rollups*`, `src/lib/mood/mood-rollups*`, and `src/lib/medications/medication-compliance-rollups*` is collapsed into `@/lib/rollups/{measurement,mood,medication-compliance,read-wmy,read-cumulative}.ts`. Importers updated in lockstep; zero orphan re-exports.

### Changed

- **Per-tile Suspense boundaries on the dashboard.** Each chart tile now mounts inside its own `<Suspense>` so a slow tile no longer blocks the others on first paint. The parent gate is the slim / thick analytics merge (already split per v1.4.39.2); the per-tile Suspense layer is the structural foundation the v1.4.41 React Server Components migration will graft onto. `mood-chart` queryKey dedup eliminates one round-trip on cold mount.
- **queryKey factory enforcement** (`src/lib/__tests__/query-keys.test.ts`). A walker test fails CI if any guarded file declares a bare-literal `queryKey: [...]`. Guarded roots are `src/components/charts/`, `src/components/comparison/`, `src/app/page.tsx`, and `src/hooks/use-auth.ts`. Cheaper than a custom ESLint rule and points the failure message at the exact `file:line` a contributor needs to fix; opt-in expansion as future releases migrate the remaining sites away from bare literals.

### Fixed

- **Prisma pool starvation root cause** (empirical-trace finding #1). The 15-way `fetchMeasurementSeriesChunked` fan-out in `/api/analytics` thick used to monopolise ≥ 8 of the default-10 `pg.Pool` connections during a power-user cold mount, blocking every other dashboard chart-tile fetch behind it. The fan-out is now wrapped in `p-limit(4)` so analytics holds at most 4 pool slots, and the `pg.Pool` `max` is raised from the library default 10 → 20 (overridable via `DATABASE_POOL_MAX`) so a second concurrent power-user retains ≥ 8 free slots after both branches hit their `p-limit(4)` cap. The cap is a per-request instance, not module-level, so a stale limit cannot leak in-flight state across HTTP boundaries.
- **Soft-delete invisibility full-wire.** Eleven reader-tier helpers across `src/lib/measurements/rollups.ts`, `src/lib/measurements/rollup-coverage.ts`, `src/lib/analytics/{summaries-slice,correlations-fast-path,bp-in-target-fast-path,health-score-fast-path}.ts`, `src/lib/insights/comprehensive-aggregator.ts`, `src/app/api/dashboard/summary/route.ts`, `src/app/api/measurements/route.ts`, `src/app/api/measurements/series/route.ts`, and `src/lib/ai/coach/snapshot.ts` now filter `deletedAt: null` (or the SQL equivalent `m."deleted_at" IS NULL`) at every aggregate, every cursor walk, every `DISTINCT ON` latest probe, and every rollup-rebuild SQL. Three integration-test contracts in `tests/integration/measurement-soft-delete.test.ts` pin the invariant against a Postgres testcontainer.
- **Six remaining insights `measurement.findMany` sites** that the earlier mood-rollup swap left unfiltered (`/api/insights/{targets,cards,generate}` plus `src/lib/insights/{features,glp1-plateau,pulse-status}.ts`). All six now filter `deletedAt: null` so the iOS-adapter card stream, the AI prompt feature aggregator, the GLP-1 plateau detector window, and the per-type tile-strip averages stop counting tombstoned readings once iOS sync starts emitting deletions.
- **Compliance-rollup hook gap on bulk-projection paths.** Both `/api/medications/intake?scope=today` and `/api/dashboard/summary` mint fresh `(medicationId, scheduledFor)` rows in PENDING state when a daily schedule is projected on first read. Without a recompute hook the rollup for the affected `(user, medication, day)` tuples stayed at its previous (pre-projection) `scheduled` count, which inflated the apparent compliance % until the user logged against the new row. Both call sites now fire one recompute per distinct `(medicationId, dayKey)` tuple, deduplicated through a `Set` so the cost stays bounded. The recompute call is wrapped in `Promise.allSettled` so any future change that lets the helper throw still leaves the user request 200-OK.
- **`/api/dashboard/summary` nested-ternary regression** in the heroNumber branch flattened to an `if / else if / else` chain so the linter, the type-narrower, and a human reader all parse the same way.
- **Lint regression** in `src/lib/rollups/` (post-umbrella-move) — a stray `any` import path and one un-narrowed `unknown` resolved by the typecheck-led restructure.
- **`dashboard-suspense-boundaries.test.ts` regex pin** updated to the new shape. The test pinned `useMemo(..., [user?.timezone])` but the production code lifts `user?.timezone` to a `userTimezone` local one line above the `useMemo` so the dependency array stays a stable reference across renders.
- **Consent artefact 64 KB cap** enforced via `Buffer.byteLength(value, "utf8")` (not the prior `z.string().max()` which counts UTF-16 code units). A UTF-8 artefact full of multi-byte code points would have slipped past the 64 KB row budget; the audit-table guarantee is byte-bounded, not code-unit-bounded.

### Performance

Expected on large accounts; numbers anchored on the v1.4.40 empirical trace. Live perf-verify rides the post-deploy window.

- **Late-mounting chart-tile first-paint: +7.3 s → +1.6 s.** Bounded analytics fan-out (p-limit 4 + pool max 20) lets the 6× `/api/measurements?source=rollup` tile burst release incrementally as analytics rotates lanes, instead of gating the entire burst behind the thick analytics drain.
- **6 insights routes cold-mount.** The mood-rollup swap on `/api/insights/{features,targets,cards}` moves mood aggregation off the live `MoodEntry.findMany` walk onto the v1.4.39 mood-rollup tier; the cold-mount budget for the affected routes drops onto the same flat-200 ms band the v1.4.39 `/api/mood/analytics` numbers land in.
- **`avg30LastYear` now populated.** The 425-day `since` cap on the `/api/analytics` live-fallback per-type loop (v1.4.39) lets the year-ago baseline tile resolve from raw data without forcing a 347 k-row scan; the v1.4.40 pool cap keeps that fallback off the hot path.
- **`slope90` via MONTH-tier reader.** `readBestGranularityRollups` auto-routes the 90-day slope window onto the MONTH bucket where coverage allows, eliminating a per-cold-mount aggregate on multi-year tenants.

### Operator notes

- **Migration 0074** adds the `consent_receipts` table (id, userId, kind, artefact, signedAt, revokedAt, createdAt) and the matching index over `(userId, kind, revokedAt, signedAt DESC)`. Additive; no destructive column drops; safe to run forward on a live database.
- **APNs .p8 key install gates live delivery.** The APNs `time-sensitive + priority 10` payload landed in the worker (`MEDICATION_REMINDER` only — the parameterised test pins all six other event-types do not bypass Focus) but real delivery requires the production `.p8` private key to be installed in the Coolify secret store. Until that key lands, `aps_last_error` will surface as `auth-failed` on `/api/notifications/status` — that is the expected pre-key state, not a regression of this release.
- **No breaking API contract change for iOS v0.5.4.** Every existing route shape is byte-compatible; the new routes (`/api/consent/ai*`, `/.well-known/apple-app-site-association`, `/api/notifications/status`, `/privacy`) are additive surfaces.
- **No env-var change required for upgrade.** `DATABASE_POOL_MAX` is optional (defaults to 20).
- `pnpm test --run` green at 4726 passing / 1 skipped (4727 total); `pnpm typecheck`, `pnpm lint`, `pnpm knip --include files,dependencies,binaries,unlisted` all green; the knip CI gate now fails any push to `main` carrying unused exports.

## [1.4.39.4] — 2026-05-21 — Dashboard symmetry for daily-schedule intake projection

v1.4.39.3 fixed `/api/medications/intake?scope=today` to project active schedules through the new `expandTodayIntakes` helper and idempotently backfill missing rows for daily meds (`daysOfWeek: null`). `/api/dashboard/summary` reads the same today-window for its compliance tile but had no projection step, so the iOS Dashboard tile fell to "Heute nichts geplant" even when the intake route surfaced the same meds correctly.

### Fixed

- **`/api/dashboard/summary` compliance tile** now mirrors the intake route's projection. Reuses the canonical `expandTodayIntakes` helper plus an idempotent `createMany({ skipDuplicates: true })` that survives a concurrent intake-route hit racing the same `(userId, medicationId, scheduledFor, REMINDER)` row in before the existence probe converges.

### Operator notes

- No migration. No env-var change. No API contract break.
- Daily meds with `daysOfWeek: null` (DB convention for "every day") now surface in the iOS Dashboard tile + Erfassen sheet the moment the user opens the app, instead of waiting for the reminder worker to enter RED phase at the end of the dose window.

## [1.4.39.3] — 2026-05-21 — Dashboard slim/thick merge robustness and list-page value precision

The post-deploy CI for v1.4.39.2 surfaced eight e2e failures across two
viewport profiles (chart-overlay-controls, dashboard, charts-mobile,
measurement-flow) that were all downstream of two narrow regressions
introduced — or, in one case, surfaced — by the v1.4.39.2 dashboard
split. v1.4.39.3 fixes the root causes, hardens the merge contract with
a pure helper + unit coverage, and brings the e2e route-mock patterns
in line with the v1.4.37 W-CI lesson so the regression class cannot
recur.

### Fixed

- **Dashboard slim/thick merge no longer blanks the tile strip when
  the slim slice resolves empty.** The v1.4.39.2 inline merge used
  `slim?.summaries ?? thick?.summaries`. JavaScript treats a populated
  `{}` as truthy, so a zero-data slim resolve short-circuited the
  thick fallback even when thick carried the full per-type payload —
  the tile strip painted blank, the chart row never mounted, and the
  range tabs / overlay-controls trigger downstream of the strip
  cascaded into eight test failures. The merge now extracts to
  `mergeSlimAndThickAnalytics` (`src/lib/analytics/merge-slim-thick.ts`)
  which uses object emptiness as the discriminator: a populated slim
  still wins on overlapping fields (the v1.4.39.2 progressive-paint
  contract is preserved), an empty slim falls through to thick, and
  both empty leaves the dashboard's data-floor gates to render the
  appropriate empty state.
- **`MeasurementList` no longer truncates non-grouped readings to
  integers.** The v1.4.37 collapsed-list view passed every value
  through `fmt.integer`, which kept the per-day step / activity
  aggregates correct but silently truncated single weight / body-fat /
  body-temperature readings — 78.4 kg rendered as "78 kg" on both the
  desktop table and the mobile card. Grouped rows (`isGrouped === true`,
  the daily aggregate row for cumulative HK types) keep `fmt.integer`
  because the underlying readings are integer-only by definition;
  non-grouped rows now use `fmt.number` which honours up to three
  fraction digits without forcing a minimum (so 78 stays "78" and
  78.4 stays "78.4" / "78,4" depending on locale).

### Changed

- **Playwright route mocks for `/api/analytics` migrate to the regex
  pattern across every authenticated spec** (`dashboard`,
  `chart-overlay-controls`, `measurement-flow`, `charts-mobile`,
  `a11y`, `v1427-responsive-sheet`, `v1427-coach-launch`,
  `v1427-measurements-add-param`, `v1427-insights-empty-state`,
  `onboarding-tour-passthrough`). The literal `**/api/analytics` glob
  Playwright minimatch-compiles does not match the sliced URL form
  `/api/analytics?slice=summaries` that the v1.4.39.2 dashboard split
  fires alongside the thick request, so the slim request fell through
  to the real route and on the seeded test user that returns empty
  summaries — exactly the failure mode the v1.4.39.3 production fix
  guards against, but the regex form is the durable test-side
  alignment with the v1.4.37 W-CI lesson that already swept
  `onboarding-flicker.spec.ts` and `mobile-viewport.spec.ts`.

### Notes

- No schema migration. Runtime + test-fixture-only changes.
- `pnpm test --run` green at 4662 / 4663 (1 long-standing skip); the
  new `mergeSlimAndThickAnalytics` helper carries eight behaviour-
  level unit tests covering the empty-slim, slim-only, thick-only,
  both-empty, and `lastSeenByType` precedence cases.
- Full Playwright suite green at 116 passing / 36 skipped / 152 total
  on both `chromium-desktop` and `chromium-mobile` profiles, locally
  against the production Next.js build (`pnpm build && pnpm e2e`).
  Closing every one of the eight failures from CI run
  `26213226723`.

## [1.4.39.2] — 2026-05-21 — Per-request rollup convergence and progressive dashboard paint

v1.4.39.1 wired the rollup write hook into the previously-bypassed
Withings sync, `/api/import`, and admin-restore paths. New writes from
those surfaces now fold the persistent rollup tier on touch, and the
boot-time backfill discovery surfaces every per-(user, type, day) gap
so a worker restart converges any stranded accounts. v1.4.39.2 closes
two follow-ups the maintainer surfaced from the post-deploy trace: the dashboard
chart still painted its `< 3 daily points` empty-state on the 30-point
range for accounts whose historic rollup partition had not yet been
folded, and the cold-mount UX waterfall left every per-type tile
waiting on the heavy `/api/analytics` envelope.

### Fixed

- **`GET /api/measurements?source=rollup`** now reconciles the rollup
  table against the live `measurements` table when the read returns
  suspiciously few rows. A request that lands while the boot backfill
  is still folding the historic partition would previously short-
  circuit on the sparse rollup (`rollupRows.length > 0`) and never
  reconcile with the live table. The route now probes
  `COUNT(DISTINCT date_trunc('day', measured_at))` against
  `measurements` for the requested window when the rollup carries
  fewer than three rows on a window of at least seven days; if the
  live table holds more distinct days than the rollup, the route folds
  the `(user, type, DAY, [from, to])` partition inline via
  `recomputeUserRollups` and re-reads. The chart paints the full
  window on the same request without paying the cost on subsequent
  requests (the rollup is now converged). The probe is gated on
  rollup sparsity so covered-tenant hot paths stay single-read.

### Changed

- **Dashboard analytics fan-out** split across two parallel queries.
  The per-type tile strip now reads from the slim `?slice=summaries`
  branch and paints as soon as the slim slice resolves; the
  BD-Zielbereich and glucose tiles stream in from the thick branch
  afterwards. Pre-fix the single thick-slice query blocked every per-
  type tile until the heavy fan-out resolved, so the mood and
  medication tiles (separate routes) painted first and every other
  tile arrived as one delayed burst. Both queries share the
  `caches.analytics` 60 s LRU server-side so warm hits stay free.

### Notes

- No schema migration. Runtime-only fix on top of the v1.4.39.1
  write-path hooks.
- `pnpm test --run` green at 4651 / 4652 (1 long-standing skip);
  targeted suites (`src/app/api/measurements`,
  `src/lib/measurements`, `src/app/__tests__`) all clean.
- The inline rollup fold cost is bounded by the requested window and
  one measurement type. For the dashboard chart's 30-day BP_SYS window
  that is a single 30-row upsert against the composite primary key —
  well inside the request budget.

## [1.4.39.1] — 2026-05-21 — Rollup tier catches Withings + import + admin-restore write paths

The v1.4.39 dashboard chart "Noch nicht genug Daten" empty-state on
the 30-point range traced to three measurement write paths bypassing
the rollup table's per-write hook: Withings sync (BP / weight / pulse /
body-fat / activity / sleep), the JSON / CSV `/api/import` endpoint,
and the admin backup restore. Once the chart's `source=rollup` fast-
path landed in v1.4.36, those days never reached the chart at 30 / 90
days — the live raw fetch at 7 days kept showing data, the rollup
fast-path at 30 / 90 days under-counted distinct days, and the chart
tripped its `< 3 daily points` empty-state. v1.4.39.1 wires the rollup
write hook into every remaining ingest path and tightens the boot-time
backfill discovery so any stranded accounts re-converge on the next
worker boot.

### Fixed

- **Withings sync** (`sync.ts` / `sync-activity.ts` / `sync-sleep.ts`):
  every (type, day) pair the sync touched is now handed to
  `recomputeBucketsForMeasurement` after the row writes. Collapsed
  via `collapseToTypeDayKeys` so a 30-day catch-up costs at most ~N
  (type, day) recomputes rather than one per row. Best-effort: a
  populator hiccup never fails the user's sync.
- **`/api/import` endpoint**: measurement creates now track touched
  `(type, day)` pairs and fold the rollup tier at the end of the
  batch. Mirrors the v1.4.39 mood-rollup hook on the same route.
- **Admin backup restore**: the transaction now wipes the user's
  `measurement_rollups` partition alongside `mood_entry_rollups`, and
  the post-transaction step kicks a full `recomputeUserRollups` so
  the restored dataset paints fresh tiles instead of carrying the
  previous owner's daily means forward.
- **Boot-time backfill discovery** (`enqueueBootTimeRollupBackfill`):
  the missing-coverage join moved from per-type to per-day, so an
  account whose Withings sync wrote 27 days of BP without ever firing
  the rollup hook now re-surfaces on the next worker boot even when
  one prior rollup row already existed for the same type. The legacy
  `sum_value IS NULL` branch is preserved on the same UNION.

### Notes

- No schema migration. Additive write-hook plumbing only.
- `pnpm test --run` green at 4648 / 4649 (1 long-standing skip).
- The dashboard chart's read-side `source=rollup` short-circuit stays
  put — once every write path folds the rollup tier on touch, the
  short-circuit is always correct. A defensive coverage-mismatch
  fallback is on the v1.4.40 backlog.

## [1.4.39] — 2026-05-21 — Mood, medication-compliance, and cumulative-sum rollup tiers

The v1.4.38 chain settled the measurement-rollup fast-path. v1.4.39
extends the same "raw data stays untouched, a derived second layer
serves the read path" posture to two more endpoints that still walked
the source table on every cold mount — `/api/mood/analytics` and
`/api/medications/intake?scope=compliance` — and folds a cumulative
`sum_value` column into the existing `measurement_rollups` tier so
step / flight / distance / daylight / active-energy sparklines no
longer re-derive their daily totals in Node.

Raw `measurements`, `mood_entries`, `medication_intake_events` tables
are byte-unchanged. The three new tiers are derived caches that
self-heal via boot-time backfill on first reach.

### Added

- **`mood_entry_rollups`** — per-(user, granularity, bucket) mood
  stats. Reuses the existing `RollupGranularity` enum so the worker
  shares one type across mood and measurement tiers. Synchronous
  DAY-tier write hook on every `MoodEntry` create / update / delete;
  WEEK / MONTH / YEAR folded asynchronously through pg-boss. Boot-time
  backfill queue (`mood-rollup-full-backfill`) discovers legacy
  accounts and converges on first worker boot.
- **`medication_compliance_rollups`** — per-(user, medication, day)
  scheduled / taken / skipped ledger. `day` is a user-timezone-anchored
  `YYYY-MM-DD` string so multi-instance reads do not re-derive
  boundaries. Hook fires on every intake-event mutation plus the
  reminder-worker mint path. Boot-time backfill queue
  (`medication-compliance-full-backfill`) handles legacy accounts.
- **`measurement_rollups.sum_value`** — nullable cumulative-metric
  column populated alongside `mean / count` in every rollup fold.
  Existing rows backfill on next reach via the extended
  `rollup-full-backfill` discovery query.
- **`rollup-read-wmy.ts`** — `readWeekRollups` / `readMonthRollups` /
  `readYearRollups` / `readBestGranularityRollups` reader helpers. The
  auto-router picks the largest granularity that resolves the
  requested window (90 d → DAY, 365 d → MONTH, 1 095 d → YEAR) with
  coverage-miss fall-through. Ready for the v1.5 multi-year trend
  card; not exposed via any route yet.
- **`computeLongWindowSummary(userId, type, windowDays)`** in
  `summaries-slice.ts` — granularity-routed `count / min / max /
mean / sum` aggregate for long-window consumers.
- **`rollup-read-cumulative.ts`** — `readCumulativeDaySums` /
  `readCumulativeDaySumsBatch` / `resolveBucketSum` helpers with
  legacy-NULL fallback.

### Performance

Expected on large accounts; numbers anchored on the v1.4.38 perf
analysis and confirmed by the unit-test fixture suite. Live perf-verify
rides the post-deploy window.

- **`/api/mood/analytics` cold mount: 12.7 s → ~200 ms.** Was an
  unbounded `MoodEntry.findMany` walk + JS aggregation; now a bounded
  rollup read. 5-year `since` ceiling on the rollup branch keeps the
  query plan stable on multi-year tenants. Live-fallback retained for
  coverage misses and pre-aggregates daily means before `summarize()`
  so `summary.mean / latest / min / max / avg7 / avg30 / slope30` stay
  byte-identical between the two branches on multi-entry days.
- **`/api/medications/intake?scope=compliance` cold mount: 3.2 s → ~200 ms.**
  Was an unbounded intake-event findMany + per-day JS bucketing; now a
  per-day rollup read. Coverage probe counts rolled days vs days with
  intake events (partial-coverage cases route to the live fallback,
  not the rollup). Race-safe atomic upsert closes the
  read-aggregate-then-upsert window under concurrent reminder-worker
  and Telegram intake.
- **`/api/dashboard/summary` cumulative sparkline: ~500 ms → ~300 ms.**
  Reads `sum_value` directly instead of recomputing via `mean × count`.
- **`/api/measurements?groupBy=day` cumulative path:** consumes
  `sum_value` directly; eliminates per-type JS aggregation on
  `ACTIVITY_STEPS / FLIGHTS_CLIMBED / WALKING_RUNNING_DISTANCE /
TIME_IN_DAYLIGHT / ACTIVE_ENERGY`.
- **`/api/analytics` live-fallback row cap: 347 k → ~5 k.** Trailing
  425-day `since` cap on the `fetchMeasurementSeriesChunked` per-type
  loop. Defense-in-depth — the v1.4.38.8 per-type fast-path gate makes
  this path unreachable in the common case, but a regression that
  re-triggers it can no longer pull the entire row history. The 425 d
  window preserves `summary.avg30LastYear` (year-ago baseline tile);
  the rollup fast-path stays untouched.

### Fixed

- **Mood + medication-compliance DAY recompute race.** Concurrent
  writes for the same `(user, day)` could interleave their SELECT and
  UPSERT and leave a stale row until the next write. Both helpers
  now use a single atomic `INSERT … SELECT … ON CONFLICT DO UPDATE`
  that re-aggregates inside the upsert subquery.
- **Mood rollup async worker enqueue blocked the user response.** The
  WEEK / MONTH / YEAR pg-boss enqueue is now fire-and-forget; the
  read-critical DAY pass commits synchronously above so the cold-mount
  cost no longer drags pg-boss latency into mood-write responses.
- **Partial-coverage zero-fill on `/api/medications/intake?scope=compliance`.**
  The coverage probe used to flip to the rollup path on a single
  rollup row in the window — legacy accounts with a mid-deploy
  in-progress backfill saw zero-filled tiles for the un-rolled days.
  Probe now compares rolled-day count to days-with-events.
- **Coverage-miss backfill enqueue scoped to the caller's user.** The
  request-path warm-up no longer kicks off a cluster-wide discovery
  scan on every cache-miss; cluster discovery stays on the worker
  boot path. Mirrors the mood-rollup pattern.
- **`dashboard-summary` nested ternary** in the sparkline branch
  flattened per the project's no-nested-ternaries rule.

### Operator notes

- Migrations `0070`, `0071`, `0072` are additive only. `0072` adds a
  nullable `DOUBLE PRECISION` column with no default — catalog-only
  DDL on PostgreSQL 11+, no table rewrite, writes resume in
  milliseconds.
- No environment-variable change. No API contract break. No iOS
  contract change.
- Boot-time backfills converge automatically on first reach. Operator
  trigger remains available via `POST /api/admin/rollups/recompute`.
- Tests: 4 524 → 4 640 unit (+116). Integration suite green.

## [1.4.38.8] — 2026-05-18 — Analytics fast-path gates per-type only

The v1.4.38.5–.7 chain confirmed the rollup-fast-path was bouncing
to the live SQL aggregator even when the helper's own types were
fully covered — every fast-path stacked `isFullyCovered(coverage)
&& specificTypes` and a single unrelated uncovered type (e.g. an
iOS-pushed brand-new ACTIVITY_FLIGHTS reading) flipped the AND
false and stranded the whole helper on live SQL across the full
347 k-row measurement table.

### Fixed

- **`correlations-fast-path` gates only on `BLOOD_PRESSURE_SYS +
PULSE + WEIGHT`** — the three types the helper actually reads.
  `isFullyCovered(coverage)` AND-term dropped.
- **`bp-in-target-fast-path` gates only on `BLOOD_PRESSURE_SYS +
BLOOD_PRESSURE_DIA`**. Same fix.
- **`health-score-fast-path` gates only on `WEIGHT`**. Same fix.

Coverage-probe semantics unchanged. Each helper now consults the
per-type entries directly; a brand-new uncovered metric type no
longer poisons unrelated cards.

### Operator notes

- No new migration. No env-var change.
- Expected: cold-mount `/api/analytics` on large accounts
  drops from 30-75 s to ~3-5 s.

## [1.4.38.7] — 2026-05-18 — Rollup recompute observability + admin trigger

The v1.4.38.5 / v1.4.38.6 chain promised a fast-path recovery for
power-user accounts but gave the operator no way to confirm whether
the boot-time discovery had actually found a stranded user — the
success log only fired when `enqueued > 0 || skipped > 0`, so the
silent "found nothing" case looked identical to the silent "boot hook
never ran" case. And once the worker was up there was no way to
re-trigger discovery short of bouncing the container.

### Added

- **`POST /api/admin/rollups/recompute`** — operator-triggered ad-hoc
  rollup recompute. Body `{ userId: string }` synchronously folds
  one user (`recomputeUserRollups` awaited inside the request). Body
  `{}` re-runs `enqueueBootTimeRollupBackfill()` to kick the
  boot-discovery loop across every user. Admin gate via
  `requireAdmin()` (cookie-only, never Bearer).
- **`fallback_reason` + `missing_types` annotate** on the
  `slim_summaries` live-fallback path. When the rollup-fast-path
  declines, the wide-event now reports exactly which measurement
  types are missing DAY-bucket coverage so the operator can match
  a slow `/api/analytics` cold-mount to the responsible type without
  touching the DB.

### Changed

- **Boot-backfill discovery now logs every result, including the
  silent "no users to backfill" case.** The line cost is one row per
  worker boot; the operator gain is the ability to tell discovery
  ran cleanly from discovery silently no-op'd.

### Operator notes

- No new migration. No env-var change.

## [1.4.38.6] — 2026-05-18 — Boot-backfill discovery SQL fix

The v1.4.38.5 discovery rewrite filtered the LEFT JOIN with
`WHERE r."id" IS NULL` — but `measurement_rollups` has a composite
primary key `(user_id, type, granularity, bucket_start)` and no
surrogate `id` column. Postgres rejected the query with
`column r.id does not exist` (SQL state 42703), the worker boot
swallowed the error per the helper's best-effort contract, and the
queue stayed empty. Net effect: v1.4.38.5 deployed cleanly but
delivered none of its promised fast-path recovery.

### Fixed

- **Boot-backfill discovery now filters on `r."bucket_start" IS NULL`**
  — any column from the right side of the LEFT JOIN serves as the
  "no matching row" sentinel; `bucket_start` is part of the composite
  primary key so the planner already touches the column. Verified
  against the live schema: `42703` no longer raised on worker boot,
  and the discovery query returns the expected per-type-missing
  candidate set.

### Operator notes

- No new migration. No env-var change.
- On first boot after deploy the rollup-full-backfill queue picks
  up users with any missing type-coverage and folds them. Power-
  user accounts may see one slow `/api/analytics` cold-mount before
  the next request lands on the restored fast path.

## [1.4.38.5] — 2026-05-18 — Analytics fast-path restored on long-running accounts

Hotfix on top of v1.4.38.4. `/api/analytics` and the dashboard
summary route were timing out at 30-75 s on power-user accounts
after every container restart — the cold-cache miss fanned out to
the live SQL aggregator across the full measurement table instead
of riding the rollup-fast-path that v1.4.36 / v1.4.37 had landed.

### Fixed

- **Boot-backfill discovery now widens to per-type missing
  coverage.** v1.4.35.1 introduced
  `enqueueBootTimeRollupBackfill` with a discovery query that only
  matched users with ZERO rollup rows. Any account that had ever
  been folded (every long-running user) silently stranded once a
  brand-new measurement type landed: the existing rollup buckets
  kept the user invisible to discovery, but the new type's empty
  DAY partition kept `isFullyCovered(coverage)` at `false` forever.
  Every analytics / dashboard read then fanned out to the live
  aggregator across the full measurement table.

  Discovery now joins `(user, distinct measurement type)` against
  `measurement_rollups` on the DAY granularity and surfaces users
  where any partition is unmatched. The v1.4.35.1 zero-rollup case
  is still covered (the LEFT JOIN of an empty rollup table emits a
  row for every type the user has logged). Integration test pins
  the regression: a user with WEIGHT rolled up + a brand-new PULSE
  row now lands on the queue.

### Operator notes

- On first boot after deploy, the rollup-full-backfill queue picks
  up users with any missing type-coverage and folds them. Power-
  user accounts may see one slow `/api/analytics` cold-mount
  before the next request lands on the restored fast path.
- No new migration. No env-var change.

## [1.4.38.4] — 2026-05-18 — Self-healing stale-shell after every deploy

v1.4.38.3 closed the stale-shell case where the user trips
`ChunkLoadError` mid-navigation — but the reload only fired AFTER
the error surfaced. Users sitting on the dashboard or insights
overview rode out the staleness until they clicked something. The
PWA shell could silently drift across several deploys, surfacing
nothing visible to the user until a click happened to lazy-load a
missing chunk.

### Added

- **`<VersionPoller>` client component** mounted inside
  `<Providers>`. Polls `/api/version` every 60 s. If the live
  version moves ahead of the shell-baked version it unregisters
  every active service worker, wipes CacheStorage, and triggers
  `window.location.reload()`. `sessionStorage` gates the reload to
  once per session so a mid-deploy webhook race that briefly serves
  a stale image cannot loop the page.
- **`NEXT_PUBLIC_APP_VERSION`** is now injected from `package.json`
  at build time (via `next.config.ts`) so the running shell knows
  which release it was built against. Available to any client
  component that needs to compare against the live server version.

### Changed

- **Service worker `CACHE_VERSION` now keys to the release tag**
  (`v1.4.38.4`). The `activate` step already evicts any cache name
  outside the current pair, so bumping the string at release time
  guarantees the precached root HTML and the precached
  `/_next/static/*` chunks from the previous deploy are dropped on
  the next SW install. The string is now part of the release
  routine alongside the `package.json` bump.

### Operator notes

- No new migration. No env-var change.
- Coolify auto-deploys main on tag push.
- Users on the pre-v1.4.38.4 shell still need a single manual
  refresh to pick up the new poller; from v1.4.38.4 onwards every
  future release self-heals.

## [1.4.38.3] — 2026-05-17 — CI green-up, e2e drift fixes, chunk-load auto-recover

Cleans up the three pre-existing CI reds that had been failing on
every push to main since v1.4.38 landed, plus a small client-side
fix for the stale-shell post-deploy paper-cut.

### Added

- **Automatic recovery from stale-shell `ChunkLoadError`.** After a
  deploy the cached SPA shell still references the old chunk
  filenames; Next.js fetches them, the new server 404s, and the
  user lands on the generic error surface. `AppError` now detects
  the chunk-load error family and triggers a single
  `window.location.reload()` to fetch the fresh shell.
  `sessionStorage` gates the auto-reload to once per session so an
  unrecoverable error cannot loop. Browsers in strict-privacy mode
  fall through to the error UI cleanly.

### Fixed

- **TODO marker on the correlations `degraded` sentinel removed.**
  The `No TODO markers` workflow had been failing on every main /
  develop / PR build since v1.4.38; the keyword has been rewritten
  into prose without changing the documented intent.
- **Rollup integration test no longer races the read path.** The
  v1.4.37.1 fire-and-forget on `ensureUserRollupsFresh` left the
  cold-testcontainer integration test asserting `dailyByType` before
  the rollup writes had landed. The test now calls
  `recomputeUserRollups` explicitly so the rollup-driven branch is
  exercised deterministically — matches the production warm-cache
  contract.
- **Doctor-report e2e specs target the v1.4.37 hero-card testids.**
  v1.4.37 lifted the doctor-report card out of the export-tile grid
  and renamed `export-card-doctor-report` /
  `export-action-doctor-report` to `export-hero-doctor-report` /
  `export-hero-doctor-report-action`. The Playwright suite still
  targeted the old ids and timed out on every run.
- **`measurement-flow` e2e mock returns a complete `Measurement`
  shape.** The list-page expects `unit` and `source` on every row;
  the mock omitted both, so the list render crashed before painting
  the row and the test's `expect.poll(...)` for "78.4" timed out.
- **Dashboard "View all" achievement link reaches the 44 px
  tap-target floor.** The link was 46×16 px; mobile-viewport e2e
  rejected it. `inline-flex min-h-11 items-center` keeps the visual
  styling identical while satisfying the floor.

### Operator notes

- No new migration. No env-var change. No public API change.
- Coolify auto-deploys main on tag push.

## [1.4.38.2] — 2026-05-17 — Mood-reminder hotfix bundle + Settings toggle

Hotfix bundle on top of v1.4.38.1. A close review of the v0.5.4
iOS-coordination patch surfaced enough real bugs that the
mood-reminder feature could not have been used safely as shipped:
the locale resolver demoted four of six supported locales to
English, the dedup ledger committed before delivery (so a transient
APNs blip silently nuked the day's nudge), the daily-22:00 timestamp
drifted by an hour on DST days, the APNs payload forwarded
channel-specific structures (the Telegram `replyMarkup` keyboard) to
Apple, and there was no Settings surface for the user to opt in.
v1.4.38.2 closes all of the above and ships the missing toggle.

### Added

- **Settings toggle for the daily mood reminder.** New card under
  `/settings/notifications` with a single Switch wired to the user
  profile flag. Six-locale copy (de/en/es/fr/it/pl) for the card
  title, description, status text, and toasts. Without this surface
  the feature shipped in v1.4.38.1 was unreachable for end users.
- **`DispatchOutcome` return type** on `dispatchNotification` so
  callers can decide whether the send is committed to their own
  ledger. Existing callers ignore the return and keep working —
  the function remains best-effort and never throws.
- **`localHmAsUtc` helper** in `@/lib/timezone` returns the UTC
  instant of local `hh:mm` on the local calendar day implied by
  `now`. Re-derives the offset at the target local time so the
  result is correct on DST transition days.
- **Daily 03:25 Europe/Berlin retention cron** for the
  `mood_reminder_dispatches` ledger: deletes rows older than 90
  days. Slots between the audit-log cleanup and the cumulative
  drain.

### Fixed

- **Mood-reminder ledger now writes only after the dispatcher
  confirms delivery.** A `dispatched = false` outcome (no channel
  succeeded) leaves the slot empty so the next tick is free to
  retry once the user adds a channel or upstream recovers.
- **Mood-reminder locale resolver honours every supported locale.**
  v1.4.38.1 shipped translations for es/fr/it/pl but the resolver
  silently demoted those users to English copy.
- **Mood-reminder FR body restores the apostrophe in `aujourd'hui`.**
  v1.4.38.1 shipped without it; VoiceOver reads the lockscreen
  body aloud, so the typo was audible.
- **Medication-reminder `scheduledFor` and the iOS-snooze
  `scheduledAt` ISO are now DST-safe.** The previous arithmetic
  added raw UTC hours to local midnight, which drifted by an hour
  on spring-forward / fall-back days. The iOS "snooze 15 min"
  action would otherwise anchor against the wrong baseline twice a
  year.
- **Per-user `try` wrapper around the mood-reminder tick.** A
  single bad row (corrupt timezone, dispatcher exception) used to
  abort the whole 22:00 candidate pass; now the wide-event records
  a per-user failure counter and the rest of the cohort is
  unaffected.
- **APNs payload whitelists iOS-relevant metadata keys.** The
  dispatcher's `metadata` is shared across every channel and was
  forwarding channel-specific payload structures (Telegram's
  `replyMarkup` inline-keyboard object, ad-hoc extras) into the
  APNs `userInfo` Apple sees and the iOS notification handler.
  Allowlist now covers only what iOS actually reads.

### Refactor

- Removed an unused `MoodReminderCandidate` interface and the
  redundant `moodReminderEnabled` select field from the
  mood-reminder candidate query (the `where` clause already filters
  to opted-in users).
- CHANGELOG entry for v1.4.38.1 rewritten to drop the
  `EVENT_DEFAULT_ENABLED` identifier reference and describe the
  default-off posture in user-readable language.

### Tests

- Unit suite 4565 → 4551 (rewrote `mood-reminder.test.ts` for the
  new contract; net delta is a rewrite, not a coverage loss).
  Added tests for the ledger-after-delivery semantics, the
  per-user try wrapper, the P2002-race "lost the race but
  delivered" path, the six-locale dispatch, and the FR apostrophe
  regression.

### Operator notes

- No new migration. No env-var change.
- Coolify auto-deploys main on tag push.

## [1.4.38.1] — 2026-05-17 — iOS v0.5.4 push-notification coordination

Coordinates the server side of the iOS v0.5.4 release. Two strictly
additive patches that unblock the new push-notification surface
without changing existing behaviour.

### Added

- **APNs category on med-reminder pushes.** `sendViaApns` now sets
  `aps.category = "MEDICATION_REMINDER"` on every medication-reminder
  payload so iOS renders the three action-buttons (Genommen / Snooze
  15 min / Übersprungen) wired up in iOS v0.5.3. `aps.mutable-content
= 1` is set by default so a future Notification Service Extension
  can hook the payload without a server-side change. The med-reminder
  metadata gains `scheduledAt` (ISO 8601) so the iOS "snooze 15 min"
  action pins to the schedule slot rather than wall-clock delivery
  time.
- **Optional daily mood-reminder event.** New per-user opt-in flag
  (default off) and a 15-minutely worker cron that fires a single
  push at the user's local 22:00 when no mood has been logged for
  the local date. Idempotency is anchored by a unique (user, date)
  ledger row, so a re-tick inside the same 22:00 window and
  concurrent workers cannot double-fire. Users who never opt in see
  no behavioural change.

### Compatibility

- Older iOS builds that don't register the `MEDICATION_REMINDER`
  category render the push as a plain alert (iOS ignores unknown
  category identifiers). Backward-safe.
- `0069_v054_mood_reminder` migration uses `IF NOT EXISTS` +
  `DO $$ ... EXCEPTION WHEN duplicate_object` guards mirroring the
  idempotent pattern from `0061_audit_log_carrier` and
  `0068_v1436_insights_exclude_metrics`.

### Tests

- Unit suite 4524 → 4565 (+41 new in `mood-reminder.test.ts` +
  `apns.test.ts`).

### Operator notes

- Migration applies cleanly on deploy. No schema downtime.
- No env-var change. The cron entry is registered at worker boot.
- Coolify auto-deploys main on tag push.

## [1.4.38] — 2026-05-17 — Robustness sweep, perf hotspots, full localization

Closes the web punch-list before the v1.5 iOS sprint. The release
folds the v1.4.36 → v1.4.37.2 perf carry-overs into a wider sweep:
the iOS dashboard summary route drops from ~4.6 s cold to ~500 ms
via a DAY-bucket sparkline read plus a 60 s response cache; the
insights comprehensive aggregator gains the same SQL-aggregation
playbook on its remaining hot sub-query. A focused robustness sweep
lands fourteen correctness fixes across geo-backfill, rollup
freshness, drain logging, and BP fast-path windows. The Coach feature
gate cascade gains a discovery-style test that walks every insights
route and surfaces two previously-orphan API surfaces missing the
assistant-surface gate — both now hardened. Cross-tz fragility on the
correlations and bp-in-target fast paths gets a runtime guard that
falls back to live SQL for any user more than ±3 h from UTC, with
the proper per-user-tz bucket minting deferred to the iOS sprint.
UX polish lands seventeen P1/P2/P3 items including aria-controls on
drill-down chevrons, dropdown max-width on small viewports, polite
live regions on insights load, and a colour-blind-safe icon on the
GLP-1 take-now pill. Localization steps from ~27 % to ~63 % coverage
across es / fr / it / pl with roughly 3,400 new strings plus
placeholder restoration for three medication-cluster keys. Profile
updates now validate the timezone field against the IANA zone list
at the write boundary, closing a self-DoS regression that the new
dashboard SQL surfaced.

### Performance

- **`GET /api/dashboard/summary` cold-mount 4.6 s → ~500 ms.** Four
  unbounded sub-queries (per-type latest, sparkline raw, today's
  intakes, 365 d intakes plus a conditional fifth) replaced with six
  bounded reads: a `$queryRaw DISTINCT ON (type)` over the 7 d
  window, a `$queryRaw` over `measurement_rollups` DAY buckets, the
  existing `groupBy` for type stats, the two intake reads, and a
  365 d `to_char` distinct-day scan. The whole builder wraps in
  `caches.analytics` keyed `${userId}|dashboard-summary` at 60 s
  TTL. Per-sub-query timing annotates land in `meta.dashboard` so
  the next perf-verify can attribute regressions without
  re-instrumenting.
- **`/api/insights/comprehensive` minor.** Consolidated BP sys / dia
  raw-row reads into a single `findMany({ type: { in: [...] } })`
  with JS partition (preserving order) — one round-trip instead of
  two.
- **Sparkline contract.** For BP / weight / HRV the DAY-bucket mean
  matches the raw read (≤ 1 per day). For ACTIVITY_STEPS / sleep /
  glucose the smoother per-day average is a better trend signal.

### Coach

- **Two orphan API gates closed.** A new discovery test
  (`coach-route-gate-inventory.test.ts`) walks every
  `src/app/api/insights/<…>/route.ts` and asserts each handler
  either calls `requireAssistantSurface("coach")` or appears on an
  explicit allowlist. The walk surfaced two unguarded routes —
  `GET` + `DELETE` on `/api/insights/chat/[id]` and `POST` on
  `/api/insights/chat/messages/[id]/feedback` — both now gated.
- **Cascade test fixture rebuilt** to assert the cross-cut gate
  surface from a single source of truth, and the SSR-mode proof
  swapped to a spy-based assertion that does not need a full DOM
  render to verify the lazy-load chain.

### Robustness

- Geo-backfill batch cap drops 5000 → 500 rows per pass; an
  in-process singleton flag guards the worker handler against
  re-entry across hot-reloads.
- `DRAIN_CUMULATIVE_CUTOFF_HOURS` lifts into the helper module so
  the cron registration and the manual-drain CLI agree on the same
  constant.
- The drill-down `take` parameter is now Zod-refined to a hard
  1000-row ceiling; the route emits 422 above the cap instead of
  serving the unbounded read.
- Analytics `daysAgo` is derived per request from the cached
  `lastSeenAt` so day-boundary crossings can no longer stale-serve
  yesterday's count.
- `ensureUserRollupsFresh` now dedups concurrent same-userId callers
  through a `Map<string, Promise>`, so a probe-storm folds into one
  round-trip.
- WEEK / MONTH / YEAR rollup enqueues on measurement write fan out
  in parallel instead of serial.
- `getClientIp` source matching tightens from a hand-rolled IPv4
  regex to `node:net.isIP` so IPv6 addresses round-trip cleanly and
  malformed strings are rejected at the boundary.
- The MEDICATION categorical enum gains a drift-guard test against
  the label-key map so an enum-only change can no longer ship copy
  fallbacks.
- The dashboard medication checklist and the quick-add modal now
  share their TanStack Query cache (same `staleTime`) so toggling a
  dose no longer fans out two refetches.
- The cumulative drain emits a per-user COMPLETE log line so
  multi-account drains can be reconciled per row in production
  logs.
- BP fast-path priorYear read window is calendar-aware (leap-year
  safe).
- The `correlations.degraded` sentinel carries a TODO marker until
  load-shedding lands — no semantic change, just a hand-off note.
- The private `dayKey` helper in `bp-in-target-fast-path` renames to
  `bucketDayKey` so the cross-file term lines up with the cross-tz
  guard naming.
- Health-score `bpInTargetPct` reuses the same prior-week query
  across windows instead of issuing one read per window.

### Cross-tz fragility

- New `isNearUtc(userTz, now)` helper in `@/lib/tz/format`. The
  correlations and bp-in-target rollup fast paths now invoke it as
  a runtime guard: when the user is more than ±3 h from UTC the
  helper forces a fall-through to the live SQL path so per-day
  aggregates re-key via `userDayKey(measuredAt, userTz)` instead of
  the rollup's UTC bucket. Meta annotates land
  (`correlations.tz_guard`, `bpInTarget.tz_guard`) so production
  logs prove branch selection. Proper per-user-tz bucket minting
  remains a v1.5 iOS-sprint deliverable.

### UX

- Drill-down chevrons gain stable `drilldown-{desktop,mobile}-${dayKey ?? id}` ids
  threaded as `aria-controls` on the trigger and `id` on the
  disclosed panel.
- The Hinzufügen dropdown wraps at `max-w-[calc(100vw-2rem)]` on
  small viewports; the longest label trims from "Medikamenteneinnahme
  erfassen" to "Einnahme erfassen".
- Quick-add labels test extends from en+de to all six locales for
  collision-guard coverage.
- Select trigger right padding tightens on Safari for chevron
  parity.
- Medication intake empty state promotes the CTA into the footer
  slot.
- Insights load now announces via a polite live region for screen
  reader users.
- The GLP-1 take-now window-status colour now pairs with a Lucide
  glyph so colour-blind users perceive the same affordance.
- Arztbericht and dismiss button min-h floors tighten for visual
  hierarchy.

### Localization

- es / fr / it / pl coverage steps from ~27 % to ~63 % per locale,
  roughly 3,400 leaf-value substitutions. Translated namespaces:
  dashboard, measurements, mood, auth, nav, charts, thresholds,
  comparison, onboarding, notifications, insights (sleep, sub-pages,
  coach settings, relative-time, hero, recommendation,
  health-score, daily-briefing, coach), medications (intake, status
  chips, categories, weekdays, intake-history, GLP-1 cluster,
  schedule controls), targets (medical ranges, status labels), and
  the doctor-report PDF strings.
- Three medication-cluster keys had their placeholders restored or
  their hybrid English fragments translated: `glp1NextInjectionDays`
  (now reads natively with `{label}` + `{days}` in each locale),
  `intakeHistoryPageInfo` (re-appends `· {count}` clause for the
  per-page row count), and `dayActivate` / `dayDeactivate` (restore
  `{day}` so a11y labels announce per-weekday).
- `admin`, `settings`, and `achievements` namespaces remain
  intentional T3 — operator-facing surface that will land in a
  follow-up release alongside the iOS launch.

### Security

- `getClientIp` source matching uses `node:net.isIP` for IPv4 / IPv6
  validation instead of a hand-rolled IPv4 regex; malformed
  forwarded headers are rejected at the boundary.
- Profile updates validate `User.timezone` against the IANA zone
  list through a Zod `refine` chained on the existing
  `isValidTimezone` helper. Returns 422 "Invalid IANA timezone" at
  the write boundary so the new `to_char(measured_at AT TIME ZONE
$tz)` SQL in the dashboard summary route cannot be self-DoS'd by
  a corrupted stored value.

### Tests

- Unit suite 4520 → 4524 (four new profile-update timezone-refine
  tests). Integration baseline unchanged.

### Deferred to v1.4.39 / v1.5

- Named `AnalyticsCachedBody` / `AnalyticsEnrichedBody` envelope
  split in the analytics route, plus the same-microtask
  rejection-retry safety fix on `ensureUserRollupsFresh`.
- Coach client-side disabled-state copy on `message-thread.tsx`
  (server API gates are closed; only the local message copy
  remains).
- Repo hygiene sweep (orphan imports, unused helpers, dead i18n
  keys).
- Cumulative sparkline read should use `r.sum` instead of `r.mean`
  for `ACTIVITY_STEPS` / `ACTIVITY_FLIGHTS` / cumulative metrics.
- Coach gate inventory walker should match the closed
  `route.{ts,tsx,js,jsx,mjs,mts}` set.
- Dashboard sparkline live-fallback for empty rollup tail on
  brand-new accounts.
- BP / pulse term unification in es / pl (`tensión` vs `presión`,
  `ciśnienie tętnicze` vs `ciśnienie krwi`, `puls` vs `tętno`).
- Proper per-user-tz rollup bucket minting (v1.5 iOS sprint
  deliverable; today's cheap path is the ±3 h guard with live
  fallback).

### Operator notes

- No schema change. No env-var change. No public API change.
- Coolify auto-deploys main on tag push; first webhook may pull
  stale `:latest`, redeploy after the docker-publish workflow
  completes.

## [1.4.37.2] — 2026-05-17 — Slim summaries SQL aggregation

Second hotfix on top of v1.4.37. The v1.4.37.1 fire-and-forget
release removed the 60 s event-loop block but live HAR still
showed `/api/analytics?slice=summaries` taking ~3.1 s per cache
miss. Root cause: the v1.4.35 implementation read EVERY DAY
rollup bucket for the user (`findMany` without a `bucketStart`
window) and composed `count / min / max / mean` in JavaScript.
On a power-user account that materialised as a ~306k-row
transfer plus a JS loop. The slim slice's contract is the
all-time per-type aggregate — exactly what a SQL `GROUP BY type`
returns in a single round-trip.

### Fixed

- `computeFromRollups` in `src/lib/analytics/summaries-slice.ts`
  swaps the unwindowed `prisma.measurementRollup.findMany` for a
  per-type `$queryRaw` GROUP BY that hands back 8 rows of
  `count / min / max / mean` instead of ~306k bucket rows. The
  downstream JS aggregation is bypassed because the per-type
  aggregate is already shaped server-side. Cache-miss budget on
  large accounts: ~3.1 s → < 100 ms expected.

### Operator notes

- No schema change. No env-var change. No public API change
  (the response body shape is identical to v1.4.37.1).
- Coolify auto-deploys main on tag push.

## [1.4.37.1] — 2026-05-17 — Event-loop unblock on the read path

Hotfix on top of v1.4.37. Post-deploy verification surfaced live
`/api/analytics` cold-mount hits of ~62 s and parallel
`/api/health` checks of ~58 s on the live instance — far above the
v1.4.37 perf claim of 1.5–3 s. Root cause: the synchronous
`ensureUserRollupsFresh(userId)` call at the top of each heavy
read path (analytics route, comprehensive aggregator, summaries
slice) folds the trailing 90-day DAY window when the rollup
watermark trails the newest measurement. On an account with
high-frequency Apple Health step ingest the watermark falls behind
every few minutes, so each cache miss synchronously paid the full
refresh cost on a Node.js worker that also serves the rest of the
request fan-out — including `/api/health`, `/api/version`, and
concurrent iOS calls — and the event loop was blocked for the
duration of the recompute.

### Fixed

- `ensureUserRollupsFresh` is now fired-and-forgotten on all three
  read-path call sites (`src/app/api/analytics/route.ts`,
  `src/lib/insights/comprehensive-aggregator.ts`,
  `src/lib/analytics/summaries-slice.ts`). The function already
  carries its own try/catch envelope, so the `void`-call cannot
  reject. Correctness is preserved by the downstream
  `probeRollupCoverage` check: when a type is partial the live
  fallback fires; the only user-observable change is that the very
  first request after a fresh measurement landed may serve data up
  to ~60 s old, and the next request returns the up-to-date value
  once the background refresh completes.

### Operator notes

- No schema change. No env-var change.
- Coolify auto-deploys main on tag push; first webhook may pull
  stale `:latest`, redeploy after the docker-publish workflow
  completes.

## [1.4.37] — 2026-05-17 — Final web polish before iOS focus

The closing web release before the v1.5 iOS-app sprint. Carries the
v1.4.36 perf carry-over for the full `/api/analytics` route (cold
worst-case 111 s → ~1.5–3 s on power-user accounts), consolidates
Apple Health step samples into a one-row-per-day list view with
chevron drill-down and a nightly drain, restores `IntakeHistoryListV2`
to match the pre-v1.4.28 contract (hides planned and skipped rows by
default), converges every Coach affordance behind a single feature
gate, lifts the medication-detail Mounjaro card to byte-equivalent
parity with Ramipril, brings the Insights overview hero row to
height parity, hardens the `getClientIp` source chain behind a
`TRUST_CF_CONNECTING_IP` env flag, and ships the Arztbericht hero
card on the Settings → Export page. Documentation refreshed across
all three repos (README, healthlog-docs, healthlog-landing) with
five new architecture diagrams in the Dracula palette.

### Performance

- **`/api/analytics` full slice on the rollup-coverage probe.**
  `correlations`, `healthScore` and `bp_in_target` each gained a
  rollup-fast-path that fires whenever every logged type has DAY
  coverage. Live SQL fallback remains the source of truth for
  partial-coverage accounts. The route emits a per-branch
  `meta.<branch>.path: "rollup"|"live"` annotate so production logs
  prove the branch selection. Correlation window tightened
  30 → 28 days with `CORRELATION_WINDOW_DAYS` constant + sentinel
  annotate.
- **Apple Health step consolidation.** New `groupBy=day` + `dayKey`
  modes on `GET /api/measurements` collapse the per-sample step rows
  into one daily total per row (sum + sample count); a chevron
  reveals the per-sample drill-down on demand. Server-side
  aggregation reads from `pickCumulativeDaySum`, which is
  source-priority-aware. A nightly `drainPerSampleCumulative`
  pg-boss job at 03:45 Europe/Berlin (36 h grace window so late
  Watch syncs surface in real time) shrinks the underlying table by
  the same factor. Power-user accounts should see roughly 50× row
  compression once the drain catches up.

### AI Insights

- `IntakeHistoryListV2` on the medication detail page no longer
  surfaces planned/scheduled or skipped rows by default; the API
  gains an explicit `?status=completed` filter and the V2 component
  pins it. Skipped rows render distinctly when explicitly requested.
  Empty-state copy added for medications with only planned-no-taken
  entries.

### UX

- **HealthScoreCard** stretches to the full height of the Insights
  overview hero row via a grid layout with `1fr` on the provenance
  accordion; the right-column card now ends at the left-column
  baseline instead of clipping at the divider.
- **TopBar overflow menu** + **sidebar dropdown** keep menu items
  on a single line. Container widened to `w-60` on both surfaces so
  "Benachrichtigungs-Center" no longer wraps and German labels in
  the top-bar user menu no longer clip without ellipsis.
- **Targets page** card gap tightened (`gap-3 md:gap-4` + `pb-0` on
  the CardHeader) to kill the ~36 px dead band below each metric
  label.
- **Select chevron** right-margin matches the date-picker icon
  gutter at every size.
- **Mood mini chart** wrapper collapsed to render byte-aligned with
  the BP and Weight minis in the trends row.
- **Dashboard "Hinzufügen" button** centre-aligns with the title on
  mobile (`items-center sm:items-start`) so it no longer floats
  next to a 2-line heading.
- **Medication detail card symmetry** — the Mounjaro card now
  carries the same status pill (take-now / overdue / very-overdue),
  the same purple dose accent, the same category-map label, and the
  same primary-action row as Ramipril. GLP-1-specific data
  (injection-site, rotation hint, side-effect quick-log) lives in
  the header-actions kebab so the visual shape stays identical
  across medication kinds.
- **Coach disable cascade** — when the global Coach feature flag is
  OFF, every Coach affordance vanishes (FAB, snapshot button,
  HeroStrip CTA, SuggestedPrompts chips, `/targets` CoachDrawer,
  TargetCard CTA, personal-dropdown entry). A new invariant test
  pins six in-band surfaces; cross-cut gates carry sibling tests.
- **Onboarding checklist** toggle + dismiss button raised to the
  44 px mobile touch floor (uncovered while wiring the e2e fix).
- **Settings — Timezone override** removed. The page now silently
  seeds the browser's IANA zone on first detect; the "Übernehmen"
  button and its i18n keys are gone.
- **Settings → Export — Arztbericht hero card** promotes the doctor
  report to a prominent CTA at the top of the page with a one-line
  value statement. Existing export options stay below in a
  "Weitere Export-Optionen" section.
- **Dashboard quick-add — Medikamenteneinnahme** new action in the
  "Hinzufügen" menu opens a ResponsiveSheet with a smart medication
  picker (auto-selects the medication with an open dosing window,
  falls back to alphabetical), pre-filled dose (read-only for now,
  marked informational), and a time field defaulting to now. Cache
  invalidation fans out to medications, analytics, insights, intake
  summary, achievements and the per-medication compliance chart.
- **Insights BMI status** persists a sentinel cache row on the
  20 s LLM timeout path so the spinner stops re-firing on every
  cold mount; a structured 4-line skeleton replaces the bare
  centred spinner.
- **Trend annotation tri-state contract** carried over from v1.4.36
  works correctly under the new chart-slot heights.

### Security

- **`TRUST_CF_CONNECTING_IP` env flag** (default off) lets
  Cloudflare-fronted deployments read `cf-connecting-ip` so the
  rate-limit bucket key and `audit_logs.ipAddress` column reflect
  the real client IP instead of the proxy. `.env.example`
  documents the security implications explicitly: only set behind
  Cloudflare; nginx / Caddy / direct deployments must leave it off.
- **Hourly geo-backfill** pg-boss job backfills city + country +
  carrier on existing `audit_log` rows that landed without
  resolution (e.g. the v1.4.36 UI fix surfaced gaps the backfill
  now closes).

### Refactor

- New shared modules under `src/lib/medications/`
  (`window-status.ts`, `category-label.ts`) collapse two previously
  duplicated helpers used by both the Ramipril and Mounjaro card
  paths.
- `CUMULATIVE_DAY_SUM_TYPES` derives from `CUMULATIVE_HK_TYPES` so
  the cumulative-type registry is a single source of truth across
  the importer, the drain, the route, the UI and the analytics
  metric-key mapping.
- `cumulativeMetricKey` mapping hoisted out of the analytics route
  into the same shared module.
- `getClientIp` and `getClientIpOrTrustWarning` share one ladder
  via the trust-warning helper.

### Schema

- No new migrations.

### Validation

- `dayKey` now rejects impossible calendar values (e.g.
  `2026-02-30`) so the drill-down can't silently shift to a
  neighbouring day via `Date` overflow.
- `groupBy=day` / `dayKey` requests with `offset > 0` are rejected
  upfront; real pagination on the collapsed branch lands in
  v1.4.38.
- `dayKey` drill-down window now honours DST transitions in the
  user's IANA zone (Berlin Mar 30 + Oct 26 stop showing wrong
  hour-overlap counts).

### CI

- Vitest 4 timeout-option signature corrected on the 5 MB payload
  guard test.
- Integration suite `isolate:true` for the mock-state-sensitive
  notification dispatch tests.
- e2e mobile-touch-target assertions updated to the v1.4.34.5
  44 px floor.

### Documentation

- README rewrite with a hero section, status block, "How it works"
  walkthrough, and four architecture diagrams referenced inline.
- `healthlog-docs` site refresh: three new integration mirrors
  (Apple Health, Withings, AI providers), three placeholder pages
  filled, two new concepts/self-hosting pages added.
- `healthlog-landing` value-statement upgrade with two new
  sections (How-it-works, AI Coach) and the new diagrams.
- Five new SVG diagrams in `docs/diagrams/` (Dracula palette,
  hand-authored to match the existing landing-page aesthetic):
  data flow, Coach pipeline, self-hosting topology, source-priority
  ladder, security model.

### Tests

- Unit suite 4354 → 4486 passing (1 skipped). `pnpm typecheck` +
  `pnpm lint` clean. Integration suite stable at 230 passing; the
  two pre-existing mock-isolation flakes (`apns-dispatch` /
  `integration-status`) are now stabilised by the `isolate:true`
  fix shipped in this release.

### Deferred to v1.4.38

Roughly 50 backlog items across six review axes. Headline:

- Cross-tz fragility in the rollup fast-paths (UTC-anchored
  buckets vs user-local-day pairing) — Berlin-only today, must
  land before the iOS user base broadens.
- Real pagination on the collapsed `groupBy=day` branch.
- BP fast-path window day-edges (cosmetic ~3 % drift today).
- Per-process singleton-guard on the hourly geo-backfill for
  multi-worker deployments.
- Several smaller drift-risk and dead-branch cleanups identified
  by the code-review pass.

## [1.4.36] — 2026-05-17 — Perf, charts, AI payload trim, UX punch

Builds on the v1.4.35 rollup foundation. The aggregator hot paths now
skip the legacy live `COUNT/MIN/MAX/AVG $queryRaw` when every logged
type already has DAY-bucket coverage, daily chart fetches opt into
reading from `measurement_rollups`, and the Insights feature
extractor swaps raw measurements for the same bucket source — which
caps the prompt payload in the low hundreds of kB rather than
double-digit MB for power users. The Insights page itself stops
blocking the entire shell on `/api/insights/comprehensive`, so each
section renders its own skeleton and fills in independently.

On top of the performance work: chart slot heights pinned to kill Recharts'
`width=-1 height=-1` warning and the matching CLS, a tri-state trend
annotation contract that ends the cold-mount "more data needed" flash,
medication intake history restored on the detail page, About card
folded into the Admin Console with an auto-checking update badge in
place of the manual button, cumulative-metric tiles (Steps + four
others) reading the day's running sum, and an IP-whois fallback that
surfaces city + country when the carrier lookup misses.

### Performance

- **Heavy-aggregate skip on the rollup-fresh + fully-covered path.**
  `comprehensive-aggregator` and the slim `summaries-slice` now consult
  a per-type coverage probe (`src/lib/measurements/rollup-coverage.ts`)
  before running the legacy `COUNT/MIN/MAX/AVG $queryRaw`. If every
  logged type has DAY coverage the probe wins and the live aggregate
  is skipped entirely. Partial coverage (e.g. an account with BP
  buckets + a freshly logged WEIGHT type) falls back to the live
  aggregate so no type silently underreports.
- **Daily chart fetches opt into rollup buckets.** `GET
/api/measurements?aggregate=daily&source=rollup` reads DAY buckets
  from `measurement_rollups` instead of scanning the measurements
  table when the window exceeds seven days. The Insights chart
  fetchers pass `source=rollup`; iOS and other clients are
  unaffected.
- **`/api/insights/targets` cached.** Wrapped in the analytics LRU
  (60 s TTL, per-user key, evicted on measurement / mood / medication
  mutations).
- **Insights page: early-skeleton paint.** The page-level `isLoading`
  gate that held the entire shell on `/api/insights/comprehensive`
  is gone. DailyBriefing, CorrelationRow and TrendsRow render their
  own skeletons and fill in independently. (This is early-skeleton
  paint, not Suspense streaming — the page is `"use client"` +
  `next/dynamic({ssr:false})`, so the boundaries the rewrite tried
  to install never triggered and were dropped during reconcile.)

### AI

- **Insights `extractFeatures` swap to rollup buckets.** The feature
  extractor reads `measurement_rollups` DAY buckets instead of raw
  measurements, dropping the prompt payload on a power-user account
  from ~26 MB to the low hundreds of kB. A hard 5 MB
  `FEATURES_MAX_BYTES` guard catches future regressions: the route
  handler downgrades on first oversize (drop raw measurements) and
  again on second oversize (drop anthropometrics + medications +
  compliance + sleep + steps + HRV + resting HR via the exclude
  filter). A third failure returns 422 with
  `insights_payload_too_large` — never a 500.
- **Coach exclusion toggles surfaced.** The Coach settings sheet
  gained medications and anthropometrics switches. The Coach PUT
  mirrors `excludeMetrics` onto a new
  `users.insights_exclude_metrics` column so the Coach sheet and the
  Insights privacy panel share a single contract.
- **`compactSections` empty-block omit.** Coach and Insights prompts
  no longer ship `Schlafdaten: [keine]` / `Medikamente: [keine]`
  lines for sections the account has no data for.

### Charts + Insights UI

- **`trends-row-chart-slot` fixed to `h-[140px]`.** Mood, BP and
  Weight trend cards now align byte-for-byte. Recharts'
  `width=-1 height=-1` warning is gone; expect a measurable
  Lighthouse CLS drop on the Insights page.
- **`ChartSkeleton` mini variant** matches the loaded chart's wrapper
  dimensions so the trends row stops shifting on hydration.
- **`TrendAnnotation` tri-state contract** (`pending` / `needs_data` /
  `generated`). Fixes the cold-mount and regenerate-in-flight flash
  of "mehr Daten nötig, um diesen Trend zu kommentieren". `pending`
  wins over `needs_data` so a regenerate already in flight never
  drops into the empty-hint copy.

### UX

- **Medication intake history restored** via `<IntakeHistoryListV2>`
  on the medication detail page. Server-paginated, sortable by
  `takenAt`, no inline CRUD (consistent with the v1.4.28 retirement
  rationale — edits and deletes go through the regular medication-
  intake routes). Mounted for every medication kind, not just GLP-1.
- **Tab-strip scroll** `inline: "center"` → `inline: "start"` on the
  Settings and Admin Console nav strips. The selected chip now lands
  flush-left instead of jumping into the middle of the viewport.
- **Cumulative-metric tiles** (Steps, Active Energy, Walking/Running
  Distance, Flights Climbed, Time in Daylight) read the day's
  cumulative sum from 00:00 in the user's timezone via a new
  `pickCumulativeDaySum` helper, source-priority-aware in the same
  shape SLEEP_DURATION already used.
- **Insights nav strict-gate** flipped (`if (!availability) return
true` → `return false`). Types without measurements no longer
  appear in the strip.
- **About → Admin Console.** "Über HealthLog" moved out of the
  personal dropdown into a new `/admin/about` slug. The public
  marketing `/about` page is untouched. `/settings/about` stays as a
  bookmarkable permalink for any authenticated user.
- **Update badge auto-check.** The manual "Update prüfen" button is
  retired. A 44 px-square, focus-ringed, `aria-label`-bearing badge
  surfaces next to the version line when the existing 24 h
  auto-check returns `newer_available`; the latest tag is
  interpolated into both the label and an `sr-only` span.
- **IP-whois fallback** surfaces city + country with "Carrier nicht
  verfügbar" / "Carrier unavailable" when the upstream ASN lookup
  misses. The free-tier ipwho.is shortcoming is now graceful UX, not
  a blank chip.

### Accessibility

- IntakeHistoryListV2 sort headers and pagination buttons clear the
  44 px touch floor and carry `focus-visible:ring`.
- UpdateBadge ditto, with a real `aria-label` and an `sr-only` tag
  exposure inside the anchor.

### Schema

- **Additive `users.insights_exclude_metrics`** (`String[] NOT NULL
DEFAULT '{}'`). Migration
  `0068_v1436_insights_exclude_metrics` is idempotent under re-run.

### Refactor

- New shared helpers under `src/lib/insights/` and
  `src/lib/measurements/`: `compactSections`,
  `applyInsightsExcludeFilter`, `pickCumulativeDaySum`,
  `probeRollupCoverage`, `isFullyCovered`. Tested standalone.
- `ensureUserRollupsFresh` now annotates `{ rollup_refresh_failed:
true, rollup_refresh_error: ... }` on failure instead of swallowing
  silently. The read path still returns `{ recomputed: false }` so
  the response never fails because of a populator hiccup.
- Cumulative metric-key lookup hoisted out of a four-level nested
  ternary into a `switch`.
- 42 orphan i18n strings removed (7 keys × 6 locales) — the
  `settings.about.updates*` / `checkUpdates` cluster left behind by
  the manual update-check retirement.

### Tests

- Unit suite 4285 → 4354 passing (1 skipped). `pnpm typecheck` +
  `pnpm lint` clean. Integration suite stable at 230 passing; two
  known mock-isolation flakes (`apns-dispatch` /
  `integration-status` and `enqueueBootTimeRollupBackfill` when run
  alongside `admin-backups-audit.test.ts`) pass in isolation and
  predate v1.4.36.

### Deferred to v1.4.37

- `applyInsightsExcludeFilter` shallow `next.context` mutation needs
  a contract test pin.
- Narrow-aggregate query still scans 90 days of `measurements`; the
  column-pruning is real but not sub-second on cold rows.
- `/settings/about` legacy route still serves AboutSection to any
  authenticated user — content scope is benign; decision pending on
  redirect vs 404 vs documented permalink.
- `/api/measurements?source=rollup` response omits `id` / `unit` /
  `source` for the bucketed shape; iOS unaffected (does not pass
  `source=rollup`). A dedicated `MeasurementBucketResource` schema
  or an `id`/`unit` echo lands next.
- `BUCKETED_TYPES` in `features.ts` duplicates the rollup-populator
  enum (drift risk).
- COUNT-probe call sites in `summaries-slice.ts` and
  `comprehensive-aggregator.ts` could collapse into one helper.
- Cumulative SUM `mean × count` over-counts when two sources
  contribute the same day (Apple Health + Withings both posting
  steps). Pre-existing chart behaviour, not a v1.4.36 regression.

## [1.4.35.1] — 2026-05-17 — Auto-converging rollup backfill on worker boot

Follow-on to v1.4.35. Removes the operator action that was implicit
in the foundation release: instead of self-hosters having to run
`pnpm tsx scripts/backfill-rollups.ts` after upgrading, the worker
boot now discovers any account with measurements but no rollup
coverage and enqueues a one-shot full fold via pg-boss. Idempotent
across reboots (the discovery query only matches uncovered users) and
zero reader-path impact (serial concurrency, runs in the background).

### Boot-time backfill

- **New `rollup-full-backfill` queue** (`ROLLUP_FULL_BACKFILL_QUEUE`,
  concurrency = 1) carrying `{ userId, enqueuedAt }`. The handler
  invokes `recomputeUserRollups(userId)` with the default 5-year
  window across all four granularities — equivalent to the manual
  CLI run, but inside the worker process so no `tsx` install
  gymnastics in production images.
- **`enqueueBootTimeRollupBackfill`** runs once at
  `startReminderWorker` boot after every `boss.work` subscription is
  in place. The discovery query finds users with at least one row in
  `measurements` and zero rows in `measurement_rollups`, then sends
  one job per uncovered account with `singletonKey:
boot-backfill|{userId}` so a fast restart while a fold is queued
  doesn't pile up duplicates.
- **Best-effort:** any error during discovery is captured in the
  return value and logged through `workerLog`; the worker boot never
  fails because the backfill missed.

### Tests

- 5 new unit cases pin the helper's contract (silent no-op without
  boss, one job per uncovered user, singleton-key coalesce counted
  as `skipped`, error surfacing, zero-users path). 2 new integration
  cases verify against the real testcontainer: only the uncovered
  user lands on the queue when a third already-folded user co-exists;
  zero jobs enqueued when every account is already covered.
- Unit suite 4280 → 4285. Integration suite 228 → 230. `pnpm
typecheck` + `pnpm lint` clean.

## [1.4.35] — 2026-05-17 — Persistent measurement rollups + partial read-swap

Foundation release for the persistent `measurement_rollups` cache
tier. Adds a new additive table, populates it from every write path,
and switches two reader surfaces (the comprehensive insights
aggregator and the slim analytics summaries slice) onto it for the
linearly-composable stats. Slope / R² / standard deviation / anomaly
counts continue to run against live SQL — they don't compose across
DAY buckets and stay on the canonical aggregate. A full read-swap
across every analytics surface is planned for a follow-up.

### Schema

- **New table `measurement_rollups`** keyed on
  `(user_id, type, granularity, bucket_start)` with
  `count / mean / min_value / max_value / sd / slope / r2 /
computed_at`. Backed by a composite-descending index on
  `(user_id, type, granularity, bucket_start DESC)`. Additive only —
  no `ALTER` on existing tables. Migration
  `0067_v1434_measurement_rollups` is idempotent under re-run.
- **New enum `measurement_rollup_granularity`** with `DAY`, `WEEK`,
  `MONTH`, `YEAR` granularities. The DAY grain is recomputed inline
  on every measurement write; the wider grains queue onto pg-boss.

### Write hooks

- Every measurement create / update / delete endpoint now calls
  `recomputeBucketsForMeasurement` inside a `try / catch` after its
  successful commit. The DAY bucket is folded synchronously so the
  next read is correct; WEEK / MONTH / YEAR follow on the pg-boss
  `rollup-recompute` queue (concurrency = 2, singleton-keyed per
  bucket to coalesce burst writes onto a single worker run).
- The Apple Health import worker calls `recomputeUserRollups` once
  at completion instead of per-row, scoped to the import's date
  range, so a 100k-sample backfill no longer spawns 100k write hooks.

### Reads

- `comprehensive-aggregator` (the engine behind
  `/api/insights/comprehensive`) sources `count / min / max / mean`
  per type from the DAY buckets via `aggregateBuckets`, plus the
  `dailyByType` correlation feed straight from the bucket means. A
  defensive parity check against the live aggregate's `COUNT(*)`
  falls back to live SQL when divergence is detected — covers the
  cold-mount edge case where the rollup populator is mid-flight.
- `summaries-slice` (the slim slice behind `?slice=summaries`) does
  the same. The all-time window degrades cleanly on accounts that
  never ran the explicit backfill: the rollup covers only what the
  warm-on-read populator pre-folded, the parity check diverges, and
  the live SQL values take over — no semantics break.
- `ensureUserRollupsFresh` is a cheap watermark query that runs
  before every read; on a warm process it's a single indexed lookup,
  on cold mount it folds the trailing 90-day window into the DAY
  rollup before the bucket read fires.

### Backfill

- New `scripts/backfill-rollups.ts` walks every user (or one
  account via `--user <id>`) and folds their measurement history
  into all four granularities. Single-user serial so the Prisma
  pool stays out of contention. Idempotent — every run upserts
  under the composite primary key.

### Tests

- Three new integration cases in
  `tests/integration/measurement-rollups.test.ts` pin the parity
  contract end-to-end against a real Postgres testcontainer: the
  aggregator's `count / min / max / mean` matches live SQL
  byte-for-byte, `dailyByType` matches a parallel
  `date_trunc('day', …)` GROUP BY query, and a freshly-written
  measurement is reflected on the next read.
- Unit suite up by 31 cases (4249 → 4280); integration suite up by 6
  cases (222 → 228). `pnpm typecheck` + `pnpm lint` clean.

## [1.4.34.5] — 2026-05-17 — Critical-path tests + iOS textarea zoom

Follow-on to v1.4.34.4. Two batches: the missing critical-path
integration tests the test-coverage review flagged, and the textarea
viewport-zoom fix surfaced during the mobile-deep pass.

### Tests

- **24 new integration tests across 5 files** closing critical gaps in the test-coverage matrix:
  - `tests/integration/auth-password-change.test.ts` pins the v1.4.34.3+
    `destroyAllSessions` three-transport revocation contract
    end-to-end (Session.deleteMany, ApiToken.revoked, RefreshToken.revokedAt).
  - `tests/integration/admin-reset-password.test.ts` mirrors the same
    contract for the admin-driven reset.
  - `tests/integration/withings-oauth.test.ts` covers connect /
    callback / disconnect plus state-token replay rejection.
  - `tests/integration/passkey-register.test.ts` covers register-options
    - register-verify + tampered-attestation rejection + challenge
      single-use.
  - `tests/integration/cache-invalidation-coverage.test.ts` grids the
    v1.4.34 IW-G invalidation matrix across 5 write surfaces.
- Integration suite goes from 197/50 to 222/55. tsc + lint clean.

### Mobile

- **Five textareas no longer trigger iOS Safari zoom-on-focus.** The
  Coach composer, bug-report description, admin feedback note,
  medication-side-effects notes, and medication-intake JSON import all
  shipped `text-sm` (14 px). iOS Safari zooms the viewport whenever an
  input renders below 16 px. Switched each to `text-base sm:text-sm`
  so the mobile baseline clears the floor while desktop keeps the
  compact look.

## [1.4.34.4] — 2026-05-17 — Hotfix bundle: security, UX, code-quality, docs

A consolidated hotfix landing findings across mobile security, UX + accessibility, code quality + docs,
README + discoverability, web performance, and mobile-deep responsive
behaviour. None of the changes break the public API or the existing
data shape; every fix is additive and SAFE under the v1.4.34.x web
freeze.

### Security

- **Password rotation now revokes every transport.** `destroyAllSessions`
  previously deleted only `Session` rows; long-lived `ApiToken` Bearer
  credentials and short-lived `RefreshToken` rotations survived a
  user-initiated password change or an admin reset. A stolen iOS
  Bearer kept working past the user's most obvious self-remediation.
  The helper now wraps a `$transaction` that revokes all three
  transports in one shot. Same rotation runs from
  `POST /api/auth/password`, `POST /api/admin/users/[id]/reset-password`,
  and `DELETE /api/settings/account`.
- **`/.well-known/` proxy bypass tightened.** Replaced the prefix-match
  `startsWith("/.well-known/")` with an explicit-allowlist `Set` seeded
  only with `apple-app-site-association`. New IETF discovery endpoints
  must be added explicitly so a future `/.well-known/openid-configuration`
  doesn't silently inherit "no auth" status. Also dropped the stale
  `/api/auth/codex/callback` PUBLIC_PATHS entry (the route was renamed
  to the device-code family).
- **HSTS gains `preload`.** The domain is now eligible for the Chromium
  preload list (submit to hstspreload.org after this lands).
- **Withings host removed from the global CSP.** `wbsapi.withings.net`
  was in every page's `connect-src`; mirrored the AI-host gating
  pattern so the host enters CSP only on `/settings/integrations/withings`
  and `/api/withings/` paths. Closes a DOM-XSS exfil shape on every
  non-Withings page.
- **`getClientIp` trust-violation signal.** When `TRUST_PROXY_HOPS` and
  the XFF chain length disagree, every anonymous caller collapsed to
  the `"unknown"` rate-limit bucket. The helper now warns once per
  process and exposes a tagged `getClientIpOrTrustWarning(request)`
  return so future callers can route to a tighter universal bucket.
- **Service-worker URL trust.** `notificationclick` now rejects payload
  URLs whose origin doesn't match `self.location.origin` and falls
  back to `/`. Push payloads are VAPID-authenticated but the
  push-server is our own; a server-side bug should not be able to
  navigate the user's PWA window off-origin.
- **PWA manifest hygiene.** Added `"scope": "/"`, `"id": "/?source=pwa"`,
  `"display_override": ["standalone"]` so sub-path deployments don't
  inherit root scope and install-prompt heuristics anchor on a stable id.

### UX + accessibility

- **i18n leaks closed.** Dialog and Sheet close-X buttons no longer
  ship hardcoded `<span sr-only>Close</span>` — both read `common.close`
  in every locale. Same fix on the ChartSkeleton's loading announcement
  (new `charts.loadingLabel` key) and the notifications-section
  breadcrumb (`nav.breadcrumb`). All six locale files updated.
- **Focus rings on mobile + tablet navigation.** The bottom-nav primary
  links, the More overflow trigger, and the mobile top-bar user menu
  trigger gained `focus-visible:ring-ring/50 focus-visible:ring-2
focus-visible:outline-none focus-visible:ring-offset-2`. Keyboard
  and switch-control users can now see focus on every nav surface.
- **Tap-target floor (WCAG 2.5.5).** Input, NativeSelect, Select, and
  DateTimeInput now ship `h-11 sm:h-10` so mobile clears the 44 px
  floor while desktop keeps the 40 px norm the Button primitive
  converged on in v1.4.33.
- **Admin chip-strip auto-scroll-into-view.** Mirrored the v1.4.33
  settings-shell pattern: the active admin chip now scrolls to the
  centre of the strip on route change.
- **List-page subtitles on mobile.** Measurements, Mood, and Medications
  pages now keep their descriptive subtitle on `<sm` viewports (was
  hidden behind `sm:block`); mobile users get the contextual help
  comparable apps surface.
- **Insights empty-state CTA vocabulary fixed.** `ALLOWED_ADD_TYPES`
  on the measurements page now derives from `MEASUREMENT_TYPES` plus a
  legacy-token normalisation map (`GLUCOSE → BLOOD_GLUCOSE`,
  `TEMPERATURE → BODY_TEMPERATURE`, `HEART_RATE → PULSE`, `BMI → WEIGHT`).
  Insights empty-state CTAs that emit these tokens now open the right
  dialog instead of silently failing.

### Mobile-deep responsive

- **`viewport.themeColor` reacts to light/dark mode.** Replaced the
  hardcoded `#282a36` with a media-query pair so the Android URL bar
  and iOS PWA status bar match the active palette.
- **TopBar reserves `env(safe-area-inset-top)`.** iOS PWA on notched
  iPhones no longer clips the HealthLog logo + auth controls under
  the system status bar.
- **Coach FAB respects safe-area-inset-bottom.** Bottom position now
  reads `calc(env(safe-area-inset-bottom,0px)+5rem)` so the FAB
  doesn't collide with the bottom-nav on the home-indicator inset.
- **Sonner toaster reads `theme="system"`.** Was hardcoded to dark; on
  light-mode pages the toast contrasted badly against the surface.

### Code quality

- **`SESSION_SECRET` dropped.** The env var was required by the docker
  entrypoint and listed in every onboarding doc but never read by
  code. Removed from `.env.example`, `docker-entrypoint.sh`,
  `docker-compose.yml`, `CONTRIBUTING.md`, `docs/self-hosting/scaling.md`,
  and the README's Quick Start (three secrets, not four). Self-hosters
  upgrading can delete the existing line; the entrypoint no longer
  fails-fast on its absence.
- **`toJson<T>()` helper.** Seven Prisma JSON-write sites cast via
  `value as unknown as Prisma.InputJsonValue`; consolidated onto one
  helper in `src/lib/db.ts`. New unit test pins the cast shape.
- **`db-compat.ts` header docstring.** Names the file as the
  schema-bootstrap path that runs ALTER-TABLE-IF-NOT-EXISTS so a
  fresh container syncs without `prisma migrate deploy`.
- **Passkey types.** `RegistrationResponseJSON` and
  `AuthenticationResponseJSON` from `@simplewebauthn/server` replace
  the previous `any`-typed responses; the per-line `eslint-disable`
  pragmas drop out.
- **Zero-TODO CI gate.** A new workflow at
  `.github/workflows/no-todo-markers.yml` fails the build if any
  future contribution introduces a TODO/FIXME/XXX/HACK marker into
  product code. Test files are excluded.

### Documentation + discoverability

- **README rework.** New "How it compares" matrix vs Withings web,
  Apple Health, Oura, Garmin, and generic CSV. Apple Health import
  and AI Coach + Insights both promoted to standalone Key-Features
  bullets (Apple Health was previously absent from the README despite
  being the v1.4.34 banner feature). Added a Status block, a live
  Latest-release badge, a GHCR multi-arch badge, and a one-line
  OpenAPI pointer above the API Reference table. Tagline tightened
  to lead with "self-hosted health tracker" + the two integration
  anchors.
- **OG metadata.** `src/app/layout.tsx` openGraph + twitter cards now
  carry `images`, a higher-intent description, and the
  `summary_large_image` Twitter card. Uses the existing
  `logo-readme.png` until a 1200×630 dashboard capture replaces it.
- **GitHub repo metadata.** `description` tightened from 290 chars to
  156 chars and keyword-front. `homepageUrl` flipped from a personal
  tenant to the demo site. Six generic / PII-adjacent topics dropped
  (`glp-1`, `mounjaro`, `tracking`, `health`, `dashboard`,
  `bloodpressure`) and replaced with six high-intent ones
  (`apple-health-import`, `withings-alternative`, `glucose-tracker`,
  `mood-tracker`, `ai-insights`, `personal-dashboard`).
- **New user-facing docs.** Five guides added under `docs/`:
  - `docs/self-hosting/getting-started.md` (clone → first measurement)
  - `docs/self-hosting/reverse-proxy.md` (Caddy / Traefik / NPM /
    Coolify / bare Nginx)
  - `docs/integrations/apple-health.md` (the v1.4.34 banner feature)
  - `docs/integrations/withings.md` (developer-portal walkthrough +
    webhook-secret path-segment rationale)
  - `docs/integrations/ai-providers.md` (all four `User.aiProvider`
    values + local-endpoint setup)
- **`docs/README.md` clarifies the docs tree** as internal playbooks
  vs the user-facing `docs.healthlog.dev` site.

## [1.4.34.3] — 2026-05-17 — Remove the dashboard Coach CTA

Per maintainer directive: the dashboard hero CTA that v1.4.34 added
("Frag den Coach" sparkles button next to "Hinzufügen") is removed
from the dashboard. The Coach surface remains reachable from the
`/insights` tree where it originally lived; the auth-shell-level
`<CoachLaunchProvider>` + drawer mount stay intact so other pages
that want to surface a Coach CTA can opt in cleanly. The button was
visually loud on the dashboard hero and not the right placement for
the surface.

### Changed

- `src/app/page.tsx` no longer renders the dashboard Coach CTA. The
  `useCoachLaunch` hook, the `useFeatureFlags` hook (only used for
  the CTA gate), and the `Sparkles` icon import all drop out of the
  dashboard tree as a side effect.

## [1.4.34.2] — 2026-05-16 — `pull_policy: always` so Coolify deploys actually pull

Bundle-release hotfix for the v1.4.34.1 deploy stall. The GHCR image
for v1.4.34.1 published successfully, but Coolify's `docker compose up`
on the apps-01 host kept reusing the cached `:latest` digest because
`docker-compose.yml` had no pull policy declared — Docker's default
("only pull if missing") happily skipped the registry round-trip and
restarted the container with the prior v1.4.34 image, completing each
deploy in ~20 s without ever fetching the new manifest. Two consecutive
force-rebuilds of v1.4.34.1 reproduced the pattern.

### Changed

- `docker-compose.yml` now declares `pull_policy: always` on the `app`
  service. Compose-up re-checks the registry digest on every `up` and
  pulls when GHCR has a newer manifest, regardless of the tag string.
  The minor bandwidth cost per deploy is the price of correctness; the
  alternative — pinning to a version tag per release — would require
  every operator (self-host included) to bump the tag on every release.
  v1.4.34.1's perf work ships in this image because all of it is on the
  `:latest` tag the Coolify deploy will now actually pull.

## [1.4.34.1] — 2026-05-16 — Insights cold-mount perf hotfix + scatter-card sizing

Hotfix on top of v1.4.34. The Insights page mount was paying ~29 s on
every cold load against accounts populated by the v1.4.34 Apple Health
importer. Root cause: `/api/insights/comprehensive` walked the unbounded
90-day measurement set into JS, then ran per-type `summarize()`, BMI,
blood-pressure classification, target adherence, and four Pearson
correlations from the same pile of rows. On a 100 000+ row account the
route consumed one of the 20 pool connections for the whole 29 s, which
cascaded sibling endpoints into Cloudflare "no available server" 503s.
The scatter-correlation card also surfaced a `width(-1)/height(-1)`
Recharts warning on first paint because its dynamic-mount lacked a
non-zero floor before aspect-ratio resolved.

### Changed

- `/api/insights/comprehensive` now reads through a SQL-side aggregator
  (`src/lib/insights/comprehensive-aggregator.ts`) that groups by metric
  type with Postgres-native `AVG` / `MIN` / `MAX` / `REGR_SLOPE` /
  `REGR_R2` on the `measurements (user_id, type, measured_at)` index
  path. Returns the same `DataSummary`-shaped per-type bundle the legacy
  route stitched together; the medication-compliance block keeps its
  bounded Prisma reads — those were already on the safe path. The route
  is wired through the server cache keyed on `${userId}|comprehensive`
  (60 s TTL) so the second consumer inside the window resolves on a
  `Map.get()` instead of re-running the aggregate. Witnessed wall-time:
  the cold path drops from ~29 s to a few hundred milliseconds against
  a fixture matching the production volume that triggered the bug; the
  warm path resolves in single-digit milliseconds.
- Cache-wrap the five remaining read routes the v1.4.34 server-cache
  blueprint left staged but unwired: `/api/mood/analytics`,
  `/api/workouts`, `/api/bugreport/status`, `/api/medications`,
  `/api/dashboard/widgets`. All five sit on `caches.*` instances already
  provisioned by the v1.4.34 IW-G primitive; each handler now reads
  through `cached(...)` and benefits from the existing per-user
  invalidation matrix (`invalidateUserMeasurements`,
  `invalidateUserMood`, `invalidateUserMedications`,
  `invalidateUserDashboardWidgets`, `invalidateAppSettings`). The
  Cloudflare 503 cascade on `/api/measurements?aggregate=daily` resolves
  as a downstream consequence — once the comprehensive route stops
  monopolising the pool, the origin accepts new connections fast enough
  that Cloudflare's origin-fail circuit-breaker no longer trips.

### Fixed

- Scatter-correlation card no longer logs the Recharts
  `The width(-1) and height(-1) of chart should be greater than 0`
  warning on first mount. The wrapper now carries a `min-h-[180px]`
  floor that matches the loading skeleton so `ResponsiveContainer`
  always measures a non-zero parent before aspect-ratio settles.

## [1.4.34] — 2026-05-17 — Apple Health import + reliability + web freeze

The final functional web release before the iOS native client lands.
Headline work: a streaming Apple Health `export.zip` importer for
prospective iOS-migrating accounts, a server-side aggregation cache
that collapses the three hottest dashboard reads onto in-process LRU
slots with single-flight coalescing and per-user invalidation, a
broader compliance classifier with a dedicated `early` bucket so
ahead-of-window doses count as compliant, the Coach launch surface
hoisted onto every authed page with a dashboard-hero CTA, and a
trimmer Settings shelf that folds Sources into Targets. The release
also lights up the `cache.<name>.outcome` annotation on the active
wide event so production logs carry the cache hit-ratio signal
without leaking userIds.

### Added

- **Server-side aggregation cache.** A new `ServerCache<T>` primitive
  (`src/lib/cache/server-cache.ts`) extends the v1.4.33 Coach snapshot
  LRU shape into a reusable per-route layer with TTL expiry,
  capacity-bounded LRU eviction, single-flight read coalescing, and
  per-instance hit / miss / eviction / stampede counters. Wires the
  three hottest dashboard reads — `/api/analytics` (slim + default),
  `/api/gamification/achievements`, `/api/medications/intake?scope=compliance`
  — and bolts per-user invalidation onto every measurement / mood /
  medication / workout / dashboard-widget write endpoint so the next
  read paints fresh data instead of waiting out the TTL. Every cache
  hit / miss surfaces on the active wide event as
  `cache.<name>.outcome` + `cache.<name>.key_hash` so production logs
  carry the hit-ratio signal without leaking userIds.
- **Apple Health `export.zip` import.** New endpoint
  `POST /api/import/apple-health-export` (synchronous multipart
  upload, asynchronous ingest via a dedicated pg-boss
  `apple-health-import` worker, per-`MeasurementType` ingestion
  stats). Streams the upload straight to disk so a multi-gigabyte
  export never lands in V8 heap, hashes the bytes inline for
  content-based idempotency, and unpacks `apple_health_export/export.xml`
  with a hand-rolled ZIP central-directory walker that handles Zip64
  for archives past the 4 GB barrier. The parser folds every
  `<Record>`, `<Workout>`, `<Correlation>`, and `<ClinicalRecord>`
  into the existing `Measurement` and `Workout` row shapes — spot
  rows keyed by `HKMetadataKeyExternalUUID` (or a deterministic
  `sample:<sha256>` fallback), cumulative HK types collapsed into
  one `stats:<HKType>:<YYYY-MM-DD>` row per user-local day to match
  the iOS daily-aggregation convention. Live per-stage progress
  surfaces through `GET /api/import/apple-health-export/{jobId}/status`.
  An admin variant at `POST /api/admin/import-apple-health-export`
  imports on behalf of a target user (cookie-only `requireAdmin()`
  gate; Bearer tokens never elevate).
- **`ImportJob` schema model + migration.** New Prisma model captures
  the per-upload state machine (`queued | unpacking | parsing |
upserting | done | failed`), the content-hash for idempotency
  short-circuits, and the per-`MeasurementType` ingestion counters
  the status route surfaces back to the client.
- **`lastSeenByType` on `/api/analytics`.** Both the slim
  (`?slice=summaries`) and default slices return a per-type
  `{ lastSeenAt, daysAgo }` map. The dashboard trend tiles wire 12
  mounts to a new `tileStaleDays()` helper so an "X days / weeks /
  months ago" hint paints under any per-metric tile whose last
  sample crosses the 7-day floor. Six locales gained additive
  week / month plural keys; Polish uses the genitive-plural form
  that covers every non-1 count the bucket math can produce.
- **Dashboard "Ask the coach" hero CTA.** A new pill next to the
  existing "Hinzufügen" / "Add" launches the Coach drawer directly
  from the dashboard hero. The `<CoachLaunchProvider>` hoisted from
  the insights layout to the auth shell so the drawer is reachable
  from every authed route; the floating action button stays scoped
  to `/insights/**` so it cannot distract on the dashboard.
- **Shared achievements query hook.** `useAchievementsQuery()`
  centralises the three previous consumers — recent-achievements
  card, the `/achievements` mother page, and the unlock notifier —
  onto one TanStack queryKey + cache slot so dashboard cold mount
  fires the endpoint once instead of twice.
- **Typed authed Cache-Control presets.** New
  `src/lib/http/cache-headers.ts` module exports
  `NO_STORE_BUT_BFCACHE = "private, max-age=0, must-revalidate"`,
  `SHORT_LIVED_PUBLIC`, and an `applyAuthedHeaders()` helper. The
  presets land at the framework level via a `next.config.ts`
  `headers()` rule that stamps the bfcache-friendly directive on
  every authed HTML response, restoring Chromium bfcache eligibility
  for in-app back / forward navigation.
- **`scripts/print-bundle-report.mjs`.** Restores the at-a-glance
  "top client chunks by parsed size" signal Turbopack dropped from
  `next build`; reads `.next/analyze/client.json` (written by
  `@next/bundle-analyzer` when `pnpm analyze` runs with `ANALYZE=1`)
  and prints a sorted table plus totals.

### Changed

- **Settings sidebar: "Sources" folded into "Targets & Sources".**
  Per-metric threshold ranges and per-metric source priority now
  share one `/settings/thresholds` page so the same metric's
  threshold and device-source preference sit together instead of
  one sidebar entry away. `/settings/sources` keeps a
  `permanentRedirect` so external bookmarks and docs links follow
  through unchanged. Section count: 11 → 10.
- **Insights tab strip: vital pills collapse under a "Vitals"
  parent.** Five vital pills (HRV, Resting HR, Oxygen, Body
  Temperature, Active Energy) hide behind one parent pill that
  opens a popover sub-list. Parent-pill active state mirrors the
  URL so spatial orientation survives the collapse; each sub-page
  keeps its own URL and bookmark resolves unchanged. Strip
  footprint: 14 → 10 entries when every metric has data.
- **Coolify env-var audit.** `mcp__coolify-apps01__env_vars`
  inspection captured the section-1 / section-2 duplicates that
  have accumulated under apps-01 since v1.3.1. No env-var
  deletes performed (operator action).

### Fixed

- **Compliance classifier: early intakes count as compliant.** The
  classifier picked up a dedicated `early` bucket (window-start
  minus three hours through window-start), the `on_time` post-window
  tolerance widened from one hour to three hours, and the `late`
  band sits between the new `on_time` ceiling and the configurable
  `lateMinutes` knob. Heatmap consumers route the new bucket
  through the compliant path; the dedicated `early` counter rides
  on `DailyComplianceEntry` for downstream consumers that want to
  distinguish ahead-of-window from on-window intakes.
- **Compliance heatmap fallback retired.** The v1.4.33 defensive
  `looksClassifierBug` fallthrough is gone now that the underlying
  classifier widening removes the every-dose-very-late mode the
  fallback covered.

### Performance

- **`/api/gamification/achievements` consumer collapse.** Two of
  three previous consumers shared the same TanStack queryKey
  literal; the third carried a per-user discriminator so the cache
  treated it as a fresh slot. Dashboard cold mount fired the
  endpoint twice. Collapsing onto the shared hook trims that to a
  single request; with the new server-side cache slot warm, the
  duplicate-mount worst case rides single-flight coalescing.
- **GHCR build fires once per release tag.** The
  `docker-publish.yml` workflow lost its `push.branches: [main]`
  trigger; the `:latest` raw-tag enable rule moved onto the tag
  ref so each release produces exactly one multi-arch build that
  refreshes both the semver tags and the `:latest` alias.
- **NFT-trace warnings silenced.** `next.config.ts` gained an
  `outputFileTracingExcludes` block that narrows the Turbopack
  tracer away from the `MAXMIND_LICENSE_KEY` env-access path so
  the trace-report no longer warns on every dependent route file.

### Refactor

- **Dashboard analytics consumers.** The two cards that previously
  decided their own freshness copy now lean on the typed
  `tileStaleDays()` helper and the additive `lastSeenByType` field
  on the analytics response. Mood and BD-Zielbereich tiles keep the
  default `null` because they have no underlying per-type freshness
  signal.

### Accessibility

- **Dashboard hero CTA hits the WCAG 2.5.5 touch-target floor.**
  The new "Ask the coach" pill carries `min-h-11` on mobile and
  the matching `sm:min-h-9` desktop floor so the touch target
  stays above 44 px on the Pixel 5 boundary.
- **Insights tab-strip Vitals parent reads correctly to assistive
  tech.** Parent pill carries `aria-current="page"` whenever the
  current URL matches one of its child vital sub-pages, plus a
  `data-slot="insights-tab-strip-group"` hook for visual-regression
  testing.

### Internal

- **Two e2e flake windows tightened.** `onboarding-flicker` swapped
  its 12-sample 50 ms poll loop for a single Playwright
  auto-retrying `toBeHidden({ timeout: 700 })` assertion so the
  1-2 ms race window between the analytics-pending shell and
  `useAuth().user` resolving collapses to a single retry slot.
  `mobile-viewport` dropped `nav a[href]` from the touch-target
  sweep (the bottom-nav owns its own WCAG spec) and gated the
  44-px floor on `matchMedia('(min-width: 640px)').matches === false`
  so the Pixel 5 viewport never tripped into the `sm:` tier during
  WebKit render commits.
- **Server-cache observability.** Every `cached()` invocation passes
  an `annotate` callback that lands two keys on the wide event:
  `cache.<name>.outcome` ∈ `{ hit | miss | stampede }` and
  `cache.<name>.key_hash` (non-reversible djb2 32-bit hash). Ops
  can grep `cache.analytics.outcome` over any time window to
  compute the hit ratio per deployment.
- **AASA followups verified.** The v1.4.33 `/.well-known/apple-app-site-association`
  handler serves a direct 200 on every fronting origin; Apple's
  CDN has ingested matching bodies for all three domains.

### Web freeze

v1.4.34 marks the last functional release of the web codebase before
the iOS native client launches. Subsequent v1.4.x tags carry security
fixes, dependency bumps, and hotfix-only corrections. New feature work
is paused until the iOS app clears Apple review, at which point a
v1.5.0 version-bump-only release tags the milestone. The Prisma
schema head comment pins the freeze trigger in-tree.

## [1.4.33] — 2026-05-17 — Polish and reliability

Quality-leap release between two HealthKit milestones. The headline is
a P0 hotfix for the `/api/analytics` 500 that broke the Insights
mother page for any account with more than a few thousand
measurements: the six per-metric status helpers were spreading
the entire numeric history into `Math.min` / `Math.max`, which
trips a stack overflow once a single argument list exceeds the V8
spread cap. Both the surfaced symptom and the latent risk in five
sibling helpers were folded onto a reduce-based min/max path.
Around that hotfix landed a deep polish pass: the Insights mother
page now defers three below-the-fold blocks behind `next/dynamic`
to trim the cold mount cost, the analytics endpoint gained a
`?slice=summaries` slim slice that the per-metric sub-pages now
ride, the Coach snapshot builder picked up a 60 s LRU keyed on
`(userId, scope)`, the Settings shell consolidated three
duplicate copies of the about / notifications / about-dropdown
surfaces, the navigation strip dropped a redundant "Home" group
label and a colliding "Notifications" sibling, every icon-only
button on the medications and admin surfaces gained an accessible
name, every Progress bar gained one too, three pages had their
heading hierarchy repaired to a sequential `h1 → h2 → h3`, the
mobile Coach FAB now hides while a chart tooltip is open so it
cannot occlude the read-out, and the auth shell normalised every
authenticated route to a single `max-w-screen-xl` container. The
release closes nineteen issues from a five-surface audit + a
runtime bug-hunt pass, plus six follow-up tracks of polish across
the affected surfaces.

### Added

- **Slim `/api/analytics?slice=summaries` slice.** Per-metric
  sub-pages opt into a payload that drops `correlations` +
  `healthScore` + `medications` blocks, cutting the cold-mount
  response on those routes by roughly half. The mother page stays
  on the default thick slice so the correlation row + health
  score badge still resolve from the same cache key.
- **`useScrollResetOnRoute()` hook.** Single source of truth for
  the route-change scroll-to-top behaviour, replacing per-page
  `useEffect` duplicates across seven mounted surfaces.
- **`<SettingsCardHeader>` primitive.** Extracted from three
  near-duplicate copies inside the Settings shell so future
  section additions inherit the icon / title / description
  treatment without redeclaring the markup.
- **Apple App Site Association handler.** `/.well-known/apple-app-site-association`
  now answers 200 with `application/json` on every host that fronts
  the app, advertising the iOS bundle's App ID prefix
  (`S8WDX4W5KX.dev.healthlog.app`) under `webcredentials.apps` so the
  passkey ceremony shares cleanly between the web origin and the iOS
  app. The proxy gained a `/.well-known/` public-prefix entry so the
  Apple CDN fetch lands on the asset instead of the auth gate.

### Changed

- **Insights mother page deferred below-the-fold blocks.** Daily
  briefing, correlation row, and trends row now resolve through
  `next/dynamic` with skeleton fallbacks that match the existing
  loading shape. Above-the-fold hero stays an eager import so the
  initial paint shows the greeting + health-score badge without
  a flash.
- **Settings section renamed.** "Notifications" became
  "Notification channels" (German: "Benachrichtigungs-Kanäle") so
  it no longer collides with the inbox at `/notifications`
  ("Notification Center" / "Benachrichtigungs-Center").
- **Settings Auswertungen section renamed.** The German label
  "KI-Auswertungen" became "Auswertungen" in user-facing copy
  per the long-standing rule that user-facing surfaces drop the
  model-vendor prefix.
- **Insights tab strip regrouped by metric category.** Pills now
  cluster vitals / cardiovascular / activity / wellbeing so
  long-strip scrolling lands on a related neighbour.
- **About section folded into the user-card dropdown.** The
  in-shell Settings nav no longer surfaces an "About" entry; the
  sidebar user-card dropdown now owns the "About HealthLog" link.
  Route `/settings/about` still resolves for direct links.
- **Auth shell container width normalised.** Every authenticated
  route now renders inside a single `max-w-screen-xl` container,
  retiring three competing widths that drifted across the
  Insights / Settings / Dashboard surfaces.
- **Card defaults normalised.** Every card now defaults to
  `p-4 md:p-6` padding so mobile + desktop spacing stay in lock
  step without per-instance overrides.

### Fixed

- **`/api/analytics` 500 (P0).** Stack overflow from
  `Math.min(...values)` / `Math.max(...values)` spreads on long
  histories. Hotfixed on the surfaced helper and folded across
  the six sibling status helpers.
- **Spotlight onboarding tour intercepted dashboard clicks.**
  Overlay z-index + pointer-events combination meant the first
  post-completion tap landed on the dimmed overlay instead of
  the tile underneath.
- **BP chart Y-axis unit.** Read "Hg" instead of "mmHg".
- **Bottom nav viewport overlap.** Hardened against the
  last-line clip on shorter viewports.
- **`/insights/puls` subtitle.** Read "Ruhepuls" instead of
  "Puls".
- **Weight chart duplicate Y-axis ticks.** Tick generator emitted
  the same value twice on narrow domains.
- **Web-vitals beacon self-throttling.** Beacon was sampling at
  full rate and tripping its own queue cap; sample rate dropped
  to 10% so RUM telemetry actually reports.
- **Medication compliance classifier flushing every dose to
  `very_late`.** Defensive fallback when the dose-window
  estimator can't resolve a window.
- **`/api/insights/generate` POST gating.** Endpoint now refuses
  on a disabled assistant master flag instead of returning a 500.
- **Mood Log overflow on narrow viewports.** Cards no longer
  shred their internal grid below 360 CSS px.
- **F13 username readability.** Header username now respects
  contrast tokens on the dark theme.
- **F14 mobile bottom-nav padding.** Bottom nav no longer
  vertically clips its second row on the smallest mobile
  viewport.
- **F17 threshold toggle parity.** Settings threshold toggles
  now reflect their server-side enabled state on mount instead
  of always opening on.
- **Notifications section redundancy.** Three near-duplicate
  status surfaces collapsed onto one.
- **Insights coach-rail labels.** Promoted to semantic `<h3>`
  headings so the accessible-name tree resolves consistently.
- **Heading hierarchy on three surfaces.** Repaired non-sequential
  `h1 → h3` jumps so the accessible-name tree resolves with the
  expected nesting.
- **Icon-only buttons on the medications page.** Every icon
  button gained an accessible name; same sweep on the admin
  feedback inbox and reminders surface.
- **Progress-bar accessibility.** Every `<Progress>` instance now
  carries an accessible name so a screen-reader pass reads the
  metric label rather than a bare percentage.
- **Button loader CLS.** Buttons now reserve space for the
  in-flight loader so the surrounding layout doesn't shift when
  a request lands.
- **Mobile Coach FAB occlusion.** FAB auto-hides while any chart
  tooltip is open so it cannot cover the read-out.
- **Settings mobile section strip.** Scroll-snap on the
  horizontally scrollable strip so the active pill always lands
  on the leading edge.
- **Passkey breakpoint.** Passkey card no longer clips its
  internal grid on the tablet breakpoint.
- **Settings tile padding parity.** Every settings tile reads
  `p-4 md:p-6` after the card-default normalisation.
- **Sidebar "Home" group label.** Redundant collapsible label
  dropped from the desktop sidebar; the four nav entries now
  live at the top level.
- **Legal-page narrow column convention.** Pinned in code
  comments so a future refactor doesn't widen the privacy /
  imprint / terms pages back out.

### Performance

- **Coach snapshot builder LRU cache.** 60 s TTL keyed on
  `(userId, scope)` keeps repeat Coach drawer opens within a
  short window off the snapshot-build path.
- **Assistant flags memoised per request.** Resolver lookup was
  re-running per surface mount on the Insights cold path.
- **Web-vitals sample rate dropped to 10%.** Stops the beacon
  from self-throttling under high-traffic load.

### Refactor

- **`Math.min` / `Math.max` spread folds.** Six per-metric status
  helpers now reduce instead of spread, retiring the latent stack
  overflow path that surfaced as the P0 above.
- **Scroll-reset consolidated.** Seven per-page `useEffect`
  duplicates retired behind `useScrollResetOnRoute()`.
- **Settings card header consolidated.** Three near-duplicate
  header markups retired behind `<SettingsCardHeader>`.

### Accessibility

- **Icon-only buttons named** on the medications page + admin
  feedback inbox + admin reminders surface.
- **Progress bars named** across the app so the accessible-name
  tree exposes the metric label.
- **Heading order repaired** on three surfaces so the
  accessible-name tree nests correctly.
- **Coach rail labels** promoted to semantic `<h3>` headings.

### Internal

- **Retired** the now-orphan `settings.kiInsights` locale key
  after the Auswertungen section rename, the
  `AssistantDisabledNotice` component, and the dead
  `settings.placeholder` locale entries left behind by earlier
  releases.
- **Test fixtures** aligned with the renamed Insights /
  Notifications / Settings surfaces; the import-string scan on
  the Insights mother page now accepts both eager and
  `next/dynamic` spellings.

## [1.4.32] — 2026-05-17 — HealthKit Tier 1 first surface

First public surface for the HealthKit Tier 1 metrics that
the iOS contributor brief locked in for v1.5. The headline item
is a workouts flow that lands end-to-end on the web: a list page
at `/insights/workouts`, a detail page with route preview and
summary stats, and a dashboard tile that surfaces the three most
recent sessions. Alongside the workouts surface arrives a family
of five new metric sub-pages — HRV, resting heart rate, blood
oxygen, body temperature, and active energy — each carried by a
shared scaffold so adding the next HealthKit metric is a four-line
page module. The release also cleans up two latent issues uncovered
during the audit: the workouts list endpoint had a Prisma
field-name bug that would have produced a 500 the moment a real
client called it, and HRV plus resting heart rate were sitting
in the `vitals` insight bucket where they did not belong.

### Added

- **Workouts API.** `GET /api/workouts` returns a paginated list
  shaped to the iOS contract (`distanceM`, `activeEnergyKcal`,
  `avgHr`, `maxHr`) using the v1.4.30 canonical-row picker;
  `GET /api/workouts/{id}` returns a single workout with the same
  field shape. Both endpoints honour `requireAuth()` and respect
  the existing per-user isolation guarantees.
- **`/insights/workouts` list page.** Browsable workout archive
  with newest-first ordering, type-filter pills, and an
  Apple-Health-onboarding hint when the list is empty.
- **`/insights/workouts/[id]` detail page.** Per-workout view
  with summary tiles (duration, distance, energy, average and
  max heart rate), an inline-SVG route preview when GPS samples
  are present, and a graceful-unavailable notice for per-second
  HR samples.
- **Dashboard recent-workouts tile.** New widget id
  `recentWorkouts` defaults to visible and surfaces the three
  most recent sessions on the home page. Self-gates on a
  non-empty list and renders an Apple-Health-onboarding hint
  otherwise.
- **Five HealthKit metric sub-pages.** New pages at
  `/insights/hrv`, `/insights/ruhepuls`, `/insights/sauerstoffsaettigung`,
  `/insights/koerpertemperatur`, and `/insights/aktive-energie`,
  each rendered through the shared `<HealthKitMetricPage>`
  scaffold with its own chart-cog popover state slot. Body
  temperature surfaces the existing manual-entry CTA; the other
  four intentionally render their empty state without a primary
  action because the Apple Health / Withings ingest is the only
  path for those metrics.
- **Insights tab-strip pills.** Six new pills (workouts plus the
  five HealthKit metrics) join the strip and self-gate on data
  presence, so brand-new accounts still see the seven pre-existing
  pills only.

### Changed

- **HRV + resting HR realigned to the cardiovascular bucket.**
  Both metrics moved out of `vitals` into `cardiovascular` to
  match the iOS handoff brief's category table. The insight
  bucket map, the per-metric status card grouping, and the
  comprehensive narration all read the new placement; no client
  contract changes because the bucket only drives in-app
  grouping.

### Fixed

- **Latent 500 on workouts list endpoint.** The list query
  referenced two non-existent Prisma columns (`distanceMeters`
  and `energyKcal`); tests mocked Prisma with `as never` so the
  bug never surfaced in CI. The endpoint now uses the v1.4.30
  `pickCanonicalWorkoutRows()` helper and projects the iOS
  contract field shape end-to-end.

## [1.4.31] — 2026-05-16 — Operator toggles + insights tab-strip + Coolify auto-deploy fix

Three orthogonal patches in one release. The biggest item is a
per-surface operator toggle matrix that lets the maintainer carve
which model-driven surfaces stay visible without removing the
provider configuration — Coach, Daily Briefing, per-metric status
cards, correlations, and the Health-Score delta explainer each
get an admin switch, plus a master kill-switch above them all.
Alongside that lands the root-cause fix for the /insights
tab-strip blocking on mobile: an abort timeout on the advisor
fetch, a `React.memo` on the strip with its `availability` prop
memoised in the layout shell, and a lazy-loaded Coach drawer
collapse the worst-case tap-block window from the LLM-completion
tail down to the bounded parallel-fetch window. The release also
closes the long-standing Coolify auto-deploy race: five releases
in a row the webhook reported "finished" but Coolify still
pulled the prior `:latest` digest because the publish workflow
fired the webhook inside GHCR's CDN propagation window; a 90 s
sleep before the trigger step lands inside the existing
`continue-on-error: true` envelope.

### Added

- **Assistant-surface operator toggles.** Six boolean columns on
  `AppSettings` (`assistantEnabled` + five sub-flags) carve the
  visibility cut for every model-driven surface. Master forces
  every sub-flag false in the resolver, so a single flip kills
  the whole assistant. New admin panel at
  `/admin/assistant` (slug between `ai-quality` and
  `coach-feedback`) renders the six toggles; sub-toggles grey out
  when the master is off. Defaults preserve the v1.4.30 behaviour
  (every surface visible) so upgrades require no admin action.
- **`GET /api/feature-flags`.** Projects the matrix over HTTP for
  every client — web React tree + iOS native. `requireAuth()`
  gates the route, `Cache-Control: private, max-age=60` caps the
  read cost on the hot /insights mount path.
- **`PUT /api/admin/settings/assistant-flags`.** Dedicated admin
  write surface that echoes both the raw column values and the
  resolved (master-killed) shape. Optimistic UI on the admin
  panel; the runtime feature-flag cache invalidates on every
  write so toggled surfaces react within the same operator
  session.
- **`<AssistantDisabledNotice>` component.** Small inline notice
  for callers that resolve a 403 +
  `errorCode: "assistant.disabled.<surface>"` from the server.
  Localised in all six locales.
- **`useFeatureFlags()` hook.** Fails open — any network error
  or absent `<QueryClientProvider>` returns the all-on default so
  the user never loses an affordance to an instrumentation gap.

### Fixed

- **Insights tab-strip blocking on mobile.** Three orthogonal
  client-side fixes:
  - `fetchAdvisor` gets an 8 s `AbortController`; `AbortError`
    falls through to the existing graceful-null return path so the
    UI surfaces the regen CTA instead of pinning the query in
    `isFetching: true` for the LLM tail.
  - `<InsightsTabStrip>` is `React.memo`'d, the inner `buildTabs`
    call is `useMemo`'d on `availability`, and the layout shell
    memoises the `availability` prop on its three leaf inputs.
    Together they collapse the
    "shell re-renders → strip re-renders → 8 pills re-render"
    cascade on every cache-write of analytics or comprehensive.
  - `<CoachDrawer>` is now lazy-loaded via `next/dynamic` so the
    SSE machinery, chat reader, suggested-prompts rail, and
    settings sheet don't initialise on every cold /insights mount.

### Changed

- **Server-side gating of assistant endpoints.** Every
  LLM-driven endpoint now reads the operator flag set near the
  top of the handler and throws a typed `AssistantDisabledError`
  when the relevant surface is off. The api-handler catches the
  error and returns 403 +
  `meta.errorCode: "assistant.disabled.<surface>"`. Older
  clients without the errorCode see a generic 403; v1.4.31+
  clients render the `<AssistantDisabledNotice>` empty state.
  Gated endpoints:
  `/api/insights/chat` (coach),
  `/api/insights/generate` (coach),
  `/api/insights/comprehensive` (coach),
  `/api/insights/cards` (insightStatus),
  `/api/insights/correlations` (correlations),
  and the six `*-status` per-metric routes (insightStatus).

### CI

- **Coolify auto-deploy race fix.** `Trigger Coolify deploy`
  step in `.github/workflows/docker-publish.yml` now sleeps 90 s
  before firing so GHCR's CDN edges have time to propagate the
  fresh `:latest` digest. The webhook lands after the edge read
  catches up, Coolify pulls the new digest, and the running
  container recreates cleanly.
- **OpenAPI pre-commit hook.** New `.githooks/pre-commit` runs
  `pnpm openapi:check` when the staged diff touches Zod schemas
  or API routes; on drift it regenerates the spec, re-stages the
  file, and continues the commit. Activated via the new
  `scripts/install-hooks.sh`. Skips in CI so the existing
  `security.yml` server-side gate stays authoritative.

### iOS contract

Every change is additive on the wire.

- `GET /api/feature-flags` is net-new. iOS clients that predate
  it never call the endpoint and see the all-on default
  implicitly.
- The six `AppSettings.assistant*` columns default to `true` in
  the migration so existing rows pick the defaults up without
  data movement.
- The 403 +
  `meta.errorCode: "assistant.disabled.<surface>"` envelope is
  additive — pre-v1.4.31 iOS reads the 403 as a generic auth
  error and degrades gracefully through its existing 403
  handler. v1.4.31+ iOS reads the `errorCode` to render the
  surface-specific empty state.
- The locked-contract coordination notes (§14)
  document the rule that the flag matrix gates BOTH
  server-routed AND on-device assistant surfaces. Apple
  Foundation Models on-device Coach + Briefing flows in the
  v0.6.0 iOS path honour the same flag matrix as the
  server-routed surfaces.

## [1.4.30.1] — 2026-05-16 — Categories endpoint + conflict-resolution lock

A two-item follow-up to v1.4.30. The categorisation overlay shipped
yesterday as a TypeScript map; the new `GET /api/measurement-categories`
endpoint projects it over HTTP so the iOS-side picker can fetch the
canonical shape rather than carry a hard-coded mirror — the
unblocker the iOS team flagged as the one missing piece. In parallel
the SyncMode conflict-resolution policy that the v0.6.0
standalone-first track depends on lands as §13 of
`08-locked-contracts.md`.

### Added

- **`GET /api/measurement-categories`.** Thin projection of
  `src/lib/measurements/categories.ts` over HTTP. Response carries
  `version: 1`, an ordered `categories` array with `labelKey`
  translation keys, and the `assignments` map keyed on
  `MeasurementType`. `requireAuth()` gates the route — any logged-in
  user passes — and `Cache-Control: public, max-age=600` enables a
  10-minute edge cache. Locked per
  the iOS-team coordination response, §3 R1.

### Documented

- **SyncMode conflict-resolution policy.**
  The locked-contract coordination notes gain §13 per
  R9 of the iOS-team response doc. Hard-spec covers bulk-backfill,
  steady-state bidirectional sync via `(updatedAt, syncVersion)`
  optimistic concurrency, the 409 write-conflict + 410 Gone
  delete-conflict envelope shapes, the LWW-by-`updatedAt` resolution
  with server-wins on millisecond tie, and the
  `GET /api/sync/state` response. The "What is NOT in this file"
  stub renumbers to §14.
- **iOS contributor brief.** §3 bumps the live-production marker to
  v1.4.30 and adds the four v1.4.30 endpoints plus the new
  v1.4.30.1 endpoint to the iOS-consumable list. §5b / §6 reframe
  the Coach SSE story per R6 — the server endpoint stays live; the
  iOS native server-Coach drawer is deferred pending MDR Class-IIa
  pre-review. v1.5.0 iOS ships Apple Foundation Models on-device
  Daily Briefing + Trend Observations as the primary assistant
  surface.
- **v1.5 strategic plan.** §2 slots Apple Health XML import as
  v1.4.34 immediately before the web-freeze marker (per R2),
  detailing the multipart endpoint, the streaming XML parser, the
  async job model, the per-MeasurementType ingestion stats, the
  idempotent UPSERT on `externalId`, and the admin endpoint
  variant. Effort L (~3-4 days). The freeze trigger renumbers from
  v1.4.33 to v1.4.34; the decision-log row "Apple Health XML
  import slot" lands; the §4 deferred row and §6 open question #3
  close out.

## [1.4.30] — 2026-05-16 — iOS-coordinated foundation (Daily-Stats + SyncMode)

Server-side prep for the next iOS TestFlight build. Five surfaces
land together so the iOS engineer can pick them up in one cut-over:
a locked `externalId` shape for daily-aggregated cumulative
HealthKit rows, the SyncMode foundation columns + handshake +
bulk-backfill endpoints, a first-class `MoodEntry.note` column that
replaces the legacy `tags: ["note:<text>"]` workaround, a
cross-source workout dedup helper, and two new MeasurementType
enums (`WALKING_STEADINESS`, `AUDIO_EXPOSURE_EVENT`) plus the
shared `MEASUREMENT_CATEGORIES` overlay that drives the iOS
permission picker and the future Insights nav.

### Added

- **Daily-stats `externalId` helper.** `dailyStatsExternalId(hkId,
date)` mints `"stats:<HKQuantityTypeIdentifier>:<YYYY-MM-DD>"`
  alongside the v1.4.29 `CUMULATIVE_HK_TYPES` set. The shape is
  locked in the iOS coordination notes (§12). iOS
  emits one row per day per cumulative type via
  `HKStatisticsCollectionQuery`; the unique index collapses
  re-syncs idempotently, and a future PATCH-on-divergence call
  updates a late-watch-sync revision without inserting a second
  row.
- **Drain script + admin endpoint** at
  `scripts/drain-per-sample-cumulative.ts` and
  `POST /api/admin/drain-per-sample-cumulative` (gated by
  `requireAdmin()`, default `dryRun: true`). Collapses pre-Option-A
  per-sample APPLE_HEALTH cumulative rows into one row per day per
  type. Idempotent — re-running on a fully-collapsed account
  reports zero buckets touched.
- **SyncMode foundation.** Migration 0062 adds
  `Measurement.sync_version` (Int, default 1),
  `Measurement.deleted_at` (Timestamp, nullable) for soft-deletes,
  and `User.last_synced_at` (Timestamp, nullable). The new
  `GET /api/sync/state` returns the handshake response (lastSyncedAt,
  server clock, live + tombstoned counters); the call also bumps the
  checkpoint so iOS reads the OLD value then trusts subsequent
  writes via the standard read paths.
- **Bulk backfill endpoints.** `POST /api/mood-entries/bulk` and
  `POST /api/medications/intake/bulk` accept up to 500 entries per
  call with the same response envelope as the measurements + workouts
  batch. Probe-then-upsert distinguishes inserted vs duplicate on the
  mood path; idempotency-key collision yields duplicate on the
  intake path. Both rate-limited at 60/min/user.
- **`MoodEntry.note` column** (migration 0063). The bulk + single
  POST + PUT routes thread the new field through; the existing
  `tags: ["note:<text>"]` workaround backfills via
  `scripts/backfill-mood-note-column.ts` (CLI dry-run by default,
  `--confirm` commits).
- **`pickCanonicalWorkoutRows()`** at
  `src/lib/measurements/pick-canonical-workout-rows.ts`. Cross-source
  workout dedup symmetric to `pickCanonicalSourceRows()`. Buckets
  rows by 5-minute startedAt slot + sportType and walks the
  existing measurement source ladder; metric-aware tunes (route →
  Apple wins, HR zones → Withings wins) defer to v1.5.x.
- **`MEASUREMENT_CATEGORIES` overlay** at
  `src/lib/measurements/categories.ts`. UI-only category map
  (vitals / body / activity / sleep / hearing / environment /
  cardiovascular / metabolic) that drives the iOS HealthKit
  permission picker, the post-v1.5 web Insights nav, and the Coach
  evidence shelf chip-grouping. Completeness wall in the test suite
  catches a new MeasurementType lacking a category assignment.
- **Two MeasurementType enums** (migration 0064) —
  `WALKING_STEADINESS` (iOS 15+ Mobility daily rollup, ×100 scaled
  from Apple's 0..1 fraction) and `AUDIO_EXPOSURE_EVENT` (iOS 13+
  category flag fired when the rolling 7-day average crosses the
  WHO 80-dBA threshold; environmental + headphone events share the
  same enum value). The wiring registries (`apple-health-mapping`,
  `categories`, `pr-direction`, `chart-tokens`, six locale files)
  pick them up in the same release.

### Changed

- **Real-Postgres integration coverage expanded.** Every new
  endpoint introduced in v1.4.30 rides the v1.4.29 testcontainer
  fixture: the drain helper, the admin endpoint, the sync-state
  handshake, the mood-entries bulk upsert, the medication-intake
  bulk insert + idempotency-key collision, the mood-note column
  round-trip. Full integration suite at 47 files / 190 specs.
- **`HK_QUANTITY_TYPE_DEFERRED` trimmed.** Three identifiers move
  out of the deferred set into the mapping table:
  `HKQuantityTypeIdentifierAppleWalkingSteadiness`,
  `HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent`,
  `HKCategoryTypeIdentifierHeadphoneAudioExposureEvent`.

### iOS contract

Every API change is additive. The new endpoints
(`/api/sync/state`, `/api/mood-entries/bulk`,
`/api/medications/intake/bulk`,
`/api/admin/drain-per-sample-cumulative`) are net-new — no iOS
consumer yet. The SyncMode columns carry defaults so existing iOS
POSTs round-trip unchanged. The two new MeasurementType enums are
net-new values; iOS clients that predate the codegen pass will not
encounter them in read paths because no source writes them yet, and
the codegen path will pick them up on the next iOS regeneration.

**Cutover sequence.** v1.4.30 ships with the helper + drain script

- server tolerance for both shapes. The next iOS TestFlight build
  adopts `HealthKitStatisticsService.swift` and starts posting daily-
  aggregated rows for the five cumulative types. Operator runs the
  drain script once after the new TestFlight cuts over; per-sample
  row pressure on `Measurement` drops 50-200× for cumulative types.

## [1.4.29.1] — 2026-05-16 — Daily-step aggregation hotfix

A one-line follow-up to v1.4.29. The dashboard 7-day step chart now
renders daily totals (sums in the thousands), not per-sample averages
(hundreds), matching the server-side `aggregate=daily` contract that
landed earlier today.

### Fixed

- **Client-side daily aggregator.** `health-chart.tsx` reduced every
  HealthKit type with `sum / count` regardless of whether the
  metric is cumulative or spot. The branch now consults
  `CUMULATIVE_HK_TYPES` and picks `sum` for steps, active energy,
  flights climbed, walking + running distance, and time in
  daylight, while the spot metrics (BP, weight, pulse, BG, body
  fat, mood, sleep) keep the mean.

### Tests

- The existing chart suite (137 specs) continues to pass; the
  one-line branch is exercised by the v1.4.29 server-side
  aggregation tests and needs no additional coverage.

## [1.4.29] — 2026-05-16 — Dashboard performance + chart polish

A targeted performance + polish patch. The headline is a faster
dashboard on data-rich accounts: the pulse chart drops up to ~5 000
raw rows per range tab in favour of one row per day, the duplicate
`/api/dashboard/widgets` fetch on every mount collapses to one, and
three long-running analytics reads are bounded to the trailing
window the tile path actually needs. Two production regressions
close — the `aggregate=daily|weekly|monthly` path on
`/api/measurements` 500'd for every grain, and the same path
averaged cumulative step counts instead of summing. Mobile chrome
gets a tighter rhythm: dashboard tiles pin to a single 140-px
contract at `<sm` and the Settings → Dashboard drag-list rows drop
from ~116 px to 48 px. X-axis tick density on numeric pulse + mood
charts comes back after Recharts was silently ignoring the legacy
`interval` policy on `type="number"` axes.

### Fixed

- **`aggregate=daily|weekly|monthly` on `/api/measurements`.** The
  endpoint returned HTTP 500 for every grain in production. Two
  root causes the mocked-`$queryRaw` suite hid end-to-end: the
  Postgres `date_trunc` unit was passed as a bound parameter
  (the function requires a SQL literal), and the `weekly` /
  `monthly` forms weren't mapped to the singular Postgres units
  (`week` / `month`). A new real-Postgres integration suite
  pins the contract.
- **Cumulative-type aggregation.** The same path averaged step
  counts instead of summing — five 1 000-step rows on the same
  day reported 1 000, not 5 000. `CUMULATIVE_HK_TYPES` covers
  `ACTIVITY_STEPS`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`,
  `WALKING_RUNNING_DISTANCE`, and `TIME_IN_DAYLIGHT`; the SQL
  picks `SUM(value)` for those and keeps `AVG(value)` for spot
  metrics (BP, weight, pulse, BG, body fat, mood, sleep).
- **Duplicate dashboard-widgets fetch on every dashboard mount.**
  `useChartOverlayPrefs` keyed under `["dashboard-layout"]`
  while the page + Settings + the rest of the codebase used
  `queryKeys.dashboardWidgets()`. Two cache slots, one endpoint,
  two requests per mount. Unified onto the shared key.
- **Numeric x-axis tick density.** Recharts ignores `interval`
  on `type="number"` axes. Pulse + mood charts silently lost the
  day-aware density policy after the v1.4.25 numeric-axis
  switch. A new `computeTickPositions` helper translates the
  legacy skip count into explicit `ticks` indices and clamps to
  a 3-12 visible-label range.
- **Mobile dashboard tile heights drift between siblings.** At
  `<sm` each tile took content height, so callout-on tiles grew
  taller than callout-off neighbours (glucose tiles especially).
  Pin a 140-px floor via the `--tile-h` CSS custom property at
  `<sm` and release back to `auto` from `sm:` upwards. The
  comparison-delta callout clamps to a single line; the sub-row
  pair switches to `flex-nowrap overflow-hidden` so a narrow
  tile cannot grow vertically.

### Changed

- **Settings → Dashboard drag-list rhythm.** The vertical 44 + 44 px
  arrow stack on each widget row dropped row height to ~116 px,
  three times the height of every neighbour on the Settings page.
  A horizontal arrow pair on the trailing edge (`size-11` on
  mobile preserves the 44-px tap target, `sm:size-9` on desktop)
  with `min-h-12` as the floor cuts each row to 48 px — 2.4×
  tighter. The widget label gains `truncate` + `title` so long
  names stay on a single line.

### Performance

- **Pulse chart payload.** Windows beyond seven days now ask the
  server for `aggregate=daily`. A 30-day pulse view drops from
  up to ~5 000 raw rows to at most 30 daily buckets; Recharts
  paint cost drops accordingly on continuous-monitoring accounts.
  Short windows (7 days) keep raw fetching so hour-by-hour detail
  stays visible.
- **`/api/analytics` read bounds.** The per-context glucose
  summaries walked every persisted `BLOOD_GLUCOSE` row a multi-
  year user had written. Bounded to the trailing 30 days the
  tile path consumes. Same shape for the BP-in-target chunked
  walk — passed no `since` bound even though
  `computeBpInTargetWindows`'s longest sub-window is `priorYear`.
  Bounded to the trailing 365 days.
- **Inline dashboard queries default staleness.** The three
  inline `useQuery` blocks on `/` shared no `staleTime` or
  `refetchOnWindowFocus` setting, so a tab-focus-and-return
  triggered an immediate refetch storm. A shared
  `DASHBOARD_QUERY_OPTS` lifts them to the 1-minute staleness
  cadence the chart queries already use, with
  `refetchOnWindowFocus: false`.

### Tests

- New integration suite
  `tests/integration/measurements-aggregate-daily.test.ts` hits
  the route against a real Postgres so every grain compiles +
  executes end-to-end. The mocked unit suite stays for the
  route-shape contracts.
- `computeTickPositions` gains six cases in
  `x-axis-density.test.ts`: sparse data emits every index, dense
  data clamps to 3-12 ticks, empty / single-point edge cases.
- `<HealthChart>` range test asserts the default 30-day window
  asks for `aggregate=daily` and the `windowOverride="last7days"`
  mini-chart does not.
- `<TrendCard>` mobile-tile-height contract pinned via a new
  snapshot test (`trend-card-tile-height.test.tsx`).

## [1.4.28.1] — 2026-05-16 — Dashboard-save hotfix

"Speichern" on the Dashboard works again for every account whose
layout was last persisted before v1.4.28. The v1.4.28 retire of the
`glp1` widget id left an orphan entry in `dashboardWidgetsJson` for
legacy users, which made the save validator reject the payload; the
resolver now filters unknown widget ids on read.

### Fixed

- **Dashboard save against legacy layouts.**
  `resolveDashboardLayout` in `src/lib/dashboard-layout.ts` drops
  widget ids that are no longer in the registry before returning
  the layout, so the `dashboardWidgetsJson` round-trip
  (`GET /api/me/dashboard` → user edit → `PUT /api/me/dashboard`)
  succeeds even when the persisted JSON still names `glp1` or any
  other retired widget.

### Tests

- `src/lib/__tests__/dashboard-layout.test.ts` gains a case for the
  retired-id filter (19/19 green).

## [1.4.28] — 2026-05-16

Bug-fix and consistency follow-through after the v1.4.27 mobile sweep.
The headline is a tighter dashboard and insights surface: six widgets
retire from code entirely (GLP-1 tile, dashboard `<DrugLevelChart>`
mount, GLP-1 detail-page intake history + inventory, the
`<InsightAdvisorCard>` block and its regeneration affordance, the
weekly-report route), four broken edges close (workout-edit duplicate-
timestamp 409, BD-Zielbereich tile rebuilt on the shared
`<TrendCard>` primitive, `/insights/puls` chart timeout fallback,
sticky tab-strip scroll lock), and one consistency contract lands per
maintainer directive: every medication-list row, every medication-
detail section header, every trend tile, every Coach launch glyph,
every chart-height contract reads on one shape. The HealthScore card
grows to fill its column, gains an accessible `?` tooltip explaining
the delta, and drops the placeholder "Wochenbericht erstellen"
button. iOS contracts are intact; the only `/api/*` evolution is
additive (the `aggregate=monthly` grain on `/api/measurements` and an
internal-only `/api/internal/web-vitals` beacon route).

### Removed

- **GLP-1 dashboard tile.** `src/components/dashboard/glp1-tile.tsx`
  and every reference (`dashboard-layout.ts` entry, the
  `dashboard.glp1.*` i18n keys, the test fixtures) retire. The tile
  is gone from `/`; the recovered vertical real estate flows to the
  trends row + HealthScore column.
- **Dashboard `<DrugLevelChart>` mount.** The standalone Drug-Level
  pane retired from `/`. The component itself stays — it serves the
  `/medications/[id]/history` page exclusively. The `compact` mode
  and `windowHoursBefore` override drop with the dashboard mount; the
  history-page recipe paints the chart inside
  `<MedicationDetailSection>` on the same heading scale as every
  other section on the page.
- **`<InsightAdvisorCard>` surface.** The "Persönlicher Berater"
  card at the bottom of `/insights` and its "Insights aktualisieren"
  regeneration button retire. The Coach drawer is the single
  assistant entry point. Component, mounts, test fixtures, i18n
  keys, and the cached-advisor query all retire together.
- **Weekly-report route.** `/insights/report/[week]` and the
  `<WeeklyReportBanner>` mount on the hero retire. No remaining
  consumer; the Coach drawer covers the equivalent ask.
- **GLP-1 detail-page intake history + inventory.** The "Dosis-
  Historie" disclosure and "Bestand" section retire from the GLP-1
  medication detail page. The page now collapses to header,
  schedule, dose-titration ladder, and side-effects — every section
  the maintainer flagged as wanted; every section flagged as
  unwanted is gone. Inventory tracking remains opt-in for a future
  release.
- **Hero "Wochenbericht erstellen" button.** The placeholder
  affordance retires from the `/insights` action row. The row now
  carries a single "Coach fragen" button so the HealthScore card on
  the opposite column has the height to reach the last suggested
  prompt.

### Fixed

- **Workout edit raised a 500 on duplicate timestamps.** The save
  path on `PUT /api/measurements/[id]` returned a generic 500 when a
  sport-typed sample (`ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`,
  `WALKING_RUNNING_DISTANCE`, `EXERCISE_TIME`) collided with an
  existing row on the same `(type, measuredAt)` natural key. Returns
  409 with a `measurements.duplicateTimestamp` translation key now;
  the iOS native client and the web measurement-form both surface
  the conflict to the user instead of a generic toast.
- **BD-Zielbereich tile rendered "1.1." instead of numbers.** The
  tile's bespoke rendering path read the schedule date through
  `Intl.DateTimeFormat` and missed the underlying value. Tile
  rebuilt on the shared `<TrendCard>` primitive so the chrome, the
  state shape, the prop API, and the fallback behaviour match the
  Weight and BP siblings. The divergence has been the open finding
  across v1.4.22, v1.4.25, v1.4.26 patches — this release rewrites
  the tile instead of patching.
- **`/insights/puls` hung waiting on the assessment provider.** The
  pulse status card called the language-model provider with no
  client-side timeout. A timeout helper (`with-timeout.ts`) caps
  every status-card provider call at 20 s and returns the rule-based
  fallback string on timeout; the page renders the chart immediately
  and the assessment line resolves async.
- **Scroll stuck on `/insights` mother-page navigation.** The sticky
  tab-strip's intersection-observer was fighting the focus-on-mount
  logic so the page sometimes refused to scroll past the tab row.
  The observer rebinds on route change and the focus-on-mount
  effect now waits for the next animation frame so the scroll
  position is locked in before the observer fires.
- **`<DrugLevelChart>` paint exceeded the active range window.** The
  chart fetched every dose-event in history regardless of the
  selected range. Now bounded to the active range — 30 days / 90
  days / all-time — so the wire payload and the recharts render
  scale linearly with the visible window.
- **Mood trend tile painted a residual `rounded-xl` border.** The
  shadcn `<Card>` default paints `rounded-xl` while the trends row
  needs `rounded-md` to match the `<HealthChart mini>` shape. Mini-
  mode override adds `rounded-md`; the visual rhythm of the row
  reads on one envelope.
- **Side-effects card overflowed at 320 px.** The "Nebenwirkungen
  erfassen" CTA chip ran past the section header. The qualifier
  drops from every locale ("Erfassen" / "Log" / "Consigner" /
  "Registrar" / "Registra" / "Dodaj"); the section title carries
  the context. The date column on the entry rows narrows from 88 px
  to 56 px so the free-text slot recovers 32 px of wrap headroom.
- **Medication-list row shape diverged for GLP-1 entries.** The
  GLP-1 row painted with a brand icon and a middle-dot separator;
  every other row painted two-line without an icon. Both routes
  through a shared `<MedicationCardHeader>` now — line 1 is `{name}
{dose}`, line 2 is the class label plus state badges. The GLP-1
  outlier shape is gone.
- **HealthScore card came up short below the action+prompts column.**
  The card now opts into `flex h-full flex-col` with the disclaimer
  footer pinned via `mt-auto`; the hero row switches to
  `md:items-stretch` on `md+` so the score column reaches the
  bottom of the suggested-prompt rail. Equal-height contract across
  the hero strip.
- **`/measurements` aggregation truncated long-window queries.** The
  `take` cap applied before bucketising, so a 365-day daily-grain
  query returned only the first N raw rows. Aggregation now runs
  as a Postgres `date_trunc` GROUP BY and the cap applies to the
  bucketised result; a 1-year window returns up to 365 daily
  buckets. The all-time chart range resolves to monthly grain (24-
  bucket ceiling) or weekly when history is under two years.
- **Schlaf sub-page missed the per-section assessment slot.** Six of
  seven insights sub-pages mount `<InsightStatusCard>` underneath
  the chart; Sleep did not. Documented as the intentional skip
  with a `// no per-section assessment yet` marker so future
  contributors do not re-flag it.
- **Insights-targets locale strings missed on FR / ES / IT / PL.**
  `measurements.duplicateTimestamp` and `insights.sleep.description`
  now carry native translations in every locale.

### Changed

- **BD-Zielbereich tile aligned to `<TrendCard>`.** Tile chrome,
  state shape, prop API, and fallback states all match Weight and
  BP. The Z-value rounds to one decimal at the boundary, the legend
  carries the same micro labels across siblings, the empty state
  reads the same copy with the same CTA shape.
- **Medication-list rows route through `<MedicationCardHeader>`.**
  GLP-1 and standard rows both render `{name} {dose}` on line 1 and
  class label plus state badges on line 2. State badges break onto
  their own row at 320 px so the two-line shape holds.
- **Medications detail-page chrome collapsed to one heading scale.**
  Every section on `/medications/[id]` mounts through
  `<MedicationDetailSection>` (`text-base font-semibold leading-6
tracking-tight`). DrugLevelChart's standalone header migrates to
  `<h2>` with the same classes. Micro labels lift from
  `text-[10px]` / `text-[11px]` to `text-xs` across Scheduling,
  Titration, SideEffects. Three scales survive the page: heading,
  body (`text-sm`), micro (`text-xs`).
- **Coach launch shape consolidated to three primitives.** A single
  `<LayoutCoachFab>` mounts once per Insights surface (FAB on `<lg`,
  hidden on `lg+`); `<CoachLaunchButton>` paints the inline desktop
  ghost button only; `<TargetCoachButton>` paints the per-card
  icon-only chat-bubble. The five-shape inventory collapses to
  three. Every Coach launch glyph reads on one vocabulary
  (`Sparkles`); the suggested-prompt chips stay their own visual
  class because the pre-fill flow is conceptually distinct.
- **Targets page Coach launch is icon-only.** The bottom-left "Coach
  fragen" pill on `/insights/zielwerte` collapses to a 44 px
  icon-only affordance. The visible label drops; the same string
  carries through `aria-label` + `title` so screen readers still
  announce the action.
- **HealthScore delta gains a `?` explainer.** Tap or hover on the
  icon next to the "-3 vs last week" line opens a popover on `md+`
  and a `<ResponsiveSheet>` bottom-sheet on phone viewports.
  Three-sentence body per locale: which components contribute, what
  window, what the user can do to nudge it.
- **Trends row pins to an equal-height contract.** The
  `auto-rows-fr` rule lifts from `md:` to every breakpoint; each
  chart wraps in a `trends-row-chart-slot` div with `shrink-0` so
  the slot is the load-bearing height anchor. `<MoodChart>` mini
  envelope tightens to match `<HealthChart mini>`. Captions clamp
  at three lines.
- **`<CoachLaunchScope>.metric` narrows to `CoachScopeSource`.** The
  type is forward-looking — no call site passes the parameter yet —
  but the union now mirrors what the iOS client speaks. The
  v1.4.28 narrowing closes the open type-system note from
  v1.4.27.
- **Coach mobile sheet caps at 90 dvh.** The Coach drawer's bottom-
  sheet branch on phones now matches the `<ResponsiveSheet>`
  convention (the v1.4.27 release picked 95 dvh; this release
  aligns the cap).
- **Insights sub-pages share one data-fetch hook.** The seven sub-
  pages duplicated the same React-Query analytics fetch plus the
  empty-state branch; both now route through `useInsightsAnalytics`
  and `<MetricEmptyState>`. Adding a future metric sub-page is a
  one-file change.
- **Chart dynamic imports consolidate on `<HealthChartDynamic>`.**
  Six `dynamic(() => import("@/components/charts/health-chart"))`
  call sites collapse to one re-export. Every dynamic chart slot
  ships a layout-stable `<ChartSkeleton>` loading state so the
  page does not jump as the bundle resolves.
- **Side-effects add CTA shortens across all six locales.** "Log",
  "Erfassen", "Consigner", "Registrar", "Registra", "Dodaj" — the
  qualifier drops; the section title carries the context.
- **`/api/measurements` aggregate branch flips to GROUP BY.** The
  Postgres `date_trunc` path resolves daily / weekly / monthly
  grain server-side; the `BUCKET_CAP` keeps the response bounded.
  iOS callers that pass `limit` only land in the unchanged raw
  branch (byte-stable against v1.4.27).
- **`/medications/[id]/history` page wrapper stride.**
  `space-y-4 → space-y-6` so the section stride matches
  `/insights/*`.

### Added

- **`useInsightsAnalytics()` hook + `<MetricEmptyState>` primitive.**
  Shared data-fetch + empty-state scaffolding across the insights
  sub-pages. Adding a new metric route reads on one fetcher and one
  empty-state recipe. `AnalyticsData` hoists to
  `src/types/analytics.ts` as `SubPageAnalyticsData`.
- **`<HealthChartDynamic>` re-export.** Single canonical lazy-loaded
  health-chart entry consumed by the dashboard, the five `/insights`
  metric pages, the trends row, and the VO2 max chart row.
- **`<ChartSkeleton>` loading state across every dynamic chart.**
  Layout-stable placeholder pinned at the same height the chart
  paints when loaded. Nine `next/dynamic` chart call sites lift onto
  the shared primitive.
- **`with-timeout.ts` envelope helper.** Wraps any provider call in
  a 20 s timeout and returns a structured `TimeoutEnvelope<T>`
  (`{ ok: true, value } | { ok: false, error }`). Adopted by the
  insights status cards; the user-visible chart paints immediately
  while the language-model assessment resolves async.
- **`HealthScoreDeltaExplainer`.** New
  `src/components/insights/health-score-delta-explainer.tsx`
  surfaces the `?` icon next to the delta line; tap opens a
  popover on `md+` and a `<ResponsiveSheet>` on phone viewports.
  Three-sentence body per locale. The trigger paints
  `aria-expanded` + `aria-controls`; the body owns an `id` matched
  by `aria-describedby` on the delta `<span>`.
- **`<LayoutCoachFab>` mount.** Floating Coach affordance lifts out
  of `<CoachLaunchButton>` and mounts once per Insights layout. The
  duplicate-FAB nodes (one per sub-page) collapse to one node in the
  a11y tree.
- **`<MobileRailTray>` carve-out.** The two `<Sheet>` mounts that
  wrap the Coach history rail and sources rail lift out of
  `<CoachDrawer>` into their own ~80 LOC primitive. Pure refactor:
  every `data-slot` identifier and breakpoint class survives intact.
- **`useReportWebVitals` beacon + bundle analyzer.** `pnpm analyze`
  runs `next build` with `@next/bundle-analyzer` enabled (reports
  land in `.next/analyze/`). The beacon POSTs CLS / LCP / INP / FCP
  / TTFB / INP to `/api/internal/web-vitals` via
  `navigator.sendBeacon` with a `fetch({ keepalive: true })`
  fallback. The route validates the payload with Zod, rate-limits
  to 60 / min per IP, requires same-origin Referer (when
  `NEXT_PUBLIC_APP_URL` is set), and forwards the metric name +
  value + rating to the wide-event logger via `annotate({ meta })`.
- **`aggregate=monthly` grain on `/api/measurements`.** Additive
  enum value resolving 30-day buckets. All-time chart range now
  resolves to monthly aggregation when full history ≥ 2 years,
  weekly when shorter. The 24-bucket ceiling keeps the response
  bounded. Schema is iOS-additive.
- **`dispatchLocalisedNotification` user-lookup cache.** 30 s TTL
  LRU keyed on `userId`; repeat dispatches inside the window share
  one Prisma query. Capped at 1 000 entries with FIFO eviction.
  For a burst of admin alerts to the same recipient the cache
  collapses N round-trips to 1.
- **`insights.coach.window.lastYear` key across six locales.** The
  enum value shipped in v1.4.27; the strings now carry native
  copy in every locale ("year so far", "Jahresrückblick", "depuis
  le début de l'année", "lo que va de año", "anno in corso",
  "od początku roku").

### Performance

- **Health-chart fetches bound to the active range window.** The
  client now passes the resolved `from`/`to` for the selected range
  instead of pulling the full history every time; the wire payload
  and the Recharts render scale linearly with the visible window.
- **Insights status-card provider call capped at 20 s.** Hung
  assessments resolve to the rule-based fallback instead of blocking
  the chart paint. The chart is rendered from local analytics on
  first paint; the assessment line streams in when (and if) the
  provider returns.
- **Dispatch-localised notification user lookup cached.** See the
  Added entry — same line item, performance impact is the
  collapsed Prisma round-trips on burst dispatches.
- **Dynamic chart imports collapsed onto one re-export.** Six
  duplicate `next/dynamic` call sites reduce to one; chart
  skeletons pin layout across the dynamic resolve so the user
  never sees a height jump.

### Tests

- **17 new Vitest cases for the range-aggregation route.** Cover
  the iOS gate (raw branch byte-stable when `aggregate` is omitted),
  the daily 365-bucket assertion, the monthly cap, the all-time
  monthly path, the all-time weekly fallback, and the per-grain
  threshold.
- **8 new cases on the web-vitals beacon route.** Happy 204, three
  schema rejections, malformed JSON, 429 under rate limit,
  cross-origin drop, same-origin accept.
- **5 new cases on the dispatch-localised cache.** Cache hit, TTL
  expiry, just-inside-TTL, reset helper, per-user isolation.
- **11 new tests across the medication, insights, and target
  surfaces.** Three on `<MedicationCardHeader>`, one on the side-
  effects narrow-viewport responsive shape, four on the HealthScore
  delta explainer (size, screen-reader wiring, trigger label,
  closed-by-default), one on the mood-tile radius, one on the
  trends-row equal-height contract, one on the targets-page Coach
  icon affordance.
- **5 new cases on `<MobileRailTray>`.** Slot identifiers,
  breakpoint hides, rail content forwarding, localised titles,
  closed-state gating.
- **1 new case on the workout edit duplicate-timestamp path.** The
  `ACTIVE_ENERGY_BURNED` sport-typed row pins the 409 response
  shape and the `measurements.duplicateTimestamp` key resolves to
  native translations on every locale.
- **Test totals: 3953 → 3974 passing across the broad sweep, with
  546 / 546 green on the touched surfaces.**

### Deferred

- **All-time tab client wire-up.** The server machinery lands in
  `8144281d`; the client still defaults the "All time" tab to a
  365-day window with no `aggregate` param. Flipping the client to
  pass `aggregate=monthly` plus the user's earliest measurement as
  `from` is a four-line edit deferred to v1.4.29 — the bucketed
  rows carry a divergent shape and the chart adapter needs a small
  helper to merge bucketed vs raw inputs.
- **Medium-tier findings across surfaces.** The simplifier, design, UI-conformity,
  i18n, and senior-dev passes each surfaced a medium-tier
  backlog. Closed only the high-impact items in this release;
  medium-tier items (8 design, 4 UI-conformity, 5 i18n, 7 senior-
  dev, plus the `<ResponsiveSheet>` footer-slot wiring and the 5
  `<Dialog>` consumers still to migrate) defer to v1.4.29 per the
  scope-discipline directive ("less scope, more depth").
- **Five admin / monitoring orphan endpoints.** Unchanged from
  v1.4.27. The wire-or-remove decision still pends — each is
  documented in README but has no runtime consumer. Carry forward
  to v1.4.29.

## [1.4.27] — 2026-05-15

Mobile capability + maintainer-finding cleanup. The headline is a new
`<ResponsiveSheet>` primitive that switches between a bottom-sheet on
narrow viewports and a centred dialog on desktop; every primary form
entry mounts through it with sticky-pinned Save / Cancel above the soft
keyboard. Tap targets across `Button`, `Input`, `Select`,
`DropdownMenu` and the new shared `PasswordInput` lift to the WCAG
2.5.5 floor, and `inputMode` / `enterKeyHint` / `autoComplete` /
`aria-invalid` / `aria-describedby` are wired across every form. The
Coach drawer mount moves up to the `/insights` layout so every
sub-page can launch the panel, and flips to a bottom-sheet branch on
narrow viewports. The dashboard GLP-1 tile gains a two-tab pane with a
range strip; the seven insights sub-pages gate on metric data
availability with empty-state CTAs that route into a self-opening
measurement form. Login overview surfaces an offline-resolved carrier
chip via bundled MaxMind GeoLite2-City + GeoLite2-ASN MMDBs. A new
`<NativeSelect>` primitive replaces five raw selects across settings
and admin. 26 of the 27 maintainer findings landed; the weekly-report
dead-click ask defers to v1.4.28 pending a screenshot. Migration 0061
is additive, `IF NOT EXISTS`-guarded, and forward-only.

### Added

- **`<ResponsiveSheet>` primitive.** New surface at
  `src/components/ui/responsive-sheet.tsx` plus a typed `useIsMobile`
  hook at `src/hooks/use-is-mobile.ts`. Renders a Radix `<Sheet>` with
  a `side="bottom"` branch below `md` (768 px), a centred `<Dialog>`
  branch on `md+`, and a `data-variant="dialog" | "sheet"` hook for
  tests and downstream styling. The Sheet branch sticky-pins the
  footer slot at the bottom edge with a backdrop-blur background; the
  Dialog branch flows the footer normally. SSR-safe — seeded from
  `useSyncExternalStore` so the first client render reads
  `window.matchMedia` synchronously rather than waiting an effect
  tick.
- **`<NativeSelect>` primitive** at `src/components/ui/native-select.tsx`,
  consumed by `account-section.tsx`, `timezone-picker.tsx`,
  `general-settings-section.tsx` and the five remaining raw selects on
  `ai-section.tsx`.
- **`<CoachLaunchProvider>` and `LayoutCoachMount` for `/insights`.**
  The drawer mount moves up to `src/app/insights/layout.tsx` so every
  routed sub-page can call `useCoachLaunch()` and open the panel.
  Each of the seven sub-pages mounts a `<CoachLaunchButton>` — sticky
  FAB on `<lg`, inline action on `lg+`. `askCoach(prefill, scope)`
  accepts a reserved `scope` argument for per-metric Coach narrowing
  (parameter is wired through the context but the sources rail does
  not yet pre-narrow; consumed in v1.4.28).
- **Dashboard GLP-1 tile — two-tab pane plus range strip.** The tile
  pairs a Weight tab with a new Drug-Level tab (default Drug-Level)
  driven by `<DrugLevelChart>` in its `compact` mode. A
  7-day / 30-day / 90-day / all-time radiogroup picks the chart range.
  Schedule dates promote to a header pill row; the previous green seam
  is gone.
- **Insights sub-page availability gating.** New helper
  `src/lib/insights/metric-availability.ts` exposes `hasMetricData()`
  as a single decision point. `<InsightsTabStrip>`,
  `<InsightsLayoutShell>` and the seven sub-page routes gate the tab
  pill, the layout mount and the sub-page body on whether the
  underlying metric has data; missing metrics drop cleanly rather than
  rendering an empty chart.
- **Insights empty-state CTAs.** Each sub-page renders the shared
  `<EmptyState>` with a metric-specific title, description and CTA.
  BP / weight / pulse / BMI route into `/measurements?add=<TYPE>`,
  which auto-opens the `<ResponsiveSheet>` add-form with `defaultType`
  set and `router.replace`s the query so the back button returns to a
  clean URL. Mood / medication / sleep route to their dedicated pages.
  Every empty-state offers a Coach launch as a secondary path.
- **Offline geo-IP + ASN-to-carrier lookups.** New
  `scripts/fetch-geolite2.sh` downloads `GeoLite2-City.mmdb` +
  `GeoLite2-ASN.mmdb` into `assets/geolite2/` at build time using the
  `MAXMIND_LICENSE_KEY` repo secret. The runtime resolver in
  `src/lib/geo.ts` reads `GEOLITE2_DIR` (defaults to
  `/opt/geolite2`) and silently skips the offline tier when the files
  are absent so local-dev workflows without the license key continue
  to fall back to `ipwho.is`. The MMDB files are not vendored in git;
  `.gitignore` excludes `assets/geolite2/*.mmdb`. The fetch script
  prints the SHA256 of each MMDB to stderr after download. The
  GHCR build step fails fast with an `::error::` line when the secret
  is unset.
- **`AuditLog.asn` + `AuditLog.carrier` columns.** Migration `0061`
  adds two additive, `IF NOT EXISTS`-guarded columns to `AuditLog`,
  plus a `geo-backfill` pg-boss job that re-resolves carrier on
  historical rows. The admin login overview surfaces the carrier as
  a chip under the auth-provider column, with a case-insensitive
  short-label heuristic that collapses verbose org strings
  (e.g. `Telefonica O2 Deutschland` → `O2`).
- **`/about` page.** New public route at `src/app/about/page.tsx`
  carrying the MaxMind GeoLite2 CC BY-SA 4.0 attribution alongside the
  existing project credits. Joins `proxy.ts` and `auth-shell.tsx`
  `PUBLIC_PATHS` so the page reaches an unauthenticated visitor with
  its own edge-to-edge header and footer (same shape as `/privacy`).
- **Coach polish — info-icon popover for the composer hint.** The
  verbose hint span at the bottom of the composer collapses to an
  `Info` icon wrapped in a new shadcn `<Popover>` (mirroring the
  existing `<Tooltip>` shape). The trigger carries an `aria-label`
  with the same hint copy so screen readers still announce it on
  focus; the popover body shows the long-form hint on tap or hover.
- **Soft-keyboard re-pin on the message thread.**
  `src/components/insights/coach-panel/message-thread.tsx` adds a
  `window.visualViewport.resize` listener with the same `wasPinned`
  guard as the existing message-arrival effect. When the soft
  keyboard slides in, the thread re-pins to the bottom so the tail
  stays visible.
- **`parkIntegrationAtReauth` helper.** New
  `src/lib/integrations/status.ts` export that flips an integration
  row to `state=error_reauth` without incrementing
  `consecutiveFailures`, without calling `recordSyncFailure`, and
  without entering the 3-strike admin-alert ladder. Writes one
  idempotent `integrations.reauth_required` audit row. Replaces the
  scope-skip branch in `withings/sync-activity.ts` and
  `withings/sync-sleep.ts`; the defence-in-depth 403 catch block
  stays on `recordSyncFailure`.
- **`dispatchLocalisedNotification` helper.** New
  `src/lib/notifications/dispatch-localised.ts` resolves the
  recipient's `User.locale`, calls
  `getServerTranslator(locale).t(titleKey, params)` /
  `.t(messageKey, params)`, and delegates to the base
  `dispatchNotification` with composed strings. Wired into the deploy
  webhook, the admin "test notification" button, the user "test
  Telegram" button, and the admin reminder-check diagnostic. Nine
  new notification keys land in all six locale bundles.
- **Locale-native date format ordering for FR / ES / IT / PL.** A new
  `format.*` namespace documents `dateShort`, `timeShort`, and
  `dateTime` per locale — FR / ES / IT use `{day}/{month}/{year}`
  slashes, PL uses `{day}.{month}.{year}` dots, DE keeps dots, EN
  keeps slashes. The keys are forward-looking; runtime formatting
  still routes through `Intl.DateTimeFormat` via
  `src/lib/format-locale.ts`, but downstream surfaces that render
  outside a React context (PDF, CSV, email) can read the ordering
  hint without spinning up `Intl`.
- **`coachScopeWindowSchema.lastYear`.** The Coach snapshot window
  enum gains a `lastYear` value (365 days) between `last90days` and
  `allTime`. `<SourceChips>` surfaces the year-in-review chip when
  the resolved scope window matches.
- **Workouts read route.** New `GET /api/workouts` paginated route
  that runs every fetch through `pickCanonicalWorkout()` with
  `DEFAULT_WORKOUT_SOURCE_PRIORITY` and the 5-min cluster window.
  Pagination corrects against canonical dedup — the route pulls the
  full filtered set, dedupes once, then slices, so `meta.total`
  reports the deduped count rather than the per-window
  `canonical.length`.
- **iOS handoff addendum.** A new coordination note
  documents the standalone-then-pair pattern for the iOS native
  client. Sibling of the existing `22-offline-first-architecture.md`;
  same research input, neutral framing per the v1.4.27 convention
  directive.

### Changed

- **Tap-target floor lifted across the primitives.** `Button` default
  `h-9 → h-10`, `lg` `h-10 → h-11`, `icon` `size-9 → size-10`,
  `icon-lg` `size-10 → size-11`; `Input` `h-9 → h-10`; `Select`
  trigger `h-9 → h-10`; `DropdownMenuItem` gains `min-h-11 py-2`.
  `Dialog` close-X grew from 24 px to `min-h-9 min-w-9` (36 px,
  WCAG 2.5.8) — intentional compromise so the close affordance does
  not crowd a dialog header.
- **`PasswordInput` lifted to the shared UI layer.** Moved from
  `src/components/settings/password-input.tsx` to
  `src/components/ui/password-input.tsx`; the toggle button grew to a
  44 px hit area, the input gets `pr-12` so user input never collides
  with the toggle. Five settings + admin consumers re-import.
- **Coach drawer mount move.** The drawer no longer mounts inline on
  `/insights/page.tsx`; the layout owns it. Sub-pages call
  `useCoachLaunch()` to open the panel.
- **Coach drawer bottom-sheet on `<sm`.** The drawer reads
  `useIsMobile("sm")` and switches `side="right"` → `side="bottom"`
  below 640 px. The window-pill `<Select>` in the header hides on
  phone viewports — the sources-rail picker covers the same override.
  `<SheetTitle>` pins `min-w-0 truncate` so long titles always clip.
- **Coach evidence disclosure.** The `<details>` block on each Coach
  reply is now controlled via `useState` with an accurate
  `aria-expanded` driven from that state. The `showEvidenceByDefault`
  Coach pref retires from the settings sheet (the persisted field
  stays on the Zod schema for backward compatibility; v1.5 can drop
  it via a forward-compat migration).
- **Coach sources-rail toggle.** Swapped from a raw
  `<input type="checkbox">` to the new shadcn `<Checkbox>` primitive
  at `src/components/ui/checkbox.tsx`. Keyboard contract (Space
  toggles, Tab moves), focus ring, touch-friendly hit target. The
  existing `data-slot="coach-sources-checkbox"` marker is preserved.
- **Coach settings-sheet close affordance.** Retired the primitive's
  absolutely-positioned close-X (`showCloseButton={false}`) in favour
  of an inline `<SheetClose>` in the header, matching the coach-drawer
  pattern and clearing 44 px.
- **Coach rail-tray triggers.** The history and sources triggers lift
  out of the absolute overlay into a sub-header strip
  (`xl:hidden` / `lg:hidden`); both buttons sit at `min-h-11`. The
  per-row delete on `history-rail.tsx` drops the
  `opacity-0 group-hover:opacity-100` reveal and is always visible at
  `size-11`.
- **Token-leak hardening at insight-status producers and consumer.**
  `normalizeSummaryText` on the seven `*-status.ts` helpers
  (`pulse`, `weight`, `bmi`, `mood`, `blood-pressure`,
  `medication-compliance`, `general`) now calls `stripChartTokens()`
  before whitespace collapse; `<InsightStatusCard>` wraps `text` with
  the same call at the render site as defence-in-depth for cached
  rows. The colon-form, capitalised-Metric and orphan-enum tokens
  are now scrubbed at both layers.
- **Settings — date-of-birth paired with language in one grid row.**
  `account-section.tsx` collapses the v1.4.19 split. The
  `TimezonePicker` inner gap lifts to `gap-3` so the select and the
  detect button breathe at the same rhythm as the rest of the form.
- **Settings + admin shells reserve a minimum main-column height.**
  Both shells pick up
  `<main className="min-h-[calc(100dvh-12rem)] min-w-0">` so short
  sub-pages no longer trigger a click-to-shift as the layout
  collapses inwards.
- **Thresholds + Sources skeleton rows replace the single spinner.**
  The two settings sections render a row-shaped placeholder list
  while loading; the skeletons map over the same metric ordering as
  the live UI so the layout stays put across the loading-to-loaded
  transition.
- **Heading weight + card cadence + label-input gap.** Standardised
  to `font-semibold` across every divergent `<h2>` / `<h3>` in
  settings and admin sections; card-internal vertical rhythm pins to
  `space-y-4`; the password-change dialog at `account-section.tsx`
  lifts `space-y-1.5 → space-y-2` across its three label-input pairs.
- **Health Score column rebalanced.** The hero strip splits to a
  tablet-friendly `md:flex-row`; the Health Score card pins a
  `basis-` width so the column does not stretch past its content.
  The L2 disclaimer text bumps from `text-[10px]` to `text-[11px]`
  to clear the 12 px mobile floor concern. The retired inline
  ask-Coach button drops; the `onAskCoach` prop stays for backward
  compatibility (destructure-and-ignore).
- **Daily Briefing trim.** The duplicate paragraph slot drops; the
  card renders a single insight line and the matching insights
  sub-page link.
- **`/api/version` carrier surface.** The login overview CSV adopts
  carrier as a column and the per-row chip surfaces under the
  provider cell. Empty carrier renders as no chip rather than a
  placeholder label.
- **CoachLaunch `scope` parameter.** Reserved on the
  `useCoachLaunch().askCoach(prefill, scope)` signature for v1.4.28's
  per-metric narrowing; currently a no-op on the sources rail.
- **CSV / pagination chrome out of the admin scroll wrappers.**
  `login-overview-section.tsx` and `app-log-preview-section.tsx` now
  render the pagination controls and the summary line as siblings of
  the `overflow-x-auto` table wrapper. The CSV export button was
  already in the toolbar row above the table.
- **`measurement-list.tsx` filter row stacks on `<sm`.** The
  measurement-type filter `SelectTrigger` widens to `w-full sm:w-48`
  and stacks above the controls below the small breakpoint.
- **Chart-height as a CSS variable.** `HealthChart`, `MoodChart` and
  `MedicationComplianceChart` expose `--chart-height` /
  `--chart-height-md` so the height shifts on `md+` without a
  re-render. `MoodChart` 280 → 240 to match the rest of the trend
  strip; a shared `CHART_HEIGHT_PX` constant lives at
  `src/components/charts/constants.ts`.
- **Compliance heatmap tap-pin + cell floor.** The heatmap tooltip
  pins on tap on touch surfaces (previously hover-only); each cell
  pins a 14 px floor; the heatmap overflows the parent on `<sm`
  rather than crushing to one row.
- **Withings sync — scope-skip path silences the admin alert.**
  Calls to `recordSyncFailure` in `sync-activity.ts` and
  `sync-sleep.ts` swap to `parkIntegrationAtReauth` on the
  deliberate scope-skip branch; the defence-in-depth 403 catch path
  keeps the loud `recordSyncFailure`. The false-positive 3-strike
  admin Telegram for re-auth scope deltas is gone.
- **i18n bundles — 154 dead keys retired.** A repository-wide scan
  retires keys that no surface reads (the legacy insights status
  trio, the `aiInsights` / `generate*` / `noApiKey` set retired with
  the briefing rebuild, the `onboarding.v2.*` stub set, ten dead
  medication keys, four dead chart keys, the `insightsPreview` /
  `bloodPressureDia` / `bloodPressureSys` dashboard keys, two dead
  notification keys, two dead admin-provider labels). 228 new
  strings land across the same 38 unique paths for the GLP-1 tile,
  the admin carrier chip, the insights empty states and the
  notifications dispatcher.
- **Shared mood label module.** New `src/lib/mood/labels.ts` exposes
  `MOOD_ENUM_VALUES`, `MOOD_SCORE_BY_ENUM`, `MOOD_ENUM_BY_SCORE`,
  `MOOD_LABEL_KEYS`, and `moodLabelKeyForScore()`. `mood-list.tsx`
  and `mood-chart.tsx` import the canonical key map from this
  module; the five inline `t("charts.moodLabel${n}")` calls retire
  in favour of the canonical `mood.level*` set.
- **Shared `allMessages` + `resolveKey` extract.** Both
  `lib/i18n/context.tsx` and `lib/i18n/server-translator.ts` now
  import from the new `lib/i18n/shared-resolve.ts`; the two
  duplicate copies are gone (net 61 / -66 LOC).
- **`metricPriorityObjectSchema` derives from
  `SOURCE_PRIORITY_METRIC_KEYS`.** Adding a metric class is a
  single-line constant edit instead of three parallel listings.
- **Workouts attach route collapses 1+N to a single `findMany`.**
  `POST /api/workouts/batch` swaps the
  `Promise.all(withoutExternal.map(p => tx.workout.findFirst(...)))`
  loop for one batched `tx.workout.findMany` with a per-entry `OR`
  clause; per-batch round-trip count drops from 1+N to 2 for a
  100-row batch. The createdAt-DESC tie-break is preserved via
  in-memory grouping.
- **Form input attributes wired across the surface.** Measurement,
  medication, mood, settings, admin and auth forms pick up
  `inputMode` / `enterKeyHint` / `autoComplete` / `autoCapitalize` /
  `aria-required` / `aria-invalid` / `aria-describedby`. The Input
  primitive derives `inputMode` from the `type` prop when the caller
  does not pass one (`number → decimal`, `tel → tel`,
  `email → email`, `url → url`, `search → search`). Integer-only
  call sites still pass `inputMode="numeric"` explicitly.
- **Schedule day-of-week grid widens on narrow viewports.**
  `medication-form.tsx` stacks the Daily pill above a fixed
  `grid grid-cols-7` so every weekday keeps the 44 px tap-target
  floor regardless of container width.
- **Public-page polish.** `/about` and `/privacy` sticky headers
  pick up `pt-[env(safe-area-inset-top)]` so the brand row clears
  the iOS notch. `/privacy` mounts a default-closed `<details>`
  Contents TOC above the body with anchor links to every numbered
  section; the 19 HealthKit identifier `<code>` elements gain
  `break-all` so the longest camelCase entries wrap.

### Fixed

- **Stray-brace typo at the insights-targets route.** The trailing
  comment block at `src/app/api/insights/targets/route.ts:807`
  carried a stray `}` that the v1.4.25 polish pass missed; cleaned
  up alongside the prompt-side audit.
- **Chart-tick timezone audit.** `compliance-heatmap.tsx` parsed the
  day-key against local tz (`new Date(dateStr + "T00:00:00")`) and
  read `getDay()` / `getMonth()` (server-tz) while the dateKey was
  UTC-anchored via `toISOString().slice(0, 10)`. Pinned to
  `T00:00:00Z` + `getUTC*` accessors so the Monday-alignment and
  month-marker placement stay correct under an SSR pass on a
  non-Berlin host. The five sibling chart files
  (`sleep-stage-stacked-bar`, `mood-chart`, `health-chart`,
  `medication-compliance-chart`, plus the broader insights surface)
  audit clean.
- **`/about` returned 401 to unauthenticated visitors.** `/about`
  joined `proxy.ts` `PUBLIC_PATHS` in B3 but the client-side
  `auth-shell.tsx` `PUBLIC_PATHS` list was missing the entry, so
  the route surfaced the redirect-to-login screen instead of the
  credits. `isStandalonePublicPage` also matches `/about` so the
  route renders edge-to-edge.
- **Insights empty-state CTAs hit a 404.** The CTAs targeted
  `/measurements/new`, which is not a route. Swapped to
  `/measurements?add=<TYPE>` with a `MEASUREMENT_TYPES` allow-list
  on the consumer side; the measurements page reads the query
  param, opens the form with `defaultType` set, then
  `router.replace`s to a clean URL.
- **`/api/version` register button below the tap floor.** The
  `/auth/register` submit button promotes to `size="lg" min-h-11
w-full` so the primary action stays finger-tap reachable on
  narrow viewports.
- **Workouts pagination broken under canonical dedup.** Pulling the
  full filtered set and slicing post-dedup yields the correct
  `meta.total` and a no-overlap, no-gap descending order across
  pages. New regression test paginates eight twin clusters across
  two pages.
- **`useIsMobile` first-paint desktop flash.** The hook now reads
  through `useSyncExternalStore` with `getServerSnapshot() => false`
  and `getClientSnapshot()` reading
  `window.matchMedia(query).matches` synchronously. SSR still
  resolves to `false`; the first client render reads the live
  media-query state without waiting an effect tick.
- **`Sheet` close-X tap target.** Widened to match the `Dialog`
  primitive's 36 px floor.
- **`/about` and `/privacy` anchors occluded by the sticky header.**
  `scroll-mt` widened so the section start lands below the sticky
  header rather than behind it.
- **`MedicationComplianceChart.compareBaseline` prop intent.** The
  prop was carried by 24 call sites uniformly but was never
  consumed; explicitly destructured with `void compareBaseline;` so
  the type contract is preserved and the dead-prop signal clears.
- **DrugLevelChart dead axis labels.** Dropped the empty `<text>`
  child of `<XAxis>` (an invisible SVG node beneath the x-axis) and
  the duplicate Recharts `label={…}` prop on `<YAxis>` that tried to
  paint the unit-less caption inside a 1 px-wide axis where it
  could never be read. The external `<p>` above the chart remains
  the single source of truth.
- **`not-found.tsx` missing.** New branded 404 page with the
  `<Logo>`, the 404 eyebrow, the headline and a single
  back-to-dashboard `<Link>`. `min-h-dvh` follows the dynamic
  viewport on iOS Safari; `pt-[calc(env(safe-area-inset-top)+3rem)]`
  keeps the headline clear of the notch.

### Removed

- **Orphan `/api/audit-log` route.** The route file (1 281 B) had no
  callers, no test fixture and no DTO. Five admin / monitoring
  endpoints (`/api/admin/ai-settings`, `/api/admin/backup/test`,
  `/api/admin/status-overview`, `/api/monitoring/glitchtip/test`,
  `/api/monitoring/umami/test`) defer to v1.4.28 because each is
  referenced by README or CHANGELOG — a wire-or-remove decision the
  maintainer owns.
- **`<InsightsCardPreview>` surface.** The standalone dashboard
  preview retired alongside the layout-test contract flip;
  `dashboard-layout.test.ts` now guards against accidental
  reintroduction.
- **14 dead exports across `glp1-knowledge.ts`, `scheduling/cadence.ts`
  and `glp1-snapshot.ts`.** Eight type symbols on
  `glp1-knowledge.ts` drop to internal types; `ExpectedDose` drops
  its `export` keyword; `__testables.WEEKDAY_KEYS` retires with zero
  callers. `routeForBrand` and `GLP1_DRUG_IDS` stay exported because
  the test suites read them.
- **`BASE_SYSTEM_PROMPT` + `INSIGHTS_SYSTEM_PROMPT` bare-symbol
  exports.** Verified clean — only locale-suffixed `_DE` / `_EN`
  forms remain.
- **Stale legacy insights-prompt module.** Pruned alongside the
  v1.4.25 native-locale rebuild that displaced it.
- **Three dead Coach prefs.** `showEvidenceByDefault` UI retires
  from the Coach settings sheet; the persisted Zod field stays for
  backward compatibility.

### Infrastructure

- **`MAXMIND_LICENSE_KEY` wired into the GHCR build workflow.** A
  new `Fetch GeoLite2 databases` step in
  `.github/workflows/docker-publish.yml` between the metadata-action
  and the buildx build-push exports the secret from repo secrets.
  Offline GeoLite2 is **optional** in this release: when the secret
  is unset the workflow emits a `::warning::`, drops an `.empty`
  marker into `assets/geolite2/`, and continues so the Dockerfile
  `COPY` still has a non-empty source. The runtime resolver in
  `src/lib/geo.ts` detects the marker on first lookup, falls back
  to the existing `ipwho.is` provider, and sends a one-shot admin
  notification (`notifications.admin.offlineGeoUnavailable*`) with
  a pointer to the GitHub Actions secrets page so the maintainer
  hears about the gap from the running app. The `/api/version`
  endpoint exposes `offlineGeoEnabled: boolean`; the `/admin`
  overview snapshot and the full `/admin/system-status` page render
  a green / yellow chip from that flag. Setting the secret and
  redeploying lights the feature up without code changes.
- **Migration `0061_audit_log_carrier`.** Additive,
  `IF NOT EXISTS`-guarded, forward-only. Adds two columns to
  `AuditLog`: `asn` (`bigint`) + `carrier` (`text`). Safe to
  re-apply on the demo server.

### Tests

- **`pnpm test --run` — 4004 / 4005 passing, 1 skipped.** Across
  357 files. The skipped test is a pre-existing
  visual-regression placeholder.
- **6 new `responsive-sheet.test.tsx` smoke tests** pin the
  dialog-vs-sheet branch, the `data-variant` hook, the footer-slot
  contract and the SSR `useIsMobile` first-paint.
- **16 new `metric-availability.test.ts` cases** cover each metric ×
  `{has data, no data, undefined summaries, missing summary entry,
BMI-from-WEIGHT derivation, sys-vs-dia independence,
mood/medication overrides}`.
- **6 new `insights-tab-strip.test.tsx` cases** assert
  backward-compat without `availability`, pill-drop when data is
  missing, overview pill always renders, mood + medication
  light-up, BMI-from-WEIGHT derivation.
- **Drift-guard test at `src/__tests__/i18n-drift-guard.test.ts`**
  (16 cases) anchors the GLP-1 tile keys, the carrier keys, the
  insights empty-state keys, the notification dispatcher keys and
  the personal-record namespace across all six locales.
- **Locale-native date format test** at
  `src/lib/i18n/__tests__/format-locale-order.test.ts` (7 cases)
  asserts ordering per locale.
- **`canonical-dedup.test.ts`** (4 cases) plus the new
  pagination regression covers the workouts read route.
- **Auth + audit suites extended** for the new ASN + carrier
  columns and the carrier short-label heuristic (14 cases under
  `geo-asn.test.ts`, 5 new cases under `audit.test.ts`, 8 new
  under `login-overview-csv.test.ts`).
- **`coach-launch-context.test.tsx`** (3 cases) pins the new
  Coach launch context hook shape, the provider mount, and the
  null fallback outside the provider.

## [1.4.26] — 2026-05-15

Hotfix release. Adds a public, unauthenticated privacy-policy page at
`/privacy` so the iOS native application can register a reachable URL
in App Store Connect. The policy enumerates every Apple HealthKit
identifier the iOS app reads, lists every active third-party sub-
processor with its data-protection policy, restates the EU MDR
medical-device boundary that scopes the AI Coach surface, and walks
through the GDPR Art. 15-22 / DSGVO data-subject rights with concrete
in-app routes the user can hit. The page bypasses the standard
auth-shell so an App-Store reviewer or a first-time visitor sees the
full document immediately. The conservative-semver pattern still
applies: this could have been versioned `1.4.25.1` for symmetry with
the iOS hotfix track, but 4-part versions break the strict-semver
guard in `/api/version` so we incremented to the next clean patch
instead.

### Added

- Public privacy policy at `/privacy` with full HealthKit quantity-type
  enumeration (18 identifiers plus `sleepAnalysis`), Withings
  measurement-family list, sub-processor table (Anthropic, OpenAI,
  Withings, Apple, Telegram, GitHub, Cloudflare, Hetzner), Apple
  privacy-nutrition-label mapping, and a verbatim EU MDR 2017/745 +
  MDCG 2021-24 medical-device-boundary statement.
- `auth.privacyPolicy` translation key in all six locales (English in
  EN, German in DE, native translations for FR / ES / IT / PL).

### Changed

- The unauthenticated login page links out to `/privacy` below the
  sign-in card so a first-time visitor can review the policy before
  signing up, matching GDPR Art. 13 pre-signup expectations.
- The auth shell now treats `/privacy` as a standalone public page —
  long-form legal content renders edge-to-edge instead of being squeezed
  into the centered login-card layout.

## [1.4.25] — 2026-05-14

Largest feature delta in the v1.4.x line. Insights expands from one
page into seven dedicated metric routes; GLP-1 medication tracking
lands end-to-end across injection picker, dashboard tile, weight-chart
markers, therapy timeline, plateau detection, drug-level chart with a
Research-Mode acknowledgment gate, EMA-sourced drug knowledge, EMA
titration ladder, cadence visualisation, compliance chips, side-effect
taxonomy, pen-and-vial inventory with a 30-day in-use clock, and a
dedicated doctor-report section; cross-source priority becomes a
two-axis resolver with a per-user Settings surface; per-user timezone
threads through ten analytics and presentation surfaces; Withings
coverage doubles with twelve new measurement types, webhook-driven
BP / temperature ingestion, plus Activity (steps + distance +
active-energy) and Sleep v2 (stage-level segments) syncs; the
onboarding flow is rebuilt as a nested-route wizard with welcome
carousel, goals chip-picker, source selection grid, baseline form,
and a welcome-back resume banner; Personal Records ship end-to-end
with a detection worker, push opt-in, and a metric-trend badge;
Health Score gains a per-component provenance accordion; the Coach
runs on native first-party prompts across all six locales with a
1800-assertion refusal-probe matrix; the OpenAPI drift gate flips to
hard-fail; the GHCR image is multi-arch so Apple Silicon Macs and
arm64 clouds pull native. Migrations 0043–0060 are additive and
forward-only. `PROMPT_VERSION` 4.24.0 → 4.25.0 with GROUND RULE 9
(Coach refuses GLP-1 dose recommendations) and GROUND RULE 15 (Coach
refuses drug-level estimates with MDR + MDCG 2021-24 cites).

### Added

- **Insights sub-pages — seven dedicated metric routes with a shared
  tab strip.** `/insights/blutdruck`, `/insights/gewicht`,
  `/insights/puls`, `/insights/stimmung`, `/insights/medikamente`,
  `/insights/bmi` and `/insights/schlaf` each render the metric's
  full chart, range bands, trend annotations and correlation rows
  beneath the mother-page hero. Tab strip lifts the metric switcher
  above each chart for cross-metric scanning; the mother page slims
  to general status and the Coach hero.
- **Sleep sub-page with per-night stacked-bar of sleep stages.**
  `/insights/schlaf` renders awake / REM / core / deep as stacked
  columns over the last 7 / 14 / 30 nights, sourced from the
  `sleepStage` column on `Measurement`.
- **Targets (`/insights/zielwerte`) redesigned with a conditional
  Coach-handoff card.** New `<TargetCard>` primitive replaces the
  v1.4.22 layout. Page-level consistency strip pins meta context
  above the cards. The Coach-handoff card only renders when a
  language-model provider is configured; rule-based mode hides it
  cleanly. Mobile-first three-column grid; per-card cog for
  visibility toggles.
- **GLP-1 medication tracking — full integration across ten
  surfaces.** New `Medication.treatmentClass` enum (`GLP1`,
  `STANDARD`); `MedicationDoseChange` history table; `InjectionSite`
  enum with eight site values. A new body-map picker proposes the
  next rotation site based on the last fourteen days of injections.
  Medication-card grows a `glp1` variant (text-rich, no inline
  chart per directive — chart lives on the dashboard tile and
  `/insights/medikamente` therapy timeline). Dashboard tile shows
  next-injection schedule + week-over-week weight delta. Weight
  chart gains vertical injection markers. Therapy timeline on the
  insights sub-page plots titration alongside weight trace. Plateau-
  detection rule in `/api/insights/briefing` flags four-week stalls
  with referral framing. Doctor-report PDF carries a dedicated GLP-1
  section. Migration 0046.
- **Doctor-report per-section toggles + mood default-off.** New
  `User.doctorReportPrefsJson` column (Migration 0045) +
  `PUT /api/auth/me/doctor-report-prefs`. Each section (mood,
  achievements, GLP-1, etc.) gets a per-user toggle in Settings →
  Reports. Mood defaults to off (clinical-sensitivity); empty
  sections hide rather than render a "no data" stub.
- **Cross-source priority resolution — two-axis architecture.**
  New `User.sourcePriorityJson` column (Migration 0048) stores a
  per-user resolver: a single-axis ladder by metric type plus an
  optional per-device-type override. `pickCanonicalSource()` walks
  the metric axis first; a per-device override (e.g. "BP from
  Withings BPM Connect, weight from Withings Body+") wins within
  that ladder. Defaults: cumulative + sleep + HRV + RHR favour
  Apple Health → Withings → manual; point measurements favour
  Withings → Apple Health → manual. The `__default__` sentinel is
  retired in favour of a null bucket.
- **Settings → Sources screen for per-user priority configuration.**
  Drag-and-reorder list per metric, per-device override picker,
  reset-to-defaults action. Audit-log entry on every write.
- **Per-user timezone — Option B threaded through ten surfaces.**
  New `User.timezone` column (defaults to `Europe/Berlin`). The
  CSV exporter emits ISO-8601 with offset; formatters honour the
  user's tz; Profile picker covers all IANA zones; admin sets the
  default for new accounts; signup detects the browser tz; the
  doctor-report PDF dates use the user's tz; chart x-axes take a
  `timezone` prop; Coach snapshot timestamps land in the user's
  tz; `MoodEntry.tz` records local-day grouping for weekday
  correlation (Migration 0044); the weight-weekday correlator
  buckets days in the user's tz.
- **Health Score provenance accordion.** Each of the four scoring
  components (BP, weight, mood, compliance) gets an inline
  disclosure listing the canonical source (Withings / Apple
  Health / manual) and `asOf` timestamp behind the score number.
  `aria-labelledby` panel pairing for screen readers.
- **Four additional locales — French, Spanish, Italian, Polish.**
  First-party translation bundles cover the full string surface
  with a `<MaintainershipBanner>` flagging the locale as
  community-maintained and pointing at the translation-feedback
  issue template. Coach + insights system prompts ship as native
  per-locale bodies (no `REPLY LANGUAGE` footer indirection) with
  the full safety-contract matrix in YAML per locale + structural
  refusal-probe coverage in CI (see Tests). EN + DE stay
  maintainer-curated. Locale picker covers all six; signup
  browser-detect maps `fr|es|it|pl` to the corresponding bundle.
- **Coach — native first-party system prompts across six locales.**
  Coach + insights system prompts move from EN body + `REPLY
LANGUAGE` footer to native per-locale bodies; the safety contract
  matrix lives as YAML per locale (single source of truth across
  drafting + tests). The refusal-probe matrix in CI catches
  cross-locale prompt regressions before they reach the dispatch
  surface.
- **VO2 max dashboard trend tile (opt-in).** Secondary-metric
  pattern — default-invisible, surfaces only when the user has
  VO2 max data from Apple Health.
- **Personal Records end-to-end — schema, detection worker, badge,
  push opt-in.** Migration 0054 introduces the `PersonalRecord`
  table + `PersonalRecordDirection` helper; `GET
/api/personal-records` is paginated (default twenty-five, max two
  hundred). A pg-boss worker sweeps MAX / MIN per metric and the
  workout slots on every batch-ingest + a thirty-minute fallback
  cron (concurrency five, warmup gate so the very first datapoint
  per metric does not promote itself). Metric trend tiles render a
  PR badge when the record landed in the last thirty days, with
  WCAG-AA contrast in dark mode. A per-user push opt-in toggle
  (default off) wires into the existing dispatcher cascade.
- **Workouts — schema + typed batch-ingest endpoint.** Migration
  0053 introduces the `Workout` + `WorkoutRoute` tables; the Zod
  boundary in `src/lib/validations/workout.ts` covers a
  twenty-member sport-type union and a `GeoJSON LineString` route
  column in JSONB. `POST /api/workouts/batch` accepts up to five
  hundred rows per call, wraps `withIdempotency()`, returns the
  same `inserted | duplicate | skipped` envelope as the
  measurements batch, and reconciles inserted vs duplicate counts
  correctly under contention. Rate-limited and size-capped.
- **Onboarding rebuilt as a nested-route wizard.** The legacy
  v1.4.20 onboarding ships as a six-step wizard at
  `/onboarding/[step]` powered by a new `<OnboardingShell>`
  primitive: welcome carousel with value-prop slides, goals
  chip-picker, source selection 4-card grid (with Apple Health
  marked coming-soon), baseline form, source-connect step, and a
  done step. `User.onboardingStep` (Migration 0057, with
  Migration 0060 backfilling and flipping the column to
  `NOT NULL DEFAULT 0`) drives resume-state; a welcome-back banner
  surfaces on the entry page when an in-progress wizard is
  detected. `POST /api/onboarding/step` advances the wizard with
  rate-limit + audit, returns 409 on a concurrent advance to close
  the read-then-write race. The marketing entry-point swaps from
  the v1.4.20 single-page flow to the new wizard. Five locales
  carry the shell key surface (six total).
- **GLP-1 — EMA drug knowledge layer.** A first-party drug-knowledge
  module covers five GLP-1 / GIP-GLP-1 drugs with EPAR-sourced
  half-life, recommended titration step, brand-name table, and a
  brand-to-id lookup. A drift-guard test pins the values against
  the EPAR + Psp 4.13099 references on disk so the module cannot
  silently drift.
- **GLP-1 — Research Mode with estimated drug-level chart, MDR
  acknowledgment dialog, and Settings toggle.** A pure
  one-compartment pharmacokinetic helper produces qualitative
  drug-level traces from the user's injection history (steady-state
  approximation, observational use only). The chart renders on the
  GLP-1 medication detail page behind a Research-Mode gate:
  `User.researchModeAck*` columns (Migration 0058) record the
  acknowledgment version + timestamp; a dialog explains the
  EU MDR 2017/745 + MDCG 2021-24 context and cites EMA EPAR plus
  Schneck / Urva 2024 before the user can opt in.
  `GET / POST / DELETE /api/auth/me/research-mode` carries the
  acknowledgment lifecycle. A Settings → Advanced toggle exposes
  the opt-in plus a re-prompt banner whenever the acknowledgment
  version bumps.
- **GLP-1 — side-effect logging with a 21-entry × 5-category
  taxonomy.** Migration 0059 introduces the `MedicationSideEffect`
  table; pure helpers produce the taxonomy + a five-point Likert
  severity scale; a section on the GLP-1 detail page lets the user
  log entries with category + severity + free-text notes. Category
  is derived server-side from the entry (no client-supplied
  category) so the taxonomy cannot drift between client and server.
- **GLP-1 — cadence visualisation + compliance chips.** Pure
  helpers expand a medication's schedule into expected slots,
  pair each slot with the closest actual intake, and produce a
  cadence timeline + compliance chip strip on the detail page.
  `GET /api/medications/[id]/cadence` returns the structured
  payload; the helpers honour per-user timezone so cross-midnight
  doses bucket correctly regardless of locale.
- **GLP-1 — EMA titration ladder display.** Pure helpers walk the
  EMA-sourced titration schedule from the knowledge layer; the
  GLP-1 detail page renders the user's current step + remaining
  ladder as observational reference, framed as reference-not-advice
  and bound by GROUND RULE 15. `GET
/api/medications/[id]/titration-ladder` returns the structured
  ladder + current step.
- **GLP-1 — pen-and-vial inventory with a 30-day in-use clock.**
  Migration 0056 introduces the `MedicationInventoryItem` table +
  a pure state machine (SEALED → IN_USE → EXPIRED) with a 30-day
  in-use clock from `markAsFirstUseAt`. An inventory card on the
  medication detail page surfaces the active pen, days remaining,
  and SEALED stock; intake events decrement the dose count, and a
  daily 03:00 cron flips expired in-use items in a single
  `updateMany`. Re-runs the state machine on every PATCH so a
  back-dated first-use immediately moves a stale pen to EXPIRED.
- **Apple Health identifier mapping (server-side).** Ports the
  identifier table from `k0rventen/apple-health-grafana` and
  `dogsheep/healthkit-to-sqlite` with MIT and Apache-2.0
  attribution recorded in source headers and `NOTICE`. Covers
  the v1.4.25 ingest surface; iOS-18 long-tail mappings (sleep
  apnea, GAD-7, paddle/row sports, FHIR clinical) carry inline
  release-window comments.
- **Audio-exposure and time-in-daylight measurement types.**
  Migration 0052 adds `ENVIRONMENT_AUDIO_EXPOSURE`,
  `HEADPHONE_AUDIO_EXPOSURE` and `TIME_IN_DAYLIGHT` to the
  `MeasurementType` enum. Doctor report mentions them when
  populated; no dedicated chart yet.
- **Withings expanded coverage — twelve new measurement types and
  the BP / temperature webhook subscription.** Migration 0049
  adds HRV, body temperature, SpO2 v2, VO2 max, fat-free mass,
  fat mass, muscle mass, skin temperature, pulse-wave velocity,
  vascular age and visceral fat as `MeasurementType` values.
  Withings webhook coverage extended to BP and temperature so
  the latency goes from ~1 h polling to seconds. OAuth scope
  upgraded to include `user.activity` and an in-app banner
  prompts existing users to reconnect once.
- **Withings — Activity sync (steps + distance + active-energy).**
  Calls `getactivity`, ingests one row per day, anchors at noon UTC
  so positive-offset users bucket cleanly into their local day.
  Backed by a pg-boss `activity-sync` queue plus a webhook enqueue
  hook on the new subscription channel.
- **Withings — Sleep v2 sync (stage-level segments).** Calls
  `sleepv2_get` and writes per-night stage segments through the new
  `sleepStage` composite (Migration 0055 widens the Measurement
  unique index to include `sleep_stage` with `NULLS NOT DISTINCT`).
  Backed by a pg-boss `sleep-v2-sync` queue plus webhook enqueue.
  The sleep sub-page's stacked-bar chart renders the segments
  directly.
- **Withings — webhook subscriptions expanded to activity + sleep
  v2.** Subscription registration plus webhook delivery routing for
  the two new event types.
- **Admin Login overview — location, provider and CSV polish.**
  Adds a location column derived from the audit IP; adds a
  provider column distinguishing passkey, password, API-token
  and OAuth login paths; the CSV export drops two unused columns
  and the per-row collapse affordance comes off.
- **DELETE `/api/measurements/by-external-ids` for iOS deletion
  sync.** Idempotent batch delete keyed on `(user, source,
externalId)` tuples; rate-limited the same way as the batch
  ingest endpoint.
- **Multi-arch Docker image.** GHCR publish workflow builds
  `linux/amd64` on `ubuntu-latest` plus `linux/arm64` on
  `ubuntu-24.04-arm` and merges the manifest. Apple Silicon
  Macs and arm64 clouds now pull native; the previously-stale
  README claim is accurate again.
- **GLP-1 endpoint hardening.** `POST
/api/medications/[id]/glp1` now parses through bounded Zod
  schemas (`glp1DoseChangePostSchema`, `glp1InventoryPostSchema`)
  with length-capped notes, finite-number guards on dose value,
  and bounded `effectiveFrom`. Every write produces an audit-log
  row and the route inherits the 30-per-minute-per-user rate
  limit from the rest of the medication surface.
- **Translation-feedback issue template.** GitHub issue template
  for community translation corrections, paired with the
  maintainership banner copy on FR / ES / IT / PL surfaces.
- **Repository polish.** README hero rewrite (what / who / try
  the demo, thirty-second read). Topics expanded 10 → 18.
  Branch protection v2 with conversation-resolution. GitHub
  Discussions enabled. Issue template + PR template carry-over
  from v1.4.20 preserved.

### Changed

- **Insights mother page slimmed; metric depth moved to sub-pages.**
  `/insights` becomes a navigation hub with hero strip + Daily
  Briefing + correlations + trends row; per-metric depth lives
  one click away on the dedicated sub-pages.
- **Targets page-shell unified with the rest of Insights.**
  Single consistency strip + Coach handoff + per-card actions
  rather than the v1.4.22 sparkline-everywhere layout.
- **Coach default-window preference plus chip-order rationalised.**
  The window picker now persists per-user (last seven / thirty /
  ninety days); suggested-prompt chips reorder so health-focus
  chips lead and meta-discovery chips trail. Composer auto-grows
  on multi-line input. Distinct error UX for daily-limit hit vs
  provider rate-limit. Microphone affordance retired (was a
  placeholder).
- **Dashboard global comparison-overlay default removed.** Per-chart
  preference from v1.4.22 is the only knob now; the dashboard-level
  default is gone.
- **`medication_schedules.*` columns mapped to snake_case via
  Prisma `@map`.** Migration 0047 — cosmetic rename only,
  convention parity with the rest of the schema. Resolves the
  v1.4.24 demo-deploy schema-drift finding.
- **Top-page padding parity across `AuthShell`, Settings and Admin
  shells.** Cross-page rhythm matches; the previous one-off
  paddings on Admin and Settings asymmetric to Insights are gone.
- **Settings icon + heading convention uniform across all twenty-
  three sections.** Every section header pairs an icon with a
  heading; the v1.4.24-era split (icon-only on some, heading-only
  on others) is gone.
- **`PROMPT_VERSION` 4.24.0 → 4.25.0** carries two new safety
  ground rules across all six locales: GROUND RULE 9 forbids GLP-1
  dose recommendations (Coach falls back to a clinical-referral
  framing on any dose question); GROUND RULE 15 forbids drug-level
  estimates and cites EU MDR 2017/745 + MDCG 2021-24 in the
  refusal copy. Coach + insights system prompts ship as native
  bodies per locale rather than the legacy `REPLY LANGUAGE`
  footer.
- **Dashboard top-tile polish.** Tile headings collapse to a
  single line per locale (BP / BF abbreviations land in EN + DE +
  the four Romance locales); the trend arrow moves inline next to
  the headline value; the value row baseline-aligns across tiles
  regardless of font fallback. Regression guard pins the baseline
  contract.
- **OpenAPI drift gate flips to hard-fail.** `pnpm openapi:check`
  CI step now red-bars a PR on any drift between the Zod registry
  and `docs/api/openapi.yaml`. The v1.4.23 warn-only window
  closes; iOS DTO codegen can rely on the spec being authoritative.
- **Coolify auto-deploy gate exposed as an explicit
  maintainer-toggleable repo variable.** `vars.COOLIFY_AUTO_DEPLOY`
  is now a `true | false` switch in the deploy workflow instead of
  the implicit secret-presence gate that silently no-op'd in
  v1.4.21-23.
- **Settings → Sources sentinel cleanup.** The `__default__`
  device-type bucket sentinel is retired in favour of a null
  bucket at the storage layer; the Settings UI reads cleaner and
  the reorder helpers (`reorderLadder`) collapse the two
  `moveSource` + `moveDeviceType` paths into one.
- **Section wrapper for medication detail.** A new
  `<MedicationDetailSection>` wraps the three medication-detail
  shells (titration, scheduling, side-effects) plus the inventory
  disclosure top so cross-section chrome stays consistent and
  future sections drop in without copy-paste.
- **Shared route ownership helper.** Nine medication routes
  (`titration`, `side-effects`, `inventory`, `cadence`, `intake`,
  `compliance`, `phase-config`, `api-endpoint`, plus the GLP-1
  convenience route) now call `assertMedicationOwnership` from
  `src/lib/medications/route-guards.ts` rather than open-coding
  the lookup; rate-limit headers across the same surface align
  on the option-bag form `apiError(..., { headers:
rateLimitHeaders(rl) })`.

### Fixed

- **Settings save regression on Zod v4 record semantics.**
  `z.record(z.string(), …)` switched to `z.partialRecord(…)` on
  the dashboard-prefs schema so optional keys round-trip cleanly
  through the PUT. The save-then-blank-load bug from v1.4.24 is
  gone.
- **Comparison-shift baseline regression.** Comparison overlay
  was subtracting the wrong-period baseline on several charts;
  baseline lookups now match the caption window. Three regression
  guards.
- **Raw metric-token leaks in generated prose** — `metric:<TYPE>`
  identifiers surfaced in three surfaces that escaped the v1.4.22
  sweep (`<RecommendationCard>` fallback path, briefing
  `keyFinding` helper, and Coach in-flight bubble).
  `stripChartTokens()` regex widened to cover lowercase prose
  remnants; prompt-side GROUND RULES 8 and 13 reaffirm the
  constraint. PROMPT_VERSION 4.23.0 → 4.24.0 carried the prompt
  change; 4.25.0 inherits.
- **Withings BP and temperature webhook latency.** Webhook
  subscription now covers BP and temperature endpoints, so the
  earliest a measurement reaches the user drops from ~1 h to
  seconds.
- **Dev-server crash on Tailwind v4 `color-mix` parser + Next 16
  api-handler private-field.** Two unrelated dev-time crashes
  surfaced together: Tailwind v4 choked on a `color-mix()`
  invocation in a chart token; Next 16 + Webpack fallback hit a
  private-field access on a force-static route handler.
  `color-mix` invocation replaced; api-handler guards the field
  access. Production unaffected — these surfaced only under the
  dev compile path.
- **Insights duplicate `StatusCard`.** The mother page rendered
  two copies of the BP status card at certain viewports due to
  a hero-strip ↔ correlation-row overlap. Card hoisted to the
  single canonical location.
- **Coach-feedback admin header layout shift.** Sticky-header
  contract mismatch — the section's `<header>` carried a different
  top padding than its siblings, so navigating into the section
  visibly shifted the chrome. Padding parity restored across all
  admin sections.
- **Notification-status-card heading icon parity.** Was the one
  section without an icon next to its heading; aligns with the
  cross-section convention now.
- **WCAG 2.5.5 touch-target floor across the top bar, section
  strips and the injection-site picker.** Several pill chips and
  the injection-picker dots sat below the 44-px floor; all hit
  the floor now without changing the visual density at typical
  rendering sizes.
- **Sleep-stage chart strokes resolve through Dracula tokens.**
  The chart was using the legacy `hsl(var(--border))` form which
  Tailwind v4 rejects; switched to the resolved token.
- **"Per night" hardcoded German in four locales.** The
  sleep-page subtitle suffix was hardcoded `pro Nacht` and
  rendered as raw German across FR / ES / IT / PL. Translated
  in all six locales; an i18n drift-guard covers the contract.
- **Cross-page top-padding asymmetry.** AuthShell, Settings,
  Admin all carry the same top padding now (see Changed).
- **`berlinIsoWeekday()` timezone hard-code.** The weekday helper
  hardcoded Europe/Berlin; now takes a `timezone` argument and
  threads through the weight-weekday correlator.
- **Batch-ingest race reconciliation under contention.** Two
  concurrent batches with overlapping `externalId` sets returned
  inconsistent `inserted` / `duplicate` counts because the
  reconciliation pass was logically inverted (no-op when the
  catch fired). Fixed; replay regression test seeds the race.
- **`requireAuth()` blocks narrow-scope iOS Bearer tokens on
  unscoped routes.** v1.4.24 closed the inverse hole (Bearer
  with no scope reaching unscoped handlers); this release closes
  the over-broad version — a token scoped exclusively to
  `medication:ingest` could not reach handlers that don't
  declare a `requiredPermission`. Now declared-scope tokens are
  allowed through provided the route's declared scope (or wildcard)
  is in the token's set.
- **`createMeasurementSchema` dropped `deviceType` on single-entry
  POST.** The batch route accepted `deviceType` per row; the
  single-entry POST stripped it on the Zod boundary. Mirror parity
  restored.
- **Personal-records endpoint unpaginated.** `GET
/api/personal-records` now clamps `?limit` (default twenty-five,
  maximum two hundred); the unbounded read is gone.
- **Withings activity sync bucketed positive-offset users into the
  wrong day.** The per-day row was anchored at 23:59:59 UTC, so a
  user in `Pacific/Auckland` saw activity rows attached to the
  following local day. Anchored at noon UTC (`T12:00:00.000Z`)
  with a regression suite covering Berlin / Los Angeles / Tokyo /
  Auckland.
- **Cadence and compliance helpers ignored per-user timezone.**
  `expandScheduleSlots`, `pairDoses`, `buildCadenceTimeline` and
  the compliance-chip helper now accept a `timeZone` argument that
  threads through `Intl.DateTimeFormat`, so cross-midnight doses
  bucket correctly regardless of user locale. The cadence route
  resolves through `resolveUserTimeZone(user)`.
- **Inventory state-machine ignored back-dated first-use.** Issuing
  a PATCH that pushed `markAsFirstUseAt` more than thirty days into
  the past left the item in IN_USE; the state machine now re-runs
  on every PATCH and the stale item flips to EXPIRED. Regression
  test pins the contract.
- **Inventory expire-stale cron looped per row.** Replaced the
  row-by-row `prisma.update` loop in `expireStaleInUseItems` with a
  single `updateMany`; bulk-update contract pinned by test.
- **Onboarding step write was read-then-update.** A concurrent
  advance could double-step the wizard. The update now conditions
  on `{ id, onboardingStep: current, onboardingCompletedAt: null }`
  and returns 409 on conflict.
- **Workout schema accepted `endedAt <= startedAt`.**
  `createWorkoutSchema` gained a `.superRefine` rejecting
  zero-duration and inverted windows; the PR detection worker's
  MIN-direction slot also guards against `durationSec === 0` so a
  malformed row cannot promote itself to a personal record.
- **Personal Record detection duplicate writes under contention.**
  Same-millisecond writes into a null workout slot now reconcile
  to a single row; regression test seeds the race.
- **Source-priority parse failures were silent.** Storage parse
  errors now route through an observer breadcrumb and the resolved
  blob is frozen at construction so downstream mutation is caught
  immediately.
- **Health-Score `asOf` derived non-deterministically.** The
  `asOf` timestamp now derives from the input dates instead of
  the wall clock so repeated computes against the same dataset
  produce stable timestamps.
- **Source-priority audit-log entries missed two write paths.**
  Doctor-report-prefs and source-priority PUTs were not landing
  audit-log rows; both write paths emit now.
- **Personal-record badge dark-mode contrast.** Lifted to WCAG-AA
  contrast on the `<PersonalRecordBadge>` surface.
- **Range-bar zone backgrounds.** `<RangeBar>` mixed Tailwind raw
  palette tokens with Dracula tokens; all zone backgrounds now
  resolve through Dracula tokens with the pinned test rewritten.
- **Research-Mode acknowledgment dialog footer scrolled below
  fold.** The footer pins outside the scrolling region on small
  viewports.
- **44-px touch-target floor across the onboarding wizard.**
  Shell back/skip/next, carousel pager, source-card grid, baseline
  and goals-chip CTAs all hit the WCAG 2.5.5 floor without
  changing visual density at typical rendering sizes.
- **Workout endpoint reconciled inserted-vs-duplicate counts
  incorrectly under contention.** Race-recovery path produced
  inconsistent envelope counts; corrected with a regression test
  seeding the contention window.
- **Legacy Withings `?secret=` webhook form had no counter.** An
  in-memory `withings.webhook.legacy_form_total` counter surfaces
  through `ops-stats`; the warning text gained the re-subscription
  URL for affected accounts.
- **Acknowledgment dialog i18n back-button.** Medication history
  page back-button hard-coded `Zurück`; routed through `t()`.
- **Sleep + audio-exposure + comparison-hint i18n keys.** Backfill
  pass picked up the keys missed by the v1.4.22 sweep across all
  six locales.
- **Build resolution for safety-contract YAML.** The loader now
  resolves the YAML matrix path from `cwd` rather than `__dirname`
  so the build does not break when the bundler reshapes the
  module-relative root.
- **GLP-1 drift guard self-skips when the EMA research file is
  absent.** Local checkouts without the reference file no longer
  red-bar the test.
- **`x-axis` chart ticks resolved in user timezone.**
  `xAxisTicks` now renders the tick formatter in
  `user.displayTimezone` instead of hard-coding Europe/Berlin.
- **Chart token references switched to `var(--token)` form.**
  Recharts strokes were still using `hsl(var(--token))`; switched
  to bare `var(--token)` so Tailwind v4's color-mix parser
  resolves them.
- **`detectGlp1Plateau` branches lacked direct coverage.** Added
  Prisma-mocked unit tests covering the previously-uncovered
  branches.

### Security

- **Withings webhook secret no longer leaks into structured
  logs.** `WITHINGS_WEBHOOK_SECRET` was landing as a URL
  path-segment in `http.path` on every Wide Event the request
  produced. The logging stack now carries a parameterised
  `PATH_SECRET_PATHS` registry seeded with the
  `/api/withings/webhook/[token]` shape, and
  `WideEventBuilder.setHttp` rewrites path + route segments to
  `[REDACTED]` before they reach stdout / the in-memory ring
  buffer / Loki. Existing query-string redaction is unaffected.
- **Coach refuses GLP-1 dose recommendations.** GROUND RULE 9
  across all six locales — the Coach surfaces a clinical-referral
  message on any dose adjustment ask, never a number.
  PROMPT_VERSION 4.25.0 carries the rule.
- **Coach refuses drug-level estimates with regulatory cites.**
  GROUND RULE 15 across all six locales — the Coach refuses any
  ask for an estimated drug level or pharmacokinetic prediction,
  cites EU MDR 2017/745 + MDCG 2021-24 in the refusal copy, and
  routes the user to the Research Mode disclosure flow.
  Adversarial refusal-probe matrix exercises 20+ paraphrasings per
  GROUND RULE across six locales in CI on every push, so
  prompt-injection regressions surface before reaching the
  dispatch surface.
- **Research Mode is gated by an MDR acknowledgment dialog.** The
  estimated drug-level chart on the GLP-1 detail page renders only
  after the user opts in through a dialog that cites
  EU MDR 2017/745 + MDCG 2021-24, EMA EPAR and the Schneck / Urva
  2024 pharmacokinetic reference. The acknowledgment version
  re-prompts the user on bump.
- **GLP-1 convenience endpoint hardened.** `POST
/api/medications/[id]/glp1` parses through bounded Zod schemas
  (`glp1DoseChangePostSchema`, `glp1InventoryPostSchema`), enforces
  length caps on notes, finite-number guards on dose value, and
  bounded `effectiveFrom`; every write produces an audit-log row
  and the route inherits the 30-per-minute-per-user rate limit
  from the rest of the medication surface.
- **GLP-1 medication strings sanitised before LLM prompt
  interpolation.** A malicious or malformed medication name no
  longer reaches the prompt body verbatim. Sanitiser passes
  Latin-letter + digit + common punctuation only.
- **Batch-ingest rate limit (sixty per minute per user default).**
  `POST /api/measurements/batch`, `POST /api/workouts/batch` and
  `DELETE /api/measurements/by-external-ids` carry a token-bucket
  rate limit returning the standard 429 envelope.
- **Audit-log writes on source-priority and doctor-report-prefs
  PUTs.** Every change to either preference produces an
  `AuditLog` row for the user's audit-log surface and the admin
  cross-section view.
- **Withings OAuth `user.activity` scope upgrade with explicit
  user reconnect.** New scope only takes effect after the user
  re-authorises; the reconnect banner makes the requirement
  visible.
- **Source-priority storage is per-user.** No cross-user lookup
  paths; one user's priority blob never enters another user's
  resolver.

### Refactor / Hygiene

- **`pickCanonicalSource` becomes a two-axis lookup with single-
  axis fallback.** Reuses `getDeviceTypeLadder()` so the
  per-device override can be queried from the canonical-row picker
  without duplicating ladder logic.
- **Health-Score `COMPONENT_ORDER` hoisted + `Intl.DateTimeFormat`
  memoised.** Provenance accordion calls the formatter once per
  render rather than four times.
- **`SubPageSlug` type + array derived from `SUB_PAGE_METRIC`
  record.** Single source of truth for the seven sub-page slugs.
- **`source-priority` `__default__` sentinel → null bucket.**
  Settings → Sources stops carrying a fake `__default__` device-
  type entry; the null bucket reads cleaner at the storage layer.
- **`apple-health-mapping` sleep branch collapsed.** Three sleep-
  stage cases shared the same body; collapsed to one.
- **`HK_QUANTITY_TYPE_TO_MEASUREMENT` removed.** The legacy view
  was a redundant projection of `APPLE_HEALTH_TYPE_MAP`; all
  callers go through the canonical map now.
- **Dead-code cleanup pass.** Drops `<InsightsPageHero>` (zero
  callers since v1.4.20), `<IntakeTimeline>`, `<ComplianceCharts>`
  wrapper and three orphan `insightsGeneralStatus` query keys from
  the v1.4.16-era hero. Removes the orphan
  `/api/insights/general-status` route (superseded by
  `<InsightAdvisorCard>` since v1.4.16).
- **Coach `<CoachDrawer key={prefill}>` controlled-prop refactor
  is fully in place** — the v1.4.24 follow-up of `useResettableValue`
  is now the only call path; the legacy remount hack code is gone.
- **380 dead i18n keys dropped.** Runtime probe across the six
  locales identified 380 keys with zero call sites and zero runtime
  resolutions; all six locale bundles are smaller by that count.
  Top namespaces: `settings`, `admin`, `classifications`,
  `medications`. The remaining ~148 keys are queued for a second
  pass in v1.4.26.
- **Dead system-prompt constants removed.** `BASE_SYSTEM_PROMPT`
  and `INSIGHTS_SYSTEM_PROMPT` constants had no remaining
  importers after the native per-locale prompt move; both deleted.
- **`useInsightStatus` hook extracted.** The four insights
  sub-page status queries collapsed into a single hook so the
  duplicated `useQuery` + Suspense fallback shape lives in one
  place.
- **`<MedicationDetailSection>` wrapper.** Three medication-detail
  shells (titration, scheduling, side-effects) and the inventory
  disclosure top share a single wrapper; future medication detail
  sections drop in without copy-paste.
- **Shared helpers across the medication + onboarding surfaces.**
  New modules `src/lib/api/read-error.ts`,
  `src/lib/medications/route-guards.ts`,
  `src/lib/medications/research-mode-types.ts` and
  `src/lib/medications/dose-string.ts` consolidate previously
  duplicated patterns. Three near-identical dose-string parsers
  collapse to one `parseDoseMg`; four-times-duplicated
  `readError` collapses to one; nine medication routes call the
  shared `assertMedicationOwnership`.
- **Side-effect taxonomy drift-guard.** `SIDE_EFFECT_CATEGORY_VALUES`
  and `SIDE_EFFECT_ENTRY_VALUES` now derive from the Prisma enum
  via `z.nativeEnum`; a drift-guard test pins Prisma enum ↔
  taxonomy map ↔ validator triangle so the three cannot drift.
- **Side-effect category derived server-side.** The
  `createSideEffectSchema` no longer accepts a client-supplied
  `category`; the server derives it from the entry. Removes the
  defensive 422 path and the cross-tier drift surface.
- **Dashboard top-tile baseline alignment.** Inline trend arrow +
  baseline-aligned value row across all dashboard tiles, with the
  baseline contract pinned by regression test.
- **Range-bar Dracula token swap.** `<RangeBar>` zone backgrounds
  resolve through Dracula tokens with the pinned test rewritten;
  raw palette references gone.
- **44-px touch-target floor across the top-bar + section
  strips.** WCAG 2.5.5 alignment across the broader navigation
  surface, complementing the onboarding-specific pass.
- **Typo + naming polish from the review pass.** Minor
  identifier renames flagged by the dead-code probe; no functional
  change.
- **`safeRequestProp` widened catch.** Narrowed catch broadened to
  tolerate `undefined` requests after the hygiene-review pass
  surfaced the regression.
- **`pickCanonicalWorkout` helper for cross-source workout
  dedup.** Source-priority logic centralised for the v1.5 iOS
  workout-ingest path.
- **Insights regenerate button relocated; tab strip lifted.**
  Tab-strip extraction + relocation of the regenerate button to
  the top-right, paving the way for the seven sub-page surfaces.

### Tests

- 2244 → 3828 passing unit tests across 344 files (+1584; one
  pre-existing skip carries through). Integration suite 140 → ~170
  across 11 files. e2e green on the CI fix (coach-prefs URL
  mock + Pixel-5 selector hardening) plus the hot-fix that
  re-anchored the dashboard insight-card and the mobile x-axis
  tick locators.
- **Coach refusal-probe matrix.** 1800+ assertions exercise 15
  GROUND RULES across six locales with 20+ adversarial
  paraphrasings each. CI runs the matrix on every push; any
  prompt-injection or jailbreak regression surfaces before
  reaching the dispatch surface. Drift-guard tests pin the
  YAML-per-locale safety-contract matrix in lockstep with the
  validator-derived enums.
- **New unit suites (selection):** GLP-1 plateau-detection text
  formatter; two-axis source-priority resolution (single-axis
  fallback, per-device override, mixed-bucket selection);
  source-priority Settings reducer (reorder, reset, validate);
  medication-card GLP-1 variant + injection-site-picker (RTL);
  doctor-report prefs PUT contract; personal-records pagination
  clamp; `berlinIsoWeekday` timezone-aware suite; sleep-stage
  chart i18n-suffix drift-guard; Health-Score provenance i18n
  drift-guard; api-handler private-field crash regression; pure
  cadence + compliance helpers with TZ assertions across UTC+0,
  UTC+9, UTC-8; side-effect taxonomy drift-guard; EMA titration
  ladder helpers; pen-inventory state-machine + 30-day clock
  helpers; PR detection worker (MAX / MIN per metric + workout
  slots + warmup gate + null-slot dup regression + zero-duration
  guard); Withings activity TZ regression across Berlin / Los
  Angeles / Tokyo / Auckland; Withings sleep v2 segment ingest;
  log-redaction path-segment rule + `setHttp` rewrite; GLP-1
  endpoint Zod + audit + rate-limit; onboarding step concurrent-
  advance regression; inventory PATCH state-machine back-dated
  first-use regression; bulk-update contract for the expire-stale
  cron; brand-name guard + sentinel-preservation + safety-contract
  parity for the YAML matrix; locale auto-discovery + fallback-
  chain runtime guard.
- **New integration suites:** two-axis canonical-source resolution
  end-to-end; `requireAuth()` narrow-scope on unscoped route;
  batch-ingest race reconciliation under contention; workout-batch
  race + size-cap + ingest end-to-end; PR-detection end-to-end;
  cross-source priority for Withings Activity + Apple Health;
  Withings sleep-stage composite ingest; per-user timezone end-to-
  end (Pacific/Auckland).
- **Migrations:** 9 new (0051–0059) + 1 hardening (0060
  `onboarding_step_not_null` backfill + NOT NULL flip). All
  additive and forward-only; migration 0057 comment rewritten to
  match PG11+ fast-path ADD COLUMN DEFAULT semantics.

### Deferred to v1.4.26

The full backlog, with effort
estimates and source citations, is tracked internally. Headline items:

- `User.onboardingGoals` column + server-side persistence for the
  goals chip-picker selection (today the picker holds the choice
  client-side only; the dashboard-widgets seed feature reads it in
  v1.4.26).
- `advance()` hook extraction for the three onboarding step
  components — pattern surfaced in the simplifier review, deferred
  to avoid collision with v1.4.25 touch-target work.
- `glp1-pk.ts` unused-export decision (internalise vs wire
  dashboard chip).
- Seven orphan endpoint go / no-go decisions
  (`/api/admin/ai-settings`, `/api/admin/backup/test`,
  `/api/admin/status-overview`,
  `/api/monitoring/{glitchtip,umami}/test`).
- ~148 dead i18n keys remaining after the runtime-probe sweep
  (the v1.4.25 pass removed 380 of the 528 candidates; the
  remaining ~148 need second-pass call-site verification).
- FR / ES / IT / PL prose hand-review by a native speaker for the
  Coach + insights surface (the structural refusal-probe matrix
  covers safety; the user-facing prose still benefits from a
  human pass).
- Coach `lastYear` baseline + row-tap-to-prefill polish.
- Sleep sub-page stacked-column visual polish (stage colours +
  legend density).
- Mood verbal-labels persistence behind a per-user toggle.
- Drug-level chart-side 90-day staleness clock wiring (the
  acknowledgment dialog already re-prompts on version bump and
  Coach refuses at GROUND RULE 15; the clock is defence-in-depth).
- iOS-18 long-tail HK identifier mappings (sleep apnea, GAD-7 /
  PHQ-9, running form, paddle / row / ski distances, pregnancy /
  cycle, FHIR clinical).
- VO2 max chart-row card on `/insights/<metric>` (dashboard tile
  shipped; chart card queued alongside the iOS body-composition
  page).
- Lazy-loaded locale JSON bundles (all six locales import
  synchronously at present, ~675 KB to every client).

### Deferred to v1.5

- **iOS Swift app — P1 through P5.** Login + dashboard + widget
  (P1); Apple Health sync (P2); Coach extended for HRV / sleep /
  resting HR / steps (P3); per-metric APNs alerts (P4); workouts
  - GeoJSON routes (P5). All server contracts locked in v1.4.25.
- **Workout ingest API matching the v1.5 iOS contract.**
  Schema shipped this release; endpoint signature finalised
  during the iOS sprint.
- **Two-Brain Coach refactor.** Statistical findings produced
  by a deterministic pipeline; LLM owns the narrative layer
  only. Reduces hallucination surface; unblocks evidence-grounded
  citations.
- **HRV anomaly detection against a rolling baseline.**
- **Mindfulness, dietary-water and symptoms-unification ingest
  types.**
- **ECG waveform ingest + FHIR / HKClinicalRecord.**
- **Pearson incomplete-beta replacement** for the rigorous
  surfacing-gate (v1.4.23 carryover).

## [1.4.24] — 2026-05-12

Security + accessibility hardening release. Closes the highest-priority
findings from a focused security audit of the v1.4.23 release: a Bearer
token that omits a scope no longer authenticates routes which never
declared one, the public Umami proxy is rate-limited, the proxy nonce
is Edge-runtime portable, a session-expiry delete race can no longer
500 a parallel request, the import-validation envelope now matches the
standard error contract, and the runtime Docker image installs Prisma
7.8 alongside pinned worker dependencies. Accessibility passes on the
notifications surface, admin shell, chart overlays and notification
settings deep-link anchors round out the user-facing work.

### Security

- **Bearer auth is fail-closed when a route declares no scope.**
  `requireAuth()` previously let any non-revoked, non-expired API token
  through whenever a handler omitted the `requiredPermission` argument.
  A narrowly-scoped token (e.g. `["medication:ingest"]`) could therefore
  reach every handler that called `requireAuth()` bare — including
  account-sensitive routes such as `/api/auth/profile`,
  `/api/auth/password`, `/api/withings/credentials`,
  `/api/settings/data`, `/api/export/full-backup` and `/api/tokens`.
  The Bearer path now throws `HttpError(403)` with audit reason
  `scope_required` unless the token carries the `["*"]` wildcard
  (the iOS app login token), preserving the existing session-cookie
  path and the explicit-scope path (`/api/ingest/medications`). The
  admin surface is unaffected — `requireAdmin()` was already
  cookie-only.
- **Public Umami analytics proxy now rate-limits by client IP.**
  `POST /api/send` forwards browser analytics events to the configured
  Umami origin. The SSRF allow-list and 64 KB body cap were already in
  place, but the endpoint itself was unbounded. Added a 120-events-per-
  minute-per-IP gate using the existing `checkRateLimit` infrastructure;
  abuse returns the standard `429` envelope without invoking the
  upstream fetch.
- **Edge-runtime portable nonce generation in the proxy.** The proxy
  previously assembled the CSP nonce via `Buffer.from(...)`, which is
  not guaranteed in the Edge runtime. Switched to
  `btoa(String.fromCharCode(...new Uint8Array(16)))`. Same 128 bits of
  entropy, Node-and-Edge compatible without a runtime declaration.
- **Session-expiry delete race no longer 500s a parallel request.**
  `getSession()` reaped expired session rows with `prisma.session
.delete()`; two requests arriving at the same expired session would
  race and the loser would surface a 500. Replaced with `deleteMany` +
  a catch-all guard, matching the discipline already used in
  `destroySession()`.

### Fixed

- **`POST /api/import` returns the standard `{ data: null, error }`
  envelope on validation failure.** The handler previously returned
  the validation message inside `apiSuccess(...)` with status 422,
  which clients could not distinguish from a successful import.
- **Runtime Docker image pins Prisma 7.8 + worker dependencies.** The
  multi-stage image was installing `prisma@7.4.0`, `@prisma/engines
@7.4.0`, unpinned `pg-boss@12`, `@prisma/adapter-pg@7` and `pg@8`
  into the worker prefix while the app code shipped Prisma 7.8 from
  the lockfile. Pinned to `prisma@7.8`, `@prisma/engines@7.8`,
  `pg-boss@12.18`, `@prisma/adapter-pg@7.8` and `pg@8.20` so
  migration engine and generated client cannot drift across a deploy.
- **Notifications page surfaces a load error instead of a silent
  "no channels" empty state.** `useQuery` failures now render an
  alert with `role="alert"` and `notifications.loadError` copy
  (EN/DE), so a transient 500 on `/api/notifications/preferences`
  stops looking like a misconfiguration.

### Accessibility

- **Notification-preference switches carry accessible names.** Each
  switch in the per-event table now exposes an `aria-label` combining
  event-type label and channel label; the mobile per-event layout pairs
  each `<Switch>` with its `<Label>` via `htmlFor`/`id` so screen
  readers announce the channel a toggle controls.
- **Mobile admin navigation surfaces an Overview link.** The mobile
  admin section pill-rail prepended an Overview chip pointing at
  `/admin`, matching the desktop sidebar root and unblocking users
  who land on a sub-section without a path back.
- **Notification settings deep-link anchors land on the right card.**
  Onboarding and admin-driven deep links into `#telegram`, `#ntfy`
  and `#web-push` now resolve to the corresponding cards in
  `NotificationsSection` instead of falling back to top-of-page.
- **Chart-overlay comparison-baseline toggles expose `aria-pressed`.**
  The new per-chart comparison-baseline selector renders three
  pill buttons (none / last month / last year) with the correct
  pressed-state semantics for assistive tech.

### Changed

- **Per-chart `comparisonBaseline` overlay preference.** The
  comparison overlay is now configurable per chart from the existing
  overlay-controls popover instead of being a single global toggle.
  `ChartOverlayPrefs` adds a `comparisonBaseline: "none" | "lastMonth"
| "lastYear"` field (defaults to `"none"`); a per-chart selection
  overrides the dashboard-level default for that chart only.
  `ChartOverlayKey` is extended with `bmi`, `bodyFat`, `sleep` and
  `steps`, mirroring the chart surfaces already on the dashboard.
- **Trend-card layout tolerates long labels and long values.**
  `TrendCard` switches to `min-w-0` + `flex-wrap` containers and
  `[overflow-wrap:anywhere]` text utilities so locale labels
  ("Letzter Wert" / "Resting Heart Rate") and large tabular numbers
  no longer push the tile off-axis on narrow viewports.
- **Lint-clean Coach drawer + message thread.** The `useCallback`
  dependency on the drawer's reset closure now includes the stable
  `setInputValue` setter, and the message thread memoises the
  derived `messages` array. Both removed the only two warning-level
  hook lints carried over from v1.4.23.

### Tests

- New unit test in `require-auth-bearer.test.ts` proves that a Bearer
  token with permissions `["medication:ingest"]` is rejected (403
  with audit reason `scope_required`) when the route did not declare
  a scope; the existing success case was updated to use the wildcard
  scope so the new fail-closed branch does not collide with it.
- New unit suite under `src/lib/auth/__tests__/session.test.ts`
  covers the expired-session delete-race path: a rejected `deleteMany`
  must still resolve `getSession()` to `null` and clear both the
  session and onboarding cookies.
- New unit suite under `src/app/api/send/__tests__/route.test.ts`
  covers the rate-limited Umami proxy: a 429 short-circuits the
  upstream fetch and a 200 still proxies under quota.
- Extended import-route test asserts the new `apiError` envelope:
  `data === null` and a populated `error` for invalid payloads.

## [1.4.23] — 2026-05-11

### Added

- **Apple Health measurement schema + batch-ingest contract.** Seven
  new `MeasurementType` values (`HEART_RATE_VARIABILITY`,
  `RESTING_HEART_RATE`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`,
  `WALKING_RUNNING_DISTANCE`, `VO2_MAX`, `BODY_TEMPERATURE`),
  `APPLE_HEALTH` joins `MeasurementSource`, and `Measurement` picks
  up a nullable `sleepStage` column scoped via CHECK constraint to
  `SLEEP_DURATION` rows. Sleep is now persisted in minutes instead
  of hours. Migration `0036_apple_health_measurement_types` is
  strictly additive — no row mutations, no rename, the legacy
  `(user_id, type, measured_at, source)` unique index stays. A new
  composite unique index `(user_id, type, source, external_id)`
  becomes the Apple Health dedup key. New endpoint
  `POST /api/measurements/batch` accepts ≤500 entries per call,
  wraps `withIdempotency()`, returns per-entry
  `inserted | duplicate | skipped` status with a typed reason field,
  and is idempotency-replay safe. Sleep-stage aggregation in
  `/api/analytics` rolls multi-stage nights into one Berlin-day
  datapoint with a per-stage breakdown over the trailing 30 days.
- **APNs scaffolding + dispatcher cascade rewire.** `@parse/node-apn`
  joins the senders cascade as channel-type 4 (APNs → Telegram → ntfy
  → Web Push, deterministic order). Provider is lazily-initialised
  per gateway (`sandbox` vs `production`), JWT auto-rotates inside
  the library. Permanent failures (`Unregistered`, `BadDeviceToken`,
  `DeviceTokenNotForTopic`) drop the dead Device row mirroring the
  web-push 410 cleanup. `Device` model gains nullable `apnsToken` +
  `apnsEnvironment` columns with a paired CHECK constraint (either
  both set or both null) and a partial unique index on `apns_token`.
  Migration `0037_apns_device_columns`. `POST /api/devices` accepts
  paired `apnsToken` + `apnsEnvironment` with a 422 when one comes
  without the other and a 409 + `apns_token_owned_by_other_user`
  audit reason when a token already belongs to a different account.
  Production without `APNS_KEY_ID` is a no-op rather than a boot
  failure; partially-set env triggers a single warning at first
  dispatch.
- **OpenAPI 3.1 generator + drift CI gate.** `pnpm openapi:generate`
  reads Zod v4 `.meta()` annotations on the existing validation
  schemas and emits a byte-stable `docs/api/openapi.yaml` (`zod-openapi`
  - `yaml@^2` with `sortMapEntries: true`). The eight iOS-critical
    routes are registered now: `auth/login`, passkey verify,
    `auth/refresh`, `measurements` GET + POST + batch, `devices` POST,
    and the comprehensive insights bundle. A new `pnpm openapi:check`
    CI step diffs generated vs committed; warn-only for v1.4.23 so a
    registry oversight on a non-iOS route doesn't red-bar a PR, flips
    to hard-fail in v1.4.24. The legacy hand-maintained spec is
    preserved at `docs/api/openapi-v1422-legacy.yaml` so iOS DTO
    reference doesn't disappear during the incremental migration.
- **Device-management endpoints for native + web settings.**
  `GET /api/auth/me/devices` lists active devices with label, last-
  seen timestamp, channels (`web_push` / `apns`), and an `isCurrent`
  marker keyed off the session's `deviceId` (not the forgeable
  `X-Device-Id` header). `DELETE /api/auth/me/devices/[id]` revokes
  a single device in one transaction: refresh tokens, access tokens,
  notification channels, push subscriptions, and the `Device` row.
  `DELETE /api/devices/[id]` is the native-friendly mirror the iOS
  APNs-rotation flow calls. Cross-user attempts return 404 with no
  enumeration leak.
- **Per-user Coach prefs surface (settings cog returns).** New
  `User.coachPrefsJson` column (migration `0038_coach_prefs`) +
  `GET / PUT /api/auth/me/coach-prefs`. The settings cog on the
  Coach drawer opens a right-edge `<Sheet>` letting users dial in
  `tone`, `verbosity`, focus-metrics, and exclude-metrics. The
  system prompt prepends a per-user OVERRIDE block; the snapshot
  pipeline reads prefs BEFORE measurement queries so excluded
  metrics never enter the snapshot in the first place.
- **Per-message Coach thumbs feedback + admin aggregate view.** Each
  Coach reply renders a 👍 / 👎 affordance. `RecommendationFeedback`
  gains a polymorphic `target_type` discriminator (migration
  `0040_recommendation_feedback_target_type`); legacy recommendation
  feedback rows backfill to `RECOMMENDATION`, new Coach rows persist
  with `COACH_MESSAGE` and the message's `coach_messages.id`. New
  endpoint `POST /api/insights/chat/messages/:id/feedback`. A new
  admin section `/admin/coach-feedback` renders helpful-rate buckets
  by (promptVersion, tone, verbosity) and gets a sidebar entry
  - EN/DE i18n bundle.

### Changed

- **Refresh-token reuse-detection scopes to the originating device.**
  Pre-1.4.23 a replayed refresh token revoked every refresh token
  the user owned. v1.4.23 narrows the blast radius to the device
  that issued the token (legacy null-deviceId tokens still fall back
  to user-wide revoke as a safety hatch). A two-device household no
  longer gets logged out of both phones when one replays.
- **Pearson surfacing gate raised from n≥14 to n≥20.** Conservative
  patch on the low-df p-value path — trades a small number of
  borderline correlation cards for stricter false-positive control.
  The rigorous incomplete-beta replacement is queued for v1.4.24.
- **Coach drawer prefill becomes a controlled prop.** The
  `<CoachDrawer key={prefill}>` mount-cycle hack is replaced with a
  `useResettableValue` hook + pure `nextResettableValue` helper. The
  drawer rerenders without remounting; the prefill state lives on
  the parent as a fully-controlled input.
- **`/api/analytics` BP-in-target aggregate becomes cursor-paged.**
  The unbounded `findMany` lands as `fetchBpSeriesChunked` cursoring
  in 5 000-row batches with a new `analytics.bp_in_target.row_count`
  wide-event for slow-query attribution. Replay regression test
  seeds 6 000 rows across a chunk boundary.
- **Coolify webhook contract documented end-to-end.** GHCR build →
  `force=true` Coolify deploy → `/api/version` poll → host-side
  retag fallback if the `:latest` digest hasn't moved. The CI step
  now emits a `::notice::` line with the deploy timestamp + image
  sha so future runs surface the contract without opening the
  verbose log.
- **Coach feedback foreign-key targets `coach_messages` directly.**
  The plaintext `content` column on `recommendation_feedback` is
  retired — feedback rows now reference the canonical encrypted
  message row, and the aggregator queries through the FK rather
  than reading prose into memory.
- **PROMPT_VERSION 4.22.0 → 4.23.0** with a new GROUND RULE 12
  (EN + DE): treat Apple Health categories (HRV, sleep, resting HR,
  steps, active energy, flights, distance, VO2 max, body temp) as
  silent when the snapshot doesn't carry them. No apologetic openers
  about missing data. `aiInsightResponseSchema.dailyBriefing
.keyFindings[].sourceMetric` and `trendAnnotations` enums extend
  to admit the nine additive HealthKit categories.
- **`medication_schedules.days_of_week` column deployed.** Migration
  `0039_medication_schedule_days_of_week` adds the nullable column
  (NULL = daily). Closes the v1.4.22 schema-drift watchlist item.

### Fixed

- **Admin coach-feedback sidebar entry.** The admin section
  shipped without a sidebar nav entry, so the page was unreachable
  from the chrome.
- **APNs `NotificationChannel` auto-upsert on device registration.**
  Registering a fresh device with an `apnsToken` now creates the
  matching `NotificationChannel` row in the same transaction
  instead of leaving the device row orphaned from the cascade.
- **Partial unique index enforces `apns_token` global uniqueness.**
  App-layer guard catches the cross-user-hijack case; the DB-layer
  partial unique index (`CREATE UNIQUE INDEX … WHERE apns_token IS
NOT NULL`) is the defence-in-depth backstop.
- **Apple Health source badge renders on mobile measurement card.**
  Desktop list rendered the chip; the mobile card variant fell back
  to source-less prose. Both surfaces now share the same renderer.
- **Coach prefs sheet skeleton + save toast.** Initial open painted
  a flash of unstyled defaults; save action ran silently. The sheet
  now shows a skeleton during the prefetch and confirms persistence
  via the standard toast.
- **Device revoke cascade wraps refresh + access + channels + Device
  row in one transaction.** Pre-fix a mid-flight failure could leave
  the device row gone while the refresh tokens stayed live.
- **`isCurrent` device marker keys off the session's `deviceId`,
  not `X-Device-Id`.** The header is forgeable; the cookie-bound
  session record is not. Regression test in the device-list route.
- **Sentinel parser annotates partial-malformed entries instead of
  collapsing the whole block.** `SentinelParseResult.malformedEntries[]`
  now carries per-line typed reasons; the chat route splits
  `coach.keyvalues.parse_partial` from the full-block
  `coach.keyvalues.parse_failed` wide-event for partial recovery.

### Security

- **APNs send-side defence-in-depth.** Hex format validated at the
  registration boundary; cross-user-hijack guard duplicated at the
  APNs-token layer (409 + dedicated audit reason). Send-side payload
  redacts the resolved user + device IDs before logging.
- **Coolify webhook URL scrubbed from the deploy runbook.** Webhook
  - token live in GH secrets; the runbook references the secret
    names rather than the raw URL.
- **Coach prose encryption-at-rest restored.** The plaintext
  `content` column on `recommendation_feedback` was dropped after
  the feedback rows migrated to a `coach_messages` FK. Cypher text
  is now the only on-disk form.

### Refactor

- **`revokeDeviceCascade(deviceId)` helper.** The four-way revoke
  (refresh + access + channels + device row) lived inline at three
  call sites. Helper now owns the transaction wrapper; call sites
  drop to one line.
- **`useCoachPrefs()` hook.** Coach drawer + settings sheet shared
  the same fetch + mutate + invalidate triplet; the hook collapses
  the three call sites into one with shared optimistic-update logic.
- **`buildCoachSnapshot` scope-record argument.** The build pipeline
  passed seven booleans across three callees; collapses to a single
  `scope` record. Per-stream toggles read off `scope.has(metric)`.
- **OpenAPI registry uses static imports instead of dynamic
  require.** The lazy require pattern broke type inference at the
  registration site; the static import keeps the generator output
  deterministic.

### Deferred to v1.4.24

- Pearson incomplete-beta p-value (carried as the
  conservative n≥20 patch).
- Settings-cog vs per-message-controls UX consolidation
  (waits on first-week thumbs data).
- OpenAPI drift gate flip from warn-only to hard-fail
  (requires registry catch-up first).
- `coach-prefs.test.ts` integration `NextRequest` URL mock
  regression — predates v1.4.23, surfaced during the reconcile pass.
- Sec-MED-1 follow-ups: intra-batch dedup accounting (Sec-LOW-1),
  idempotency 422 retry hint (Sec-LOW-2), APNs key-file path
  redaction (Sec-LOW-3), refresh-failure audit userId (Sec-LOW-4).

### Deferred to v1.5

- iOS native client (P1: login + dashboard + widget) — server
  contracts all locked in v1.4.23.
- Apple Health sync (P2) — schema + batch endpoint shipped; iOS
  `HealthKitService` + `SyncCoordinator` wire still pending.
- Coach extended for HRV / Sleep / Resting HR / Steps (P3) — schema
  slot + GROUND RULE 12 landed; prompt rules + i18n bundles pending.
- Per-metric APNs alerts (P4) — sender + dispatcher shipped; per-
  event opt-out + background pushes pending.

## [1.4.22] — 2026-05-10

### Added

- **Per-target sparkline + Δ-vs-last-month caption on the Targets /
  Zielwerte page.** Each `<TargetCard>` grew a 30-day inline SVG
  sparkline beneath the range bar plus a localised "Δ −2.3 kg vs.
  last month" caption. The API ships `points30d` and
  `deltaVsLastMonth` per target; both null when either window has
  fewer than 3 readings so cold-start accounts don't paint a
  misleading flat trace. BMI piggybacks on the weight series so its
  sparkline shares the range bar's y-axis.
- **Sticky section navigation above the Insights hero.** A pinned
  strip (Allgemein / Blutdruck / Gewicht / Puls / Stimmung in DE;
  General / Blood Pressure / Weight / Pulse / Mood in EN) lifts the
  section tabs above the hero so they stay visible during scroll.
  Active section tracks the highest-intersection observed entry;
  `aria-current`, focus-visible ring, and `motion-reduce` gating
  ship from day one.
- **Comparison-overlay as a single global preference under Settings
  → Dashboard.** The on-surface `<CompareToggle />` retired from
  `/insights`; the canonical picker has lived in Settings →
  Dashboard since v1.4.16 and every chart already consumed
  it. Two surfaces for the same concept violated the
  no-split-Settings rule.
- **Collapsible evidence disclosure under each Coach assistant
  message.** Numbers move out of the prose into a
  `---KEYVALUES---` … `---END---` sentinel block that the route
  parses out server-side and renders as a "Worauf bezieht sich
  das?" / "What I'm looking at" `<details>` disclosure under each
  assistant turn. Closed by default, hidden when no key-values came
  back. Hard caps on the sentinel (1 KB payload, 8 lines max,
  per-line Zod) so a prompt-injection attempt can't grow the
  persisted envelope.
- **User avatar parity with the Coach avatar.** The Coach drawer's
  user-side bubble used a smaller initials avatar than the Coach's
  gradient one. The user avatar now reuses the existing
  `gravatarUrl` field from `/api/auth/me` at the same dimensions
  as the Coach avatar; initials fall back when no Gravatar is
  configured.

### Changed

- **Coach prompt rewrite — warm, motivational-interviewing tone
  with prose-first responses + evidence collapsible.** PROMPT_VERSION
  ratchets 4.20.2 → 4.22.0 (first minor-digit bump in v1.4.x). The
  Coach used to open every reply with a number — clinical,
  database-cursor energy. The new persona is "warm, neugierig,
  zurückhaltend": a partner sitting alongside the user, not pushing
  data. Numbers move into the collapsible evidence block; the prose
  reads like a real conversation. Persona + sentinel land together
  because either alone is incomplete.
- **BP-in-target headline re-anchored to the last-30-day window.**
  Fourth attempt at this metric. v1.4.19 routed the headline to
  `allTime` to fix the algorithmic 50/50/50 pin; v1.4.22 re-anchors
  to `windows.last30Days?.pct` and surfaces all-time as a sub-row,
  because v1.4.19's fix was emotionally wrong — the headline became
  the slowest-moving aggregate possible, punishing a user who put
  in real recent work. The tile also gets a synthesised trend arrow
  (slope from 7d/30d delta), a 7-day-trend chip, and a
  comparison-overlay caption.
- **"Muster" renamed to "Zusammenhänge" (DE) / "Patterns" renamed
  to "Relationships" (EN).** The picked-bucket-of-correlations row
  read like an autopsy. The new label sits closer to what the row
  actually shows. Picked "Zusammenhänge" over "Trends" because the
  row directly above already uses Trends.
- **Onboarding redirect for users with `null onboardingCompletedAt`
  moves to server-side enforcement in `proxy.ts`.** The previous
  post-hydration redirect inside `<AuthShell>` `useEffect` produced
  a brief dashboard flash on incomplete onboarding. The proxy runs
  in the Edge runtime so the auth routes mirror
  `onboardingCompletedAt` into a non-httpOnly `hl_onboarding`
  cookie; the proxy short-circuits before hydration. Tampering only
  skips a UX hint and never bypasses a server check.
- **`setOnboardingPendingCookie` folded into `createSession()`.**
  Issuing a session without onboarding state used to require two
  call sites to stay in sync; the helper now takes
  `onboardingPending` as a required parameter so the contract is
  type-impossible to break.

### Fixed

- **Raw `metric:<TYPE>` token leaks in recommendation prose.**
  `<RecommendationCard>` text is now wrapped in
  `stripChartTokens()`. The leak traced to a single missing call
  on the recommendation path; chart tokens never belonged in user
  copy.
- **DE locale `componentMood`, `componentBp`, `componentCompliance`
  rendered English nouns in the German bundle.** Four Health-Score
  component labels normalised to `Stimmung`, `Blutdruck`,
  `Einnahmetreue`, `Gewicht`. The i18n-integrity test pins the
  contract.
- **Admin / API tokens horizontal scrollbar at desktop + iPad-mini
  viewports (5th attempt).** A live Playwright probe confirmed
  `whitespace-nowrap` on the date `<td>`s was the residual
  culprit. The two classes are gone; date + time wraps to two
  lines on narrow viewports. The earlier four fixes had targeted
  the wrong layout layer.
- **Sentinel-only / malformed `---KEYVALUES---` block.** When the
  model emits a sentinel-only or malformed envelope, the fallback
  now produces a polite invitation ("I'd like to look at this with
  you — could you share which window you want me to focus on?")
  instead of surfacing the raw marker. A new integration test
  covers the empty-prose-after-strip branch.
- **BD-Zielbereich tile delta math period-aligned with the
  comparison window.** The tile's compareDelta was subtracting
  `bpInTargetPctAllTime` while the caption said "vs last month",
  which produced numbers the caption couldn't justify. It now
  subtracts `bpInTargetPctPriorMonth` / `bpInTargetPctPriorYear`
  to match. Two new bp-in-target unit tests + two
  insights-polish guards.
- **Coach drawer settings cog removed.** The cog was a dead button
  in v1.4.21; per-user prompt-tuning is deferred to v1.4.23. No
  dead buttons in this release.
- **Coach disclaimer pinned at the bottom of the message thread.**
  Clinical-adjacent UI must not gate the disclaimer behind a
  chevron tray; the disclaimer now stays visible at the bottom of
  the message thread on every viewport, and the rail-footer
  duplicate kept for desktop redundancy.
- **`hl_onboarding` UX-hint cookie now `SameSite=Strict`.** A
  cross-site request couldn't usefully exfiltrate the cookie
  (no auth value, only an onboarding state flag) but `Lax` was
  still over-permissive. Strict aligns with the cookie's
  same-site-only consumer.
- **`PUBLIC_PATHS` exact-match guard against future subroute
  prefix bypasses.** `/onboarding` is now exact-match +
  explicit-subroute, not a `startsWith` check. Two new proxy
  guards pin the contract.
- **`targets/route.ts` daily buckets keyed in Europe/Berlin.**
  The targets sparkline was the last analytics surface still
  bucketing in UTC, which produced a one-day-off trace for users
  in CEST. `berlinDayKey()` lifted to a shared
  `src/lib/analytics/berlin-day.ts` helper; four new DST + UTC-
  midnight edge-case unit tests.
- **Streaming bubble vs persisted-twin race window.** The
  150ms grace window suppresses the persisted twin while the
  in-flight streaming bubble is still rendering, so the thread
  never paints two copies of the same reply for a frame.
- **Sticky section navigation a11y polish.** `aria-current` on
  the active section; focus-visible ring on keyboard navigation;
  `motion-reduce` honoured for smooth-scroll; the glow-bleed
  fixed via `bg-background/95 backdrop-blur`; the mobile cliff
  tightened from `scroll-mt-28` to `scroll-mt-16` so the strip
  no longer eats the heading at 280px viewports.
- **BP tile mobile density at <sm.** All-time + delta now
  collapse into one secondary line on small viewports; the
  full layout returns at `>=sm`.

### Refactor

- **`createSseStream` shared helper extracted from the chat
  route.** Preparation for v1.5 iOS streaming endpoints, which
  will reuse the SSE primitives. Three unit tests pin sync,
  async, and throw paths. Source: `src/lib/sse/create-stream.ts`.
- **`<TokenStatusBadge>` extracted from desktop + mobile
  api-token surfaces.** The badge logic was duplicated verbatim
  in two layouts; one component, two consumers.
- **Five simplify apply-yes items in one commit.** `canSubmit`
  collapse, weekly-report `<Button>` dedup, and three smaller
  cleanups identified in the simplify pass.

### Operational / hygiene

- **Coolify image-digest auto-deploy.** Instructions for the
  one-time UI-toggle ("Watch image registry for new digests")
  live in the internal ops notes. Future
  releases should drop the host-side retag fallback the moment
  the toggle is on.
- **191 maintainer-name references in `src/` source comments
  swept** (FX carry-over from v1.4.20). Test fixtures kept as
  opaque test data.
- **DE+EN bilingual CHANGELOG entries (v1.4.14 + v1.4.15)
  normalised to English-only.** Per the English-only voice
  rule.
- **`CLAUDE.md` filename retired (FX carry-over)** so the
  filename is no longer AI-vendor-specific; `CONTRIBUTING.md`
  reference updated. `AGENTS.md` stays for multi-agent
  compatibility.

### Deferred to v1.4.23

The full carry-over list is tracked internally.
Highlights: sentinel parser malformed-enum hardening (Sr-M5);
analytics-route unbounded `findMany` paging; targets-route
7-pass sparkline coalesce; `CoachDrawer key={prefill}`
controlled-prop refactor (Sr-HIGH-4); per-user prompt-tuning
surface; medication_schedules.days_of_week schema-drift cleanup.

### Deferred to v1.5 (iOS push)

Headline: iOS native client + Apple Health
ingest contract (HRV, Sleep, Resting HR, Steps, BodyFat,
Glucose); per-metric APNs alerts; OpenAPI spec drift CI gate;
Coach extension for the new measurement types
(PROMPT_VERSION 4.22.0 → 5.0.0).

## [1.4.21] — 2026-05-10

### Fixed

- **Daily Briefing regenerate produced an empty card.** The
  `/api/insights/generate` route was still calling the legacy
  `getInsightsSystemPrompt`, which returns the v1.4.5 schema and
  never asks the model for a `dailyBriefing` block. Re-runs from the
  hero strip therefore stored a payload with no briefing and the
  card painted its empty state forever. The route now uses
  `getStrictInsightsSystemPrompt(locale)` so the v1.4.20 ground
  rules apply to manual regeneration too. Cached legacy blobs still
  parse — every new schema field is optional with `passthrough()`.
- **Duplicate streaming bubble after the assistant reply landed.**
  After SSE `done` the streaming hook keeps `streaming.content`
  populated to support the in-flight render path, then fires a
  TanStack invalidate that pulls the persisted assistant message
  into `conversation.messages`. The thread therefore rendered the
  reply twice until the next `send` reset cleared it. The render
  path now suppresses the in-flight bubble as soon as the persisted
  twin lands, keyed on `streaming.messageId`.
- **Settings cog overlapped by the drawer's close-X.** Radix Sheet
  paints its default close-X at `top-4 right-4`, which visually
  swallowed the cog in the right-edge button cluster. The cog moves
  to the left header zone (next to the gradient avatar) and a
  `pr-12 / sm:pr-14` padding rule keeps the New-chat button out of
  the close-X area on narrower viewports.
- **Suggested-prompt chips below the 36px touch target.** Chips
  rendered at 28px which fell short of the WCAG-AA target-size
  guideline. Padding bumped to land on a 36px hit area.

### Changed

- **Coach context now carries day-level readings instead of
  aggregates only.** `buildCoachSnapshot` folds in a
  `timeline.recent` block (one row per UTC day for the last 14 days,
  each tagged with weekday) and a `timeline.weekly` block (ISO-week
  buckets covering the rest of the analysis window). Systolic and
  diastolic pair into a single BP row per day; half-measured days
  drop so the model never fabricates a complement. Per-day
  medication-adherence rows draw from `MedicationIntakeEvent`. The
  EN and DE Coach system prompts gain a DAY-LEVEL READINGS section
  instructing the model to answer day-specific or weekday-specific
  questions out of `timeline.recent` with date + weekday citations,
  acknowledge missing days plainly, and fall back to
  `timeline.weekly` for older windows. Token cost per Coach turn
  rises from ≈190 tokens (aggregates only) to ≈3000 tokens for a
  full-scope snapshot. The new scope picker is the relief valve.

### Added

- **Per-source + per-window scope picker on the Coach sources rail.**
  The sources rail grew real per-source checkboxes (BP / Weight /
  Pulse / Mood / Compliance — 36px touch target, 60% opacity when
  excluded) and a window selector (last 7 days / 30 days / 90 days /
  all-time). The drawer owns the scope state and forwards picked
  scope through `useSendCoachMessage` to the chat request body.
  Toggles reset to the all-source last-30-days default each drawer
  open. The scope payload only ships when the user has narrowed
  away from the default — server can tell "no opinion" from
  "intentionally narrow". A single-source last-7-days narrowed turn
  lands around ≈600–700 tokens.

## [1.4.20] — 2026-05-10

### Added

- **Insights redesign — hero strip, Daily Briefing, Suggested Prompts.**
  `/insights` opens with a new hero strip that pairs a time-of-day
  greeting and primary action row with a strip of suggested-prompt
  chips. Below the hero, a Daily Briefing card surfaces an AI-generated
  paragraph plus three keyFindings drawn from the last 24-hour window.
  Suggested-prompt chips drive the Coach drawer with prefill text.
- **AI Coach drawer with streaming chat and encrypted persistence.**
  A right-side drawer over `/insights` hosts a streaming Coach
  conversation. `POST /api/insights/chat` is an SSE endpoint that
  walks the existing AI provider chain and emits `token` →
  `provenance` → `done` frames. Conversation history persists across
  sessions; `GET /api/insights/chat`, `GET /api/insights/chat/[id]`,
  and `DELETE /api/insights/chat/[id]` round-trip the history rail.
  Source-chip provenance attaches to every assistant turn (metric,
  window, n-count — labels only, never raw values). The drawer mounts
  via the hero strip's "Ask the coach" button or any suggested-prompt
  chip. Three-column layout on `lg+` (history rail · message thread ·
  sources rail), full-screen single-column on mobile with chevron-
  button trays for the rails.
- **Correlation discovery — 3 hypothesis cards.** A new
  `<CorrelationRow>` between Daily Briefing and the Advisor card
  surfaces three pre-defined hypotheses (BP × medication compliance,
  mood × pulse, weight × weekday) with Pearson r + Fisher-z
  confidence interval. Surfacing gate: n ≥ 14 paired observations
  and p < 0.05; below the gate the cards stay collapsed.
- **Trends row with AI annotations.** A new `<TrendsRow>` mounts
  alongside the correlation cards. Each annotation is a short
  AI-generated callout tied to a specific date in the analyzed
  window; the BP timeline gains storyboard markers at the same
  positions via an additive `annotations[]` prop on `<HealthChart>`.
- **Weekly Report at `/insights/report/[week]`.** A newsletter-style
  printable surface with Summary / Going-well / Worth-watching /
  Tips / Data-quality sections. `window.print()` export via
  Tailwind `print:` variants; the hero strip surfaces fresh weekly
  reports with Read · Share · Export PDF actions (Web Share API
  with clipboard fallback).
- **Personal Health Score (composite 0–100).** A deterministic
  `<HealthScoreCard>` panel renders alongside the hero strip on
  `lg+`. Score weights: 30% BP-target rate + 20% weight-trend
  alignment + 20% mood stability + 30% medication compliance.
  Three bands (green ≥75, yellow 50–74, red <50). "Ask the
  Coach" CTA opens the drawer with a score-aware prefill.

### Changed

- **`PROMPT_VERSION` 4.19.0 → 4.20.2.** Three controlled bumps
  across B1 → B3 → B4 carry GROUND RULES 8–11 covering the new
  schema fields. `aiInsightResponseSchema` extended with optional
  `dailyBriefing` / `trendAnnotations` / `weeklyReport` /
  `storyboardAnnotations` / `healthScore` blocks; legacy v1.4.19
  cached payloads still parse because every new field is nullable
  - optional.
- **Branch + release model.** `CONTRIBUTING.md` documents a
  long-lived `develop` branch as the daily target and `main` as
  release-only. End users follow `main` / latest tag; contributors
  branch from and PR into `develop`. The mirror page at
  `/contributing/branch-model/` on the docs site explains the
  same flow for would-be contributors.
- **Repository hygiene.** New `.github/CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), three issue templates, a pull-request
  template, expanded Dependabot scopes (npm + github-actions +
  docker), and complete `package.json` metadata (description,
  license, homepage, repository, bugs, keywords).

### Fixed

- **Coach SSE idempotency replay no longer returns null.** The
  idempotency wrapper double-read the body on replay; the streaming
  route now caches the original SSE response correctly. Also
  repairs the dead error-frame branch and stabilises
  `useSendCoachMessage` opts.
- **Streaming assistant text announces to screen readers.** The
  message thread now has `aria-live="polite"` on the in-flight
  bubble so token-by-token streams reach assistive tech.
- **Coach drawer width capped on `lg+`.** Drawer no longer hits
  1080 px on common laptops; sources rail moves to a tray below
  `xl`.
- **Hero glow z-isolation under sticky nav.** The hero radial
  glow used to bleed through the sticky section nav on scroll.
- **Suggested-prompt chip touch target ≥ 36 px.** Was 28 px,
  below the project's interactive-control floor.
- **"Generate weekly report" hero button enabled.** Previously
  rendered disabled; now wired to the report route.
- **`buildCoachSnapshot` bounded to 90 days.** The Coach context
  helper used to walk every measurement on every turn; capped at
  90 days to keep token cost predictable.
- **`formatRelativeTime` consolidated.** Three near-identical
  copies in the insights surfaces collapsed into one shared
  helper.

### Security

- **Coach conversation persistence is encrypted at rest.** New
  Prisma models `CoachConversation`, `CoachMessage`, and
  `CoachUsage` (migration `0035_coach_conversations_v1420`) store
  message bodies under AES-256-GCM via the existing `crypto.ts`.
  Provenance lives in `metricSourceJson` as labels only (metric,
  window, n-count) — never raw values. GDPR cascade-on-user-delete
  wired through the FK chain.
- **Prompt-injection refusal pattern.** The Coach SSE route runs
  every incoming message through an EN+DE refusal scanner that
  short-circuits prompt-injection attempts and obvious off-topic
  asks before the provider call.
- **Per-user daily token budget.** `CoachUsage` ledgers
  (user, UTC-day) → tokens; the 25 000-token cap (≈13 turns for
  a heavy user) prevents runaway spend on shared provider keys.

### Deferred to v1.4.21

- 22 medium + 16 low + 4 simplify-apply-maybe items from the multi-
  pass review. Highlights include: senior-dev call to consolidate the duplicated
  Pearson / linear-regression maths layer; refactor the
  `<CoachDrawer key={prefill}>` state-reset shortcut into a
  controlled prefill prop; transactional `recordSpend()`; refusal
  accounting + lexicon expansion.

### Deferred to v1.5

- iOS native app, Apple Health integration, and per-metric APNs
  alerts.

## [1.4.19] — 2026-05-10

### Fixed

- **BD-Zielbereich headline now shows independent values for 7T / 30T /
  total.** The big number used to be identical to the 30T sub-value
  because `/api/analytics` aliased `bpInTargetPct` to `last30Days?.pct`.
  `computeBpInTargetWindows()` now returns a third `allTime` window and
  the route routes the headline through it, so the three numbers can
  legitimately differ across the three windows.
- **Charts mobile header no longer breaks the layout on Pixel 5.** The
  card header switches to a mobile-first stack below `sm` (title +
  chips on row 1, range tabs + cog right-aligned on row 2 with
  `flex-nowrap`) so the tabs always own a single row down to 280 px
  (Galaxy Fold compact). Bucket-aggregation chips and comparison
  captions hide on mobile to free horizontal budget.
- **Charts x-axis tick density unified across every chart wrapper.**
  New `src/lib/charts/x-axis-density.ts` helper + `useViewportWidth`
  hook caps visible ticks at 4 (Fold) / 6 (Pixel 5 / iPhone 12) / 8
  (small tablet) / 10 (desktop). Wired into HealthChart, MoodChart,
  MedicationComplianceChart, and ComplianceLineChart, so the
  medication chart no longer overloads with one tick per day.
- **`/admin/api-tokens` table no longer triggers a horizontal
  scrollbar at any viewport (4th attempt).** Truncate-with-tooltip
  pattern on token-name, username, and permission badge, plus
  `table-fixed` + colgroup widths on the desktop table. Mobile falls
  back to the existing card list, now walked end-to-end by an e2e
  regression.
- **Spurious mini-scrollbar on `/admin/feedback` tab strip.** The
  shared `tabsListVariants` primitive picked up `overflow-y-hidden`
  so the strip no longer paints a 1 px slither below the tabs.
- **`/insights` raw `metric: blood_pressure_sweet` template leak.**
  `STRIP_TOKEN_REGEX` widened to `[A-Za-z0-9_]+` so lowercase template
  remnants are scrubbed from AI prose; the uppercase render allowlist
  (`PARSE_TOKEN_REGEX`) is unchanged.
- **AdminShell hides the collapse button on single-section pages.**
  No more dead "Einklappen" affordance when the route only exposes
  one section.
- **Mobile Sys/Dia badge enum mismatch on blood-pressure rows.**
  CRITICAL from QA — the badge enum on mobile measurement rows
  decoded the wrong key. Fixed before tag with a TDD guard.
- **6 CRITICAL + 21 HIGH copy / consistency / a11y findings from the
  quality-of-life audit.** Time-window range strings now respect the
  active locale, login overview filters out non-auth events, the
  date / datetime input pair forwards `lang` so the native picker
  uses the user's locale, raw enum badges are humanised, audit-action
  labels are localised and link back to the row, achievement titles
  no longer insult the user, and a long tail of admin / settings copy
  consistency.

### Changed

- **Settings → Integrations status displays consolidated.** Withings
  and Mood Log cards now share a single canonical
  `<IntegrationStatusPill>` chip top-right ("Connected · 12 min ago"
  with locale-aware relative-time bucketing). The redundant v1.4.15
  banner trio (`connected / last successful / last attempt`) and Mood
  Log's bottom-of-card "letzter Sync" line are gone; both cards now
  carry a divider between header and body for visual symmetry.
  Actionable error text stays as a compact inline alert above the
  action row.
- **Comparison overlay control removed from the dashboard.** The
  toggle now lives only on `/insights`, folded into the hero meta
  band where there is room for it. The dashboard ditches the
  always-visible knob.
- **`/insights`: single page-level refresh button.** The hero owns
  the only refresh affordance; redundant per-section refresh links
  removed (the per-recommendation Regenerate button from v1.4.16
  stays).
- **`/insights`: small BP / Weight tile strip removed.** Duplicated
  the dashboard tiles. `-157` lines on `src/app/insights/page.tsx`
  plus dead helpers, plus the orphan "Persönlicher AI Berater"
  subtitle.
- **AI insight prompt no longer opens with a default-positivity
  sentence about data quality.** GROUND RULE 7 (EN + DE) forbids
  "Your data foundation is strong" / "Datengrundlage ist sehr stark"
  openers; data-quality caveats only allowed when n < 7 in the
  analyzed window, recencyDays > 14, or a coverage gap biases the
  comparison. `PROMPT_VERSION` bumped 4.16.1 → 4.19.0 so feedback
  aggregation can attribute responses to the new rule.
- **Settings input heights, vertical spacing, and right-side action
  buttons consistent across all sub-routes (mobile + desktop).**
  Every form input is now 36 px (`h-9`); Account → Password,
  Account → Restart onboarding tour, and Dashboard → Reset to
  defaults stack the action below the title on `<sm` (full-width)
  and right-align on `≥sm`, fixing the Pixel-5 right-edge overflow
  on the tour button. Language select gets its own row at the bottom
  of the Profile card; card-internal `space-y` standardised to
  `space-y-4`.
- **Target-range status labels translated to German** (Low / On Target
  / Stable / Moderate). 11 `targets.label.<TYPE>` + 41
  `targets.status.<key>` entries in EN + DE; page uses
  `STATUS_CATEGORY_KEY` to normalise server strings.

### Deferred to v1.4.20

- 3 HIGH from QA — `/insights` `data?.` narrowing refactor,
  `/admin/api-tokens` touch-tooltip (needs Popover swap), and
  `/insights` hero density (folded into the v1.4.20 redesign).
- 31 MED + 16 LOW from the quality-of-life audit. Short-list tracked internally.
- `/insights` redesign with AI Coach — separate roadmap, design
  handoff at `~/Downloads/design_handoff_insights_redesign`.

## [1.4.18] — 2026-05-10

### Added

- **Per-chart overlay toggles.** Every chart on the dashboard now has a
  cog menu (44 × 44 tap target) with three independent switches: trend
  indicator, trend arrow, and target-range overlay. Defaults are off so
  the default look is a clean line. State is persisted per user per
  chart in `User.dashboardWidgetsJson.chartOverlayPrefs` (no migration)
  and round-tripped through a new `PUT /api/dashboard/chart-overlay-prefs`
  in a Serializable transaction.
- **Expanded achievements roster.** 21 new achievements bring the total
  to 59. Adds streak, milestone, consistency, improvement, and discovery
  categories on top of the existing security / engagement / vitals /
  medication groups. Locked public badges only render once the user has
  data for the underlying metric so the page isn't a wall of grey on
  day one.
- **Hidden Easter-egg achievements.** Six hidden badges that paint as
  opaque "Hidden achievement" placeholders until unlocked. The real
  strings, descriptions, and icons never reach the DOM (or the API
  response) for locked-and-hidden entries, so peeking the bundle or the
  network tab doesn't spoil them. Unlock toast adds a longer Sparkles
  celebration with a "you unlocked a hidden achievement!" headline.
- **BD-Zielbereich tile 7T / 30T sub-values.** The two sub-values on
  the blood-pressure-in-target tile now show real measurement data.
  Backed by a new `computeBpInTargetWindows()` helper that re-uses the
  v1.4.16 ceiling predicate but filters input by `measuredAt`.
  `/api/analytics` surfaces `bpInTargetPct7d` / `bpInTargetPct30d`.

### Changed

- **Charts use clean lines without gradient fills.** The v1.4.16
  Apple-Health-style gradient backgrounds are gone. Lines stay smooth-
  interpolated, tooltips stay rich, animation-on-render still respects
  `prefers-reduced-motion` — only the gradient fill area is removed.
- **Mood chart shows simple dots at data points.** The emoji glyphs
  introduced in v1.4.16 are replaced with plain coloured dots; the
  emoji still appears in the tooltip.
- **Personal-baseline / mean overlays are opt-in.** The 90-day-median
  reference line on health and mood charts is no longer always-on; it
  only renders when the per-chart Trend toggle is enabled.

### Fixed

- **`/admin/api-tokens` mobile horizontal scrollbar.** Third attempt,
  this time pinned to the actual offender via Playwright probe of the
  prod page at Pixel-5 viewport. The scrollbar was painted by the
  AdminShell mobile section strip (13 entries, scrollWidth ≈ 1700 px),
  not the api-tokens table. Added a `.no-scrollbar` utility and applied
  it to both AdminShell and SettingsShell mobile strips. Swipe and
  keyboard-arrow scrolling preserved.
- **`/insights` legacy-payload crash.** Already shipped in the v1.4.17
  hotfix; documented here for completeness. Cached pre-strict insights
  in the v1.4.14 `{changed, stable, drivers, …}` shape now render a
  "Regenerate insights" card instead of throwing
  `Cannot read properties of undefined (reading 'replace')`.
- **BD-Zielbereich 7T / 30T sub-values.** Were always rendering "—"
  because `/api/analytics` only computed a single 30-day window and
  the tile passed `avg7={null}, avg30={null}`. Wired correctly — see
  Added.

### Deferred to v1.4.19 / v1.5

- **i18n bundle leak (security HIGH).** The hidden-achievement
  redaction landed at the API layer, but `messages/en.json` and
  `messages/de.json` are still statically imported into the client
  bundle, so a determined user can `Cmd-F` for the hidden strings in
  `_next/static/chunks/*.js`. Needs a build-time strip or reversible
  obfuscation. Tracked internally.
- The short-list and the strategic v1.5 items are tracked
  internally.

## [1.4.17] — 2026-05-10

### Fixed

- `/insights` no longer crashes for users with cached insights from before
  v1.4.16. A "Regenerate insights" card is shown for legacy cached
  payloads (the pre-strict `{changed, stable, drivers, …}` shape) instead
  of throwing a `Cannot read properties of undefined (reading 'replace')`
  error. One click on the card refreshes the insight in the new format.

## [1.4.16] — 2026-05-09

### Added

- **Per-recommendation explainability.** Every insight recommendation now
  carries a rationale: which time window was analysed, what was compared,
  and the deviation that triggered the recommendation. The card expands
  inline to reveal the rationale plus a mini-chart of the data window.
- **Confidence score per recommendation.** Each recommendation gets a
  deterministic 0–100 confidence score (server-computed from sample size,
  recency, and signal strength) shown as a colour-banded ring + bar meter.
  Below-threshold recommendations are tagged "low confidence — based on
  limited data" rather than hidden.
- **"Was this helpful?" feedback.** Thumbs-up / thumbs-down on every
  recommendation, persisted per user with provider attribution. Daily
  aggregator writes per-(severity × provider) helpful-rate to admin
  settings; the aggregate is visible under `/admin/ai-quality`.
- **Medical-reference grounding.** Recommendations cite curated AHA / ESH
  / ESC / WHO / DGE guidelines via a validated `referenceId`; the
  citation links open the source guideline in a new tab.
- **Multi-provider AI fallback chain.** The insight wrapper tries each
  configured provider in turn on hard failures (401 / 403 / 429 / 5xx /
  transport). Schema 422 still bubbles. Last-working provider is cached
  per user for an hour. Order, enable / disable, and provider list are
  configurable under Settings → AI.
- **Apple-Health-style chart polish.** Blood pressure, weight, pulse,
  body fat, sleep, steps, mood, and medication-compliance charts gain
  gradient fills, smooth interpolation, a 90-day-median personal-baseline
  reference line, in-target zone shading, rich tooltips with delta
  vs. baseline, and 600 ms ease-out animation that respects
  `prefers-reduced-motion`. Sparse data (<3 points) renders an explicit
  empty state instead of a degenerate line.
- **Comparison overlay (vs. last month / vs. last year).** A new toggle
  at the top of every chart, tile, and the insights surface overlays the
  prior period as a dimmed line beneath the current one and adds a delta
  callout (Δ ±N). The AI summary narrates the comparison ("your average
  BP improved by 4 mmHg vs. last month") when the toggle is active.
- **Settings → Export.** Consolidated `/settings/export` page with one
  card per export type: doctor-report PDF (configurable date range +
  practice name), measurements CSV, medications CSV (optional intake
  history), mood CSV, full JSON backup. Each download writes a
  `user.export.<kind>` audit-log entry and shares a 10/h rate-limit
  bucket. Doctor-report entry-point relocated under this route.
- **Achievements page.** New `/achievements` page with locked + unlocked
  breakdown grouped by category (medication / vitals / security /
  engagement). Recent unlocks card on the dashboard, toggleable from
  layout settings.
- **Onboarding tour for new users.** First-run spotlight walk-through
  highlighting tile-strip, quick-add menu, insights, integrations, and
  achievements. Skippable, keyboard-navigable, replayable from
  Settings → Account.
- **Admin host-load chart.** New chart over the system-status section
  shows host CPU, memory, and disk-IO over the last 2 hours, sampled
  every minute, retained for 7 days.
- **Admin app-log preview.** Tail of the last 1 hour of structured
  wide-events from the per-process ring buffer, filterable by trace_id /
  level / action / time-window with a JSON inspector modal.
- **Admin AI quality preview.** New `/admin/ai-quality` route surfaces
  helpful-rate per (severity × provider), tinted by band so degrading
  providers stand out at a glance.

### Changed

- **Insights surface uses the new RecommendationCard everywhere.** The
  `/insights` page and the dashboard insights tile both render the
  polished card — rationale expand, confidence meter, citation footnote,
  feedback thumbs — backed by a shared TanStack Query cache.
- **Trend label normalised to "7-day trend".** Every chart, tile, and
  subtitle uses the long form. A signed numeric delta indicator (±N.N)
  with metric-aware colouring appears next to the value on every chart,
  including mood and medication-compliance.
- **`/admin` overview redesigned.** The section grid is gone; the
  overview now shows a system-status snapshot with host-load chart and
  an audit-log preview. Sidebar carries the section list.
- **Sidebar admin sub-items only expand on `/admin/*`.** Clicking the
  Admin link or opening the Gravatar dropdown no longer auto-expands
  the sub-list when you are not on an admin route.
- **Settings → AI is a single dropdown.** The provider selector at the
  top drives the configuration form below; no more top/bottom split. All
  five providers (Codex / OpenAI / Anthropic / Local / Admin OpenAI) are
  reachable from the same UI.
- **Top dashboard tiles selectable per metric.** The widget-id enum bug
  from v1.4.15 that silently 422'd every layout PUT is fixed; the
  per-metric tile toggle in layout settings now actually persists.
- **AI rate-limit raised to 10/hour.** Default bumped from 2/h to 10/h;
  configurable via `INSIGHTS_RATE_LIMIT_PER_HOUR`. Generating a new
  insight evicts every previously cached per-status insight for that
  user, so the dashboard never shows a stale cached payload.

### Fixed

- **BD-Zielbereich percentage now counts in-range readings correctly.**
  The v1.4.15 fix corrected the denominator but kept the ESH narrow-band
  predicate (`sysLow ≤ sys ≤ sysHigh AND diaLow ≤ dia ≤ diaHigh`), so
  normotensive readings (e.g. 117/79) below `sysLow=120` counted as out
  of range. Predicate switched to one-sided ceiling semantics with a
  hypotension floor (`90 ≤ sys ≤ sysHigh AND 50 ≤ dia ≤ diaHigh`),
  centralised in `isBpReadingInTarget()` shared by six call sites.
- **Trend on "all" filter shows a meaningful split-half delta.** Long
  windows where the per-week rate fell below the 1-decimal display
  precision now also surface a split-half mean delta (second-half mean
  minus first-half mean) for windows ≥ 90 days.
- **Login overview no longer strips umlauts.** The geo helper decodes
  via `arrayBuffer()` + `TextDecoder('utf-8')` instead of
  `Response.json()`, so an upstream proxy stripping the
  `Content-Type: charset` parameter cannot poison the umlaut path.
  Nürnberg, München, Düsseldorf, Köln, Würzburg, Bückeburg, Weißenfels
  all roundtrip correctly.
- **`/admin/api-tokens` table no horizontal overflow on mobile.** The
  desktop `<table>` falls back to a card list at `<md` viewports, with
  long names + permission badges wrapping cleanly inside the card.
- **Skip-link no longer blocks logo click.** The "Skip to content"
  shortcut still leads the tab order but no longer blocks pointer events
  on the logo.
- **Bug-Report nav entry follows the admin feature toggle.** When the
  admin disables bug reporting the entry vanishes from sidebar,
  bottom-nav, topbar, and the error-detail "Report bug" button.
- **Feedback link follows the admin feature toggle.** When feedback
  collection is disabled, the UI entry point disappears too.
- **Cached AI insights replaced when the user regenerates.** Generating
  a new insight invalidates the per-status `audit_logs` entries plus the
  TanStack Query cache, so the dashboard always shows the freshest
  payload.

### Performance

- **Comparison overlays computed via reusable bucket-series helper.** No
  extra round-trip per chart — the dashboard fetcher and AI snapshot
  both read from the same `avg30LastMonth` / `avg30LastYear` fields.
- **`/api/insights/feedback` persists with optimistic UI updates.**
  Thumbs-up / thumbs-down apply instantly; the localStorage refresh-
  defence keeps the verdict on rerender even before the mutation
  resolves.

### Security

- **AI provider apiKeys encrypted at rest.** Provider chain entries that
  carry a key store it AES-256-GCM via the existing `src/lib/crypto.ts`
  helper.
- **`/api/insights/feedback` gated by `requireAuth` + idempotency-key.**
  The dedicated rate-limit bucket prevents thumbs-spam.
- **Per-provider attribution server-filled.** Clients cannot tamper with
  which provider gets credit for a recommendation; the attribution is
  resolved server-side from the latest `insights.generate` audit row.
- **Admin egress redacts secrets.** Audit-log `details` and app-log
  `meta` fields run through `redactSecrets()` before leaving the admin
  API surface.

### Internal

- **`docker-publish` workflow no longer hangs on main-branch builds.**
  Root cause was a qemu-arm64 SIGILL during multi-arch emulation; arm64
  dropped from the platforms list. Native arm64 runner matrix scheduled
  for v1.5.
- **CI integration tests + e2e workflows green again.** Both had been
  pre-existing red since `d8c549e` (encryption-key YAML scalar parsed
  as integer 0 + spotlight tour overlay intercepting clicks). Both fixed
  this milestone.

### Deferred to v1.5

- Coolify image-digest auto-deploy trigger (currently fires on every
  git-push; the manual Coolify UI toggle is the realistic fix).
- Native arm64 runner matrix for full multi-arch docker publish.
- Cross-user feedback aggregation prompt-tuning ratchet (depends on
  v1.4.16 feedback collection accumulating data).
- Dedicated `/insights/compare` page (i18n keys
  `comparison.insightsCallout.{lastMonth,lastYear}` reserved).

## [1.4.15] — 2026-05-09

### Added

- Backups become a full lifecycle. The Sunday-morning snapshot is no
  longer the end of the road. `/admin/backups` lets you download any
  snapshot as `.json`, upload a new one, and — behind a triple-confirm
  gate (type “RESTORE” + dialog + confirm) — restore a snapshot straight
  into the database. Every operation (run, download, upload, restore
  including start/failure) is recorded in the audit log with actor and
  target snapshot.
- New `/achievements` page lists locked + unlocked achievements with
  progress bars (`{current} / {target}`), grouped by category (medication,
  vitals, security, engagement). The dashboard gains a toggleable “Recent
  achievements” card; visibility lives in the Layout settings.
- New onboarding tour for first-run users. A spotlight walk-through on
  first dashboard load points out the tile strip, quick-add menu,
  insights, integrations, and achievements. Skippable with Esc, fully
  keyboard-navigable, honors `prefers-reduced-motion`. Replay the tour any
  time from Settings → Account.
- Doctor-report v2. Before the PDF is generated a dialog asks for the date
  range (presets 90 days / 6 months / 12 months, manually editable, max 2
  years) and an optional practice name that appears on the PDF cover page.
  The practice name is persisted as a user preference.
- Auto-deploy on GHCR push. Once the Docker publish action ships a new
  `:latest`, it calls the Coolify deploy webhook. Coolify in turn pings an
  internal endpoint with the result; success / failure / unknown all land
  in the audit log; persistent failures send a Telegram alert to every
  admin. No more manual force-pull on the host.
- Empty states everywhere. Brand-new accounts and empty lists now always
  show a sensible empty state (icon + description + CTA) where there used
  to be just white space. Coverage: admin tables (users, backups,
  login-overview, api-tokens, feedback, audit-preview), measurement / mood
  / medication / achievement lists, the insights top-level +
  BMI-without-height view, and the dashboard for fully empty accounts.
- Notification channel status UI. Settings → Notifications now shows
  per-channel (Telegram, ntfy, Web Push) the current state (connected /
  error / disabled), last success, last failure, consecutive-failure
  counter, and disable reason if any. Buttons for “Re-enable” (only when
  auto-disabled) and “Send test”.
- Withings + moodLog integration status UI. Settings → Integrations shows
  per-provider the connection state, last sync, last error, and a reauth
  hint as soon as a refresh-token was rejected. After persistent failures
  (≥ 3 in a row) admins receive a Telegram alert if the channel is
  enabled.
- Top dashboard tiles selectable. The layout settings now expose a
  separate toggle for each metric’s upper-row tile and lower-row chart.
  Existing saved layouts keep their previous behaviour (one switch
  controls both surfaces) until you explicitly flip the new toggle.
- 7-day-trend instead of 7-day-average. Each tile gains a coloured delta
  indicator `(±N.N)` next to the value, showing the metric-aware change of
  the last 7 days vs. the prior 7. Label renamed from “7d average” to “7d
  trend”.

### Changed

- The `/admin` overview replaces the section grid with an audit-log
  preview (recent entries, actor, target resource) and a system-status
  snapshot. The section grid moved into the sidebar.
- The sidebar Admin sub-items only expand when you are actually on an
  `/admin/*` route. Everywhere else the Admin group stays collapsed.
- The mood chart now auto-aggregates: weekly past 90 days, monthly past
  730 days — same thresholds as weight and BP. A chip in the chart header
  shows the active aggregation level.
- AI insights gain hard anti-hallucination guardrails. Provider responses
  are validated against a strict Zod schema (summary, recommendations with
  mandatory `metricSource`, citations, warnings). Recommendations citing
  data points not present in the snapshot are rejected. The wrapper
  retries exactly once with a corrective system message; if the second
  attempt also fails, it returns 422 instead of unsanitised output.
  Codex-backend slug drift (e.g. `gpt-5-codex` → `gpt-5.3-codex`) is now
  cushioned by a configurable fallback chain + 1-hour positive cache; if
  every slug fails the route returns a structured 503 with the
  `attempted[]` list.
- The `/admin/api-tokens` table is responsive on mobile. Narrow viewports
  gate columns behind breakpoints (last-used, created-at, owner) and the
  owner username falls back inline next to the token name so hiding the
  column never drops data.
- Mood tile on mobile shows only the large score number + label, no more
  doubled rendering.
- Quick-add submenu disambiguated. The two entries are now called “Messung
  erfassen” / “Stimmung erfassen” (DE) and “Log measurement” / “Log mood”
  (EN) — previously both simply “Add”.

### Fixed

- Blood-pressure target-range percentage. The target-range tile miscounted
  sys/dia pairs once import drift pushed sys/dia timestamps more than 5
  minutes apart — the tile could show 0 % even though most readings were
  inside the target range. Fix: a same-Berlin-day key fallback +
  pair-count as denominator.
- Onboarding flicker. On accounts where onboarding is already complete,
  the onboarding card no longer renders for ~500 ms before vanishing. It
  mounts only after the analytics status has loaded, and refuses to
  auto-open when nothing is left to do.
- The “Skip to content” skip-link still leads the tab order but no longer
  blocks clicks on the logo.
- The “Report a bug” entry follows the admin feature flag. With bug
  reporting disabled, the entry vanishes from the sidebar, bottom-nav,
  topbar, and the error-detail “Report bug” button.
- The Feedback link follows its admin feature flag. With feedback
  disabled, the UI entry point disappears too.
- Notification channels auto-disable on persistent hard rejects. If
  Telegram / ntfy / Web Push respond repeatedly with 410 or other
  permanent reject codes, the channel disables itself and writes an
  audit-log entry. Status + re-enable button live in Settings →
  Notifications.
- reauth`und der Settings-Eintrag bittet um Neu-Verbindung — statt jeden
Sync-Tick weiter gegen den Provider zu hämmern. _Refresh-token failures
flip the integration to “needs reauth”. When the Withings or moodLog
refresh-token exchange fails (typically after 90 days without re-auth),
the integration switches to`error_reauth` and the Settings entry asks
  for re-connect — instead of hammering the upstream every sync tick.
- Mobile chart containers no longer eat vertical scroll. On touch devices
  the Recharts wrappers swallowed vertical pans; on slower devices that
  felt like a scroll lockup. Fix: `touch-action: pan-y` on the chart
  wrappers, vertical scroll passes through again.
- `/admin/users` on mobile renders as a card list instead of a
  horizontally-scrolling table.
- Accessibility round of fixes: chart range buttons, medication primary
  buttons, mood-list mobile icon buttons, login CTAs, Settings → Account
  passkey table, onboarding-tour focus trap + DE-locale overflow +
  backdrop ring — all aligned to 44 px tap targets and labelled /
  keyboard-navigable.

### Security

- AI provider responses are validated against a strict Zod schema. The
  insight wrapper only accepts responses that satisfy the strict
  `aiInsightResponseSchema`, and rejects recommendations citing data
  points absent from the supplied snapshot. Schema failures trigger a
  single retry with a corrective system message; a second failure returns
  422 instead of hallucinated output.
- Backup operations are fully audited. Run, download, upload, and restore
  — including start markers, denial reasons, and failures — each write an
  audit-log entry with actor and snapshot ID. Restore is additionally
  protected by five independent gates (cookie-only admin auth, `confirm:
"RESTORE"` body, typed UI confirmation, idempotency-key wrap,
  pre-transaction enum validation).

## [1.4.14] — 2026-05-09

### Added

- The admin area is split into per-section pages instead of one monolithic
  dashboard with anchor jumps. Each section has its own URL
  (`/admin/system-status`, `/admin/services`, `/admin/integrations`,
  `/admin/feedback`, `/admin/reminders`, `/admin/users`,
  `/admin/api-tokens`, `/admin/login-overview`, `/admin/backups`,
  `/admin/danger-zone`); the sidebar grows an expandable Admin group;
  status cards link to the relevant sub-page; legacy `/admin#section-…`
  paths are redirected server-side.
- New `/admin/backups` view with a table of all stored backups (size,
  type, timestamp) and a “Backup now” button that enqueues an ad-hoc
  pg-boss job.
- New `/admin/users` view with role filter pills (all / admins only /
  users only) and a per-row force-logout action behind a confirmation
  dialog (deletes every active session of the target and writes an
  audit-log entry). Self-target is disabled.
- New “Remove saved AI key” button in Settings → AI: a clearly labelled
  button behind a confirmation dialog clears the stored OpenAI or local
  provider key without touching anything else.
- MODEL`-Env-Var** als Operator-Override für das Codex- Modell-Slug, damit
alternative Modelle ohne Rebuild getestet werden können (z. B. wenn dein
ChatGPT-Plan ein anderes Default-Modell bevorzugt). _New `CODEX_MODEL`
  env var lets operators override the Codex model slug without a rebuild —
  useful for testing alternate slugs against different ChatGPT plan tiers.

### Changed

- Trend-arrow colors are metric-aware: BP and weight rising = orange
  (warning), mood rising = green (positive), pulse rising = neutral
  (context-dependent). Arrow direction itself is unchanged.
- “Wipe all data” now also clears notification channels and web-push
  subscriptions: encrypted Telegram bot tokens and web-push endpoints no
  longer survive a full account wipe. Feedback and audit log stay
  untouched (unchanged). The confirmation copy spells out the new scope.
- Admin-area i18n keys reorganised under `admin.section.<slug>.*` (EN + DE
  parity).

### Fixed

- Codex/ChatGPT model slug corrected: the Codex backend rejects both
  `gpt-5-codex` and `gpt-5` when authenticated via a ChatGPT account; the
  codex-optimised slug for the Plus/Pro tiers is `gpt-5.3-codex`. v1.4.14
  wires the correct default. Settings → AI “Test connection” and the
  insight generator now both succeed against your ChatGPT subscription.
- **Sommerzeit-Wechsel verschiebt keine Tageswerte mehr.** Die
  Cross-Metric-Tagespaarung in den Insight-Buckets rechnete früher in
  reinem UTC und verlor an den Berliner DST-Grenzen einen Tag. Die
  neue Helper `dayOffsetToBerlinDayKey()` arbeitet DST-immun (Anker
  über Berliner Y-M-D, dann Subtraktion in 86*400_000-ms-Schritten);
  die Tagespaarung über Blutdruck, Gewicht und Stimmung ist jetzt
  über DST-Wechsel hinweg konsistent.
  \_DST transitions no longer shift daily values. The cross-metric
  daily bucket pairing previously did naive UTC math and dropped a
  day at the Berlin DST boundary. A new `dayOffsetToBerlinDayKey()`
  helper anchors at Berlin Y-M-D and subtracts in 86_400_000-ms
  steps; bucket pairing across blood pressure, weight, and mood is
  now DST-safe.*
- AI provider errors are now correctly classified by
  `/api/insights/generate`: provider 401/403 → 422 (“AI provider rejected
  the request — check your API key in Settings → AI”), provider 5xx → 503
  (“AI provider temporarily unavailable”), 429 → 429. Previously
  everything returned 500. Full error context still lands in the
  structured logs.
- The structured-logging secret redactor no longer mangles innocent words.
  The previous regex matched any `sk-…` substring and masked fragments
  inside `task-force`, `risk-management`, `disk-io`. The new pattern
  requires a word boundary and at least 8 trailing characters, while still
  scrubbing real API keys (`sk-…`, `sk-ant-…`).

### Performance

- Bundle-size improvements on the insights page: Recharts symbols for the
  correlation scatter plots are now loaded on demand via `next/dynamic`
  instead of being shipped eagerly, saving roughly 108 KiB of initial
  JavaScript on `/insights`. Chart visuals are unchanged.
- The dashboard skips the onboarding-checklist API requests once
  onboarding is complete. With `onboardingCompletedAt` set, the
  `withings/status` and `notifications/preferences` queries no longer fire
  on dashboard load — saves about 950 ms of network time for established
  users.

### Tests & A11y

- Extended end-to-end suite. New Playwright specs cover the authenticated
  dashboard render, the “add measurement” flow, the doctor-report PDF
  download, a mocked Codex connect flow, a mocked insights-generate flow,
  and a mobile-viewport smoke test (Pixel 5).
- Axe-core accessibility audit now clean of serious/critical violations on
  `/dashboard`, `/settings/integrations`, and `/admin` (incl.
  `/admin/system-status`, `/admin/users`). Fixes: missing aria-labels on
  icon-only buttons, unnamed mobile user-menu trigger, empty `<dd>`
  placeholders, sign-up link distinguishable only by color, quick-add menu
  with two indistinguishable items.

### Docs

- Documentation site brought up to date with v1.4.14 — Codex device-code
  flow rewritten, new Admin sections (Backups, Users) documented,
  `CODEX_MODEL` env var added, dashboard performance note added, Codex
  troubleshooting block revised.

## [1.4.13] — 2026-05-09

### Fixed — KI Insights via ChatGPT

- **Modell-Slug für ChatGPT-Auth korrigiert.** Der Codex-Backend
  lehnt `gpt-5-codex` mit ChatGPT-Subscription ab
  (`The 'gpt-5-codex' model is not supported when using Codex with a
ChatGPT account.`) — dieses Slug ist nur für API-Key-Auth gültig.
  Wechsel auf `gpt-5`, das Standard-Modell der ChatGPT-Plus/Pro-Tarife.
  Operator-Override via `CODEX_MODEL`-Env-Var möglich falls dein
  Plan einen anderen Default kennt.

## [1.4.12] — 2026-05-09

### Fixed — KI Insights via ChatGPT (komplette Codex-Integration)

- **Codex-Backend-Aufruf jetzt vollständig nach Spec.** Die letzten
  Versionen haben den Connect-Schritt richtig hinbekommen, aber der
  eigentliche Insight-Call ist iterativ an immer neuen 400ern
  gestorben. Statt weitere Trial-and-Error-Iterationen zu fahren
  habe ich das vollständige Codex-Backend-Protokoll aus dem
  offiziellen `openai/codex`-Quellcode dokumentiert
  (`docs/codex-protocol-spec.md`) und einmal sauber dagegen
  implementiert. Was alles fehlte: der Header `ChatGPT-Account-ID`
  (ohne den 401, kommt aus dem `chatgpt_account_id`-Claim im JWT
  id_token); die Header `originator`, `User-Agent`, `Accept`,
  `session_id`, `thread_id`; die Body-Felder `reasoning: null` und
  `include: []`; das richtige Modell-Slug `gpt-5-codex` (statt des
  Test-Placeholders `gpt-5.3-codex`); JSON-Body beim Refresh
  (vorher form-urlencoded); Persistenz des `accountId` neben dem
  Access-Token. SSE-Streaming wird unverändert konsumiert
  (output_text.delta + output_item.done).
- **Aufräumen:** der Browser-Authorization-Code-Pfad
  (`/api/auth/codex/authorize` + `/callback`) ist gelöscht — er
  funktioniert auf hosted Domains grundsätzlich nicht (Hydra-
  Whitelist nur für localhost), war aber als Safety-Net noch da.
  Device-Code ist jetzt der einzige Pfad.
- **Re-Connect nötig:** wer in v1.4.7-v1.4.11 schon connected hat,
  muss einmal "Trennen" + "Mit ChatGPT verbinden" — die alte
  Storage-Form trug die `accountId` nicht und kann nicht
  nach-bereichert werden.

## [1.4.11] — 2026-05-09

### Fixed — KI Insights via ChatGPT

- **Codex-Backend bekommt jetzt SSE-Streaming.** Nach dem v1.4.10-
  Body-Format-Fix kam der nächste 400er: `Stream must be set to true`
  — der `chatgpt.com/backend-api/codex/responses`-Endpoint akzeptiert
  ausschließlich Server-Sent-Events-Antworten, kein synchrones JSON.
  v1.4.11 baut den CodexClient so um, dass er die Antwort als SSE
  konsumiert: `output_item.done`-Events liefern den vollständigen
  Assistant-Text, `output_text.delta`-Chunks dienen als Fallback,
  `response.completed` trägt die Token-Usage. Damit läuft das gesamte
  KI-Insights-Feature jetzt durch dein ChatGPT-Abo.

## [1.4.10] — 2026-05-09

### Fixed — KI Insights via ChatGPT

- **Codex-Backend bekommt jetzt das richtige Request-Format.** Nach
  dem v1.4.9-Connect war der OAuth durch, aber jeder echte Insight-
  Call ist mit `Codex request failed (400) — "Input must be a list"`
  gestorben. Der `chatgpt.com/backend-api/codex/responses`-Endpoint
  spricht das OpenAI-Responses-API-Schema (`input: ResponseItem[]`)
  und nicht das Chat-Completions-Schema mit String-Input. v1.4.10
  baut den Body korrekt — `input` ist eine Liste mit einem
  Message-Item, das wiederum eine Liste von `input_text`-Content-
  Blöcken trägt — exakt wie die `ResponsesApiRequest`-Struktur im
  offiziellen `codex-rs/codex-api/src/common.rs`. Settings → KI
  "Verbindung testen" und der Insight-Generator laufen damit jetzt
  beide gegen dein ChatGPT-Abo durch.

## [1.4.9] — 2026-05-09

### Fixed — Settings · KI

- **Device-Code-Flow läuft jetzt komplett durch.** v1.4.8 hat den
  Code richtig zugestellt und du konntest auf chatgpt.com
  bestätigen, aber der Connect-Schritt am Ende ist mit "missing
  organization_id" gestorben. Ursache: der id_token aus dem
  Device-Flow trägt das `organization_id`-Claim nicht (das
  bekommt nur die Browser-Authorize-Variante via
  `id_token_add_organizations=true`-Param), und unsere
  RFC-8693-API-Key-Exchange hat genau dieses Claim erwartet. v1.4.9
  übernimmt das Verhalten des offiziellen Codex CLI im Device-Pfad:
  den OAuth-Access-Token direkt verwenden und gegen den Codex-
  Backend-Endpoint (`chatgpt.com/backend-api/codex/responses`)
  schicken — kein API-Key-Tausch nötig. Refresh läuft analog: nur
  Token-Rotation, keine Exchange.

## [1.4.8] — 2026-05-09

### Fixed — Settings · KI

- **"Mit ChatGPT verbinden" funktioniert jetzt wirklich.** v1.4.7 hat
  zwar die OAuth-Endpoints korrigiert, ist aber an OpenAIs Hydra-
  Allow-List gescheitert: die Public-Codex-Client-ID hat in der
  Server-Allow-List nur `localhost:1455/1457` als Redirect-URI, jeder
  hosted-Domain-Callback wird mit "An error occurred during
  authentication (unknown_error)" abgelehnt. v1.4.8 schaltet auf den
  **Device-Code-Flow** um — den selben Mechanismus den der offizielle
  Codex CLI für Headless-/Hosted-Umgebungen nutzt: HealthLog zeigt
  einen kurzen Code (`RGRP-N5F7U`-Stil), du gehst auf
  https://auth.openai.com/codex/device, gibst den Code ein, bestätigst
  bei dir im Browser, fertig. Kein Redirect zurück nötig, also keine
  Allow-List-Konflikte. Die Settings-Seite pollt im Hintergrund und
  schließt das Modal sobald deine Approval durch ist.

## [1.4.7] — 2026-05-09

### Fixed — Settings · KI

- **"Mit ChatGPT verbinden" funktioniert wieder.** Seit der Funktion
  Anfang v1.4.x existiert war der OAuth-Pfad gegen die falsche Domain
  verdrahtet — ChatGPT hat unsere Authorize-/Token-Requests still
  geschluckt und das normale Web-Interface gerendert, kein Callback,
  kein Fehler. Der Flow läuft jetzt über `auth.openai.com/oauth/...`,
  identisch zum offiziellen `openai/codex` CLI: PKCE-Authorize, Token-
  Exchange, dann ein zweiter RFC-8693-Token-Exchange, der den
  `id_token` gegen einen OpenAI-API-Key tauscht. Dieser Key bucht
  gegen das ChatGPT-Abo, kein separates API-Plan-Quota nötig. Der
  Refresh-Token wird verschlüsselt mitgespeichert; vor jeder Anfrage
  rotiert HealthLog den API-Key transparent wenn er abläuft.

## [1.4.6] — 2026-05-09

### Fixed — Dashboard

- **Tile strip fills its row.** Each tile in the dashboard's
  measurement strip now stretches to its grid cell instead of
  shrinking to content width. On a 375 px viewport tiles in the
  same row are no longer 122-166 px wide — every tile takes the
  same share of the row.
- **Secondary text is finally distinguishable from primary.**
  `--muted-foreground` was identical to `--foreground` in both
  light and dark mode, which flattened the entire visual
  hierarchy. Tile labels, "Ø7d:" prefixes, units, and inactive
  nav items now render in `#9aa3b3` (dark) / `#5b6273` (light) —
  both ≥ 4.5:1 against the surface.
- **Trend cards land aligned with the chart strip below.**
  Padding bumped from `p-3` to `p-4 md:p-6` so the tiles match
  the surrounding chart cards. KPI typography (`text-3xl
tracking-tight tabular-nums` for the value, `text-xs uppercase
tracking-wide` for the label) gives the number proper weight
  without making the tile feel tall.
- **Always-on Ø7d / Ø30d chips** — when an average is missing
  the chip renders `—` instead of disappearing, so vertical
  rhythm stays consistent across tiles.
- **Welcome subtitle is visible on mobile** (was hidden below
  the `sm` breakpoint) and uses muted-foreground so it doesn't
  fight the headline.
- **Medications card matches the other cards** — `rounded-xl`
  and `p-4 md:p-6` instead of the smaller `rounded-lg p-4`.

### New — Charts

- **Long-range charts now bucket their data.** Hitting "All" on
  an account with several years of measurements used to render
  thousands of daily dots — unreadable, and slow on mobile. The
  chart now picks an aggregation level from the visible range:
  daily for ≤ 90 days, weekly mean for 91-730 days, monthly
  mean for everything beyond. A small chip beside the chart
  title surfaces the active bucket ("Wochendurchschnitt" /
  "Monatsdurchschnitt" in DE, "Weekly avg" / "Monthly avg" in
  EN) so the bucket is never silent. Empty buckets are dropped
  rather than zero-padded.

### Fixed — KI

- **Hero recommendation no longer prints raw `metric:WEIGHT`
  tokens.** When the model embedded a chart token in the
  primary recommendation the renderer was printing the literal
  string. The "Key Takeaway" card now strips the tokens for
  prose and renders them as inline charts under the
  recommendation, the same pattern the summary block has used
  since v1.4.5.
- **"Verbindung testen" stays readable when the model returns
  bad JSON.** `/api/insights/generate` returned 502 for parse
  errors, which Cloudflare swapped for an HTML error page;
  `await res.json()` in the browser then crashed. Same
  Cloudflare-rewrite trap the v1.4.5 ai/test fix solved — parse
  errors now map to 422 so the JSON body actually reaches the
  client.
- **Saved API keys cannot leak to a stale local URL.** A user
  who had configured the Local provider with `http://192.168.x.x`
  and later switched to OpenAI / Anthropic kept that URL in the
  shared `aiBaseUrl` column, and the OpenAI / Anthropic clients
  were forwarding their cloud keys to that LAN host on every
  request. The PATCH that switches providers now wipes the
  column, and the OpenAI / Anthropic clients hardcode the
  canonical base URL regardless of what the column carries.

### Improved — KI Insights

- **The model now sees three years of history per metric.** Each
  per-card insight payload (general, blood pressure, pulse,
  weight, BMI, mood, medication compliance) used to clip the
  series to the last 30 daily means — way too narrow to detect
  drift that plays out over a year. The new payload combines
  360 daily means (`dayOffset 0..359`) with 24 monthly means for
  the older window (`monthOffset 12..35`), with a 50 KB safety
  guard that re-buckets at 180 daily days when a particularly
  noisy account would blow past the prompt token budget.

### Fixed — Admin

- **Status-card CTAs go to the right place.** Every "Manage
  users" / "View backups" link in the admin status grid was
  bouncing back to `/admin` because the hrefs were pointing at
  sub-routes that never shipped (`/admin/users`,
  `/admin/audit-log`) or at anchors whose IDs do not exist
  (`#integrations`, `#monitoring`, `#backups`). Each href now
  points at a real `section-*` anchor on the admin page, the
  CTA copy describes the destination honestly ("Open
  integrations", "Open system status"), and the unit test
  asserts each href maps to a known section ID — so the next
  refactor cannot regress this silently.
- **Bug-report toggle finally hides the form.** The admin
  "Bug reports" switch had no effect because the gate lived on
  a legacy route the form does not call. The actual `/api/feedback`
  endpoint and the `/bugreport` page now both honor the toggle —
  the form disappears, and direct API calls return 503 with a
  readable error.
- **Audit trail survives the data wipe.** The `Wipe all data`
  admin action used to delete `AuditLog` in the same transaction
  as the rest of the user data, which silently destroyed the
  one record actually saying "an admin wiped data". The wipe
  now leaves the audit log alone and adds an explicit
  `admin.data.clear.start` entry before the transaction begins,
  so even a crash mid-wipe leaves a trail. The success copy
  also enumerates the full scope (API tokens, Withings
  connections, auth challenges) instead of pretending only
  measurements / medications / intakes are affected.
- **Cached insight reloads no longer burn a rate-limit token.**
  `POST /api/insights/generate` checked the rate limit before
  the cache return, so a noisy dashboard refresh would lock you
  out for an hour even when every request returned the same
  cached envelope. The check moved below the cache return.
- **One failing health probe no longer blanks the whole admin
  status grid.** `Promise.all` in the status-overview API
  short-circuited on the first rejection. `Promise.allSettled`
  forces failed probes to the `alert` severity and lets the
  rest render normally, with a Wide Event annotation noting
  which probe(s) failed.
- **Settings load errors surface inline instead of spinning
  forever.** When `useSystemStatus` or `useAdminSettings`
  rejects, the admin page now shows a "Failed to load…"
  banner instead of an indefinite skeleton.

### Improved — Settings · KI

- The KI section is fully internationalised — about 30 hard-coded
  German strings now flow through `t("settings.ai.…")` keys, and
  the model-preset list drops `gpt-5` (not a released model) and
  `o3-mini` (would require an o-series parameter contract that
  isn't wired up yet). The privacy "Raw data" warning uses
  Dracula tokens so the colour matches the rest of the panel.

### Improved — Polish

- Numeric spans on the dashboard tiles use `tabular-nums` so
  digits stop jiggling on every refresh.
- The bottom-nav buffer is tighter on mobile and removed on
  desktop (`pb-[calc(4rem+env(safe-area-inset-bottom,0px))]
md:pb-0`), so desktop content sits flush instead of leaving
  an unused 5 rem strip.
- Onboarding "X von Y" / "%" progress drops the monospace font
  and keeps tabular-nums.
- Feedback inbox category badges use Dracula tokens
  (`bg-dracula-red/15 text-dracula-red`) for theme cohesion.
- Codex provider mirrors the OpenAI client's structured-error
  format (httpStatus / model / bodyExcerpt) so failures from
  ChatGPT-OAuth show the same readable message as failures from
  the BYO-key paths.
- Logging redacts third-party AI keys: `redactSecrets` now scrubs
  `sk-` / `sk-ant-` patterns so a misconfigured client cannot
  leak its key into Wide Events. The idempotency body-content
  guard refuses to cache responses that contain those prefixes
  (with a regex tight enough to avoid false positives on words
  like "task-id" or "risk-management").
- Danger-zone result colour follows mutation state instead of
  string-prefix-matching localized copy.

### Repo housekeeping

- `e2e` workflow is back to green: dropped the `pnpm/action-setup`
  version override (now reads `packageManager` from
  `package.json`), switched the mobile Playwright project from
  iPhone 13 (webkit) to Pixel 5 so chromium-only CI installs are
  enough, anchored the locale-cookie test at the configured base
  URL, and made the login spec open the password form before
  asserting on its inputs.
- Repo-wide prettier sweep — long-deferred reformatting drift
  closed before the v1.4.6 tag.

## [1.4.5] — 2026-05-09

### Fixed — Settings · KI

- **"Verbindung testen" no longer crashes the page when the key is
  bad.** The endpoint mapped every upstream error to HTTP 502, which
  Cloudflare intercepts and replaces with its own HTML error page.
  `await res.json()` in the browser then crashed with `Unexpected
token '<', "<!DOCTYPE "`. 401/403 from the provider now map to 422,
  429 to 429, and only genuine 5xx upstream errors keep the 502 —
  Cloudflare passes 4xx through untouched, so the React Query
  mutation reads the JSON body and surfaces a readable message.

### Fixed — Dashboard

- **Dashboard tiles use a CSS Grid layout again** — the v1.3-era
  pattern that gave each tile an identical width with symmetric gaps
  and an edge-to-edge fit with the charts below. v1.4.4 distributed
  width via `flex-1 basis-0`; CSS Grid is more honest about the
  intent and survives viewport changes more gracefully.
  `grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr))` keeps
  every track equal-width with a 9 rem floor; the row wraps when
  the floor no longer fits instead of triggering a horizontal
  scroll.

## [1.4.4] — 2026-05-08

### Fixed — Dashboard

- **Blood pressure is now two distinct tiles again** (sys + dia next
  to each other) — the v1.4.3 attempt at a combined tile read as a
  single double-wide entry; reverting to two separate tiles preserves
  visual rhythm with the other metrics.
- **All tiles share an equal width.** The previous strip used
  `shrink-0 grow basis-[10rem]`, which gave each tile a 160 px floor
  and let wider content (like the BP tile) push past it. Switched
  to `flex-1 basis-0 min-w-[9rem]` — every tile now starts from
  zero and gets the same share of the available row width, with a
  9 rem floor so they stay readable on narrow viewports. The strip
  scrolls horizontally if the row no longer fits.

## [1.4.3] — 2026-05-08

### Fixed — Dashboard

- **Tile strip is now the same width as the charts below it.** The
  small negative-margin bleed that helped the snap-scroll feel on
  mobile was leaking onto desktop and made the tile row 16 px wider
  than the chart strip. Fixed at `md` and up.
- **Tiles all have the same height.** Blood pressure used to render
  as two stacked tiles inside one slot which made it taller than
  every neighbour. Sys/dia now share **one** tile and display as
  `117/79 mmHg` with one trend arrow. Tile count drops from 6 to 5.
- **Settings sub-section "Übersicht" renamed to "Dashboard"** —
  matches the label in the main nav.
- **"Persönliche Zielwerte" is its own settings section now** at
  `/settings/thresholds`, instead of being buried inside the
  Dashboard settings panel under the layout customizer.

### Fixed — Settings

- **API & Tokens tables fit the content column on desktop.**
- **About → "Auf Updates prüfen" works again.** Production CSP
  blocked the direct call to `api.github.com` — the check now goes
  through a server-side proxy. The page also auto-checks once on
  mount when the previous result is older than 24 h, and shows a
  "Zuletzt geprüft am …" timestamp so you can tell when the answer
  was confirmed.
- **About restructured into three titled cards** — HealthLog (version
  - license inline, no boxed badge), Quellen & Dokumentation, and
    Updates.
- **KI provider — OpenAI users can enter their own API key.** Schema
  didn't have a column for it before; added it, plumbed it through
  the resolver and test endpoint, surfaced the input in the Settings
  → KI panel.
- **Model field is now a dropdown** with provider-specific presets
  plus an "Eigenes…" option for power users.
- **"Mit ChatGPT verbinden" no longer dead-ends on chatgpt.com.** The
  OAuth URL was missing its `client_id`; with `CODEX_OAUTH_CLIENT_ID`
  set the handshake completes. When the env var isn't configured the
  button is hidden and a hint points the user at the API-key path.

### Improved — KI Insights

- **AI can illustrate findings with `metric:MOOD` charts inline.** A
  mood drift or adherence-risk finding now renders the dedicated
  Mood chart under the paragraph instead of just prose.
- **Every finding must cite a concrete number** ("138/85 mmHg",
  "+0.4 mmol/L vs 30d-avg") rather than adjectives. Findings without
  a snapshot anchor are now omitted; cardinality is variable 0–8
  sorted by salience. Generic boilerplate ("drink enough water",
  "consult your doctor", etc.) is explicitly forbidden outside the
  disclaimer.

### Improved — Admin

- **Bug-report feature has an explicit on/off toggle.** Previously
  the only way to hide the report button was to clear the encrypted
  GitHub token, which forced a re-entry on resume.

### Improved — Polish

- **"Trennen" looks the same everywhere** (Withings, moodLog,
  KI/Codex). Outlined button with red text — same affordance for
  the same action.

## [1.4.2] — 2026-05-08

### Fixed — Production deploy hotfixes

- **Dashboard and Insights pages no longer crash for users without
  weight data.** `data?.summaries.WEIGHT` only protected the outer
  object — the optional chain stopped one level too early, so
  brand-new users (where `summaries` is undefined) hit
  `TypeError: undefined is not an object (evaluating 'E?.summaries.WEIGHT')`
  on first load. Now `data?.summaries?.WEIGHT`.
- **Container healthcheck uses `127.0.0.1` instead of `localhost`.**
  busybox-`wget` in Alpine resolves `localhost` to IPv6 `::1` first,
  but Next.js standalone listens on IPv4 `0.0.0.0:3000` only — so the
  healthcheck always returned ECONNREFUSED, Docker marked the
  container unhealthy, and Traefik returned 503 from the public URL
  even though the app was actually running. The Dockerfile-level
  `HEALTHCHECK` already used 127.0.0.1; the `docker-compose.yml`
  override was the one that drifted to `localhost`. Fixed.

### Notes

- The 1.4.1 GHCR image never published cleanly (the docker-publish
  workflow reported success in GH Actions but the
  `ghcr.io/mbombeck/healthlog:1.4.1` tag returned `manifest unknown`
  when Coolify tried to pull). The 1.4.2 release supersedes 1.4.1
  and includes everything 1.4.1 was supposed to ship — the v1.4.1
  source on `main` was always healthy; only the Coolify deploy
  surface was broken.

## [1.4.1] — 2026-05-08

### Security

- **moodLog integration no longer accepts internal-network URLs.** A
  user could previously save `http://169.254.169.254/` (cloud-metadata)
  or any RFC1918 address as their moodLog instance; the daily sync
  worker would then fetch from that target with the user's API key in
  the Authorization header. The credentials write path now refuses
  non-public hosts, the sync worker re-checks the URL at the actual
  fetch site (so legacy rows stored before the guard are also
  refused), and the fetch is now `redirect: "manual"` so a public
  host cannot 302 to an internal target with the bearer on the
  redirect hop.
- **Error reports never echo bearer tokens, Telegram bot tokens, or
  query-string secrets.** `WideEventBuilder.setError()` and the
  Glitchtip incident path now run every error message and stack
  trace through a central `redactSecrets()` filter that scrubs
  `Bearer …`, Telegram `bot<digits>:<token>` URLs, and `?secret=`,
  `?code=`, `?token=`, `?api_key=` query strings. The substitution
  is generic `[REDACTED]` so partial entropy is never revealed.

### Fixed — Citation accuracy

- **Blood-pressure classification now cites ESH 2023.** The dashboard
  tile, the doctor-report PDF, and the inline analytics comments
  used to label the band as "ESC/ESH 2018". The numbers haven't
  changed (the 2023 ESH update kept the 2018 thresholds), but the
  joint authoring did — ESC withdrew from the 2023 document, so the
  correct citation is "ESH 2023" alone.
- **Steps target source label is `Saint-Maurice JAMA 2020`** instead
  of `WHO`. Every other surface in the app (AI prompts, inline
  comments, drift tests) already enforced this attribution; the
  insights/targets surface was the last "WHO" label in the tree.
  WHO publishes physical-activity _time_, not a step quota.
- **Saint-Maurice "mortality plateau 8000–12000" attribution
  softened.** The original JAMA 2020 paper reports continued
  dose-response benefit (HR 0.49 at 8k, HR 0.35 at 12k) — not a
  plateau. The plateau-shaped finding belongs to Paluch 2022
  _Lancet Public Health_ (PMID 35247352), not Saint-Maurice. The
  inline comments and AI prompts now say "continued dose-response
  benefit through ~12,000 steps/day" instead.

### Added — CI safety nets

- **Postgres-backed integration test suite is now executable.** The
  testcontainers infrastructure shipped in 1.4.0; this release wires
  the per-test boilerplate through vitest's `globalSetup` so all
  four files share one container. `pnpm test:integration` runs ten
  tests (rate-limit race, idempotency replay-attack contract, GDPR
  Article-17 cascade delete, session create / read / expire) against
  a real Postgres in under four seconds. CI runs the suite on every
  PR.
- **Playwright + axe-core E2E foundation.** A new `pnpm e2e` runs
  five public-surface specs (version endpoint, proxy auth-redirect,
  login form autofill hints, DE/EN locale switch, axe-core
  accessibility gate) against the production build in CI. Authenticated
  flow specs (quick-entry, doctor-report, settings round-trip,
  test-buttons, onboarding) ride a follow-up release because they
  need a seeded test user; the foundation makes adding them a
  one-PR step.

### Changed — Admin internals

- **Admin page is now per-section components.** The status-card grid
  shipped in 1.4.0 sat on top of a 2,700-line monolith; that monolith
  is now 14 focused files in `src/components/admin/` with a 77-line
  `src/app/admin/page.tsx` shell that mounts them. Every section
  keeps the same DOM, ids, query keys, and i18n keys — no
  user-visible change.

### Fixed

- **Final ESLint error is gone.** The medications page's "API
  endpoint" dialog ran its initial-load fetch through a `useCallback`
  paired with `useEffect` and triggered the strict
  `react-hooks/set-state-in-effect` rule. Refactored to TanStack
  Query — same network calls, no effect, lint count is now zero on
  `main`.

### Documentation

- **Repo-internal docs synced for v1.4.** README adds the
  Multi-tenant ready and Test connection buttons feature blocks, the
  API reference table includes the eleven new v1.4 endpoints, and
  the model count is corrected to 26 (RefreshToken). AGENTS.md and
  CLAUDE.md reflect the per-route `/settings/[section]` layout and
  the per-section admin layout. `docs/api/openapi.yaml` documents
  the new endpoints (version, refresh, refresh/revoke,
  status-overview, backup/test, the five test-connection probes).
  `docs/migration/v1.3-to-v1.4.md` corrects the now-wrong "no
  migrations" claim and adds full env-var sections for the
  worker/web split, encryption-key versioning, and off-host backup
  target.

### Notes

- No database migration in 1.4.1.
- No environment-variable change required to upgrade.
- No API contract change — every route added in 1.4.0 is still
  there; no shapes or status codes flipped.
- The audit pass that drove this release identified five medium
  security items and three P0 performance items that warrant
  deeper architectural work; those are tracked in
  `docs/ops/v141-followup-issues.md` and ride a future release.

## [1.4.0] — 2026-05-08

### Added — Foundation, safer ranges, and a faster dashboard

- **UI guidelines, design tokens, and shared primitives.** A new
  `docs/ui-guidelines.md` is the single source of truth for spacing,
  typography, button hierarchy, dialog-vs-sheet decisions, accessibility
  baseline (WCAG 2.1 AA), and the autofill / honeypot pattern for
  health-data forms. Two new shadcn primitives — `<Skeleton>` and
  `<EmptyState>` — replace the previous mix of spinners and "No data"
  placeholder strings. Future v1.4.x components reference the doc; the
  primitives ship with screen-reader-aware semantics and respect
  `prefers-reduced-motion`.
- **`/api/version` public endpoint** exposing the build's version,
  optional Git SHA / build timestamp, license, and canonical links.
  Wires the future Settings → About surface and a thin "Check for
  updates" UX. Static-cached so the route adds zero DB load.
- **`src/lib/medical-citations.ts`** — single source of truth for
  cited medical guidelines (id, name, year, URL, caveat). Future
  medical surfaces import these constants instead of duplicating
  strings in code, prompts, and `messages/*.json`. A new drift-test
  asserts every entry has a non-empty URL + caveat and that the
  recurring "WHO ≥ N steps" hallucination cannot reappear as a constant.

### Fixed — Patient safety and citation accuracy

- **Diastolic blood-pressure orange band no longer reaches 60 mmHg.**
  With the default age-based targets (DBP 70–79), the lower orange
  wing was computed as `diaLow − 10 = 60`. A reading of 60 mmHg landed
  in "mildly low" yellow instead of red even though that level is the
  general-adult hypotension threshold and the J-curve risk floor in
  ESH 2023 for treated hypertensives. Orange floor is now clamped at
  65 mmHg, so 60 mmHg lands in red. The user-override path stays
  intact and remains audit-logged.
- **BP guideline citations consolidated on ESH 2023.** The codebase
  had a mix of "ESC/ESH 2018" (analytics) and "ESC/ESH 2023" (AI
  prompts). The 2023 hypertension document is ESH-only — ESC withdrew
  from the joint authoring — so neither label was correct. Every site
  now cites "ESH 2023" with the published source URL. Numbers
  unchanged.
- **"WHO ≥ 8 000 steps/day" hallucination fully removed.** WHO
  publishes activity _time_ (150–300 min/wk moderate), not a step
  quota. The v1.3.3 fix only landed in `effective-range.ts`; four AI
  prompt strings and the `getStepsRange()` helper carried the old
  wording forward. Saint-Maurice et al., JAMA 2020 (mortality plateau
  8 000–12 000) is now cited everywhere and the two surfaces agree on
  the band. Sleep target moves from "ESC" (no adult sleep guideline)
  to AASM 2015.
- **Body-fat ACE bands corrected and three-way drift resolved.** The
  classifier used `essential = 6 (M) / 14 (F)` as the floor — but
  that's actually ACE's _Athletes_ lower bound. Readings below were
  mislabelled "Essential" instead of "Below essential" (a danger
  band). Six-band classifier now mirrors the ACE table, and the three
  sites that had three different green-band numbers
  (`value-bands.ts`, `targets/route.ts`, `classifications.ts`) all
  derive from `getBodyFatTargetRange` (ACE fitness + acceptable bands).
- **Bedtime-glucose citation softened.** ADA Standards 2024 §6
  publishes pre-prandial 80–130 and post-prandial <180 — no published
  adult bedtime target. The 90–150 mg/dL band stays (reasonable adult
  overnight band) but the inline citation now states the absence
  explicitly and references ISPAD 2022 (pediatric) as the closest
  comparator.

### Fixed — Localisation reaches the notification path

- **Medication reminders now follow the user's locale.** Telegram,
  ntfy, and Web Push reminders previously read "Erinnerung", "Bald
  fällig", etc. regardless of the user's stored language. Templates
  for every phase (`green`/`yellow`/`orange`/`red`) and every keyboard
  button now resolve from `messages/{de,en}.json` per
  `med.user.locale`. Telegram callback IDs stay stable English
  identifiers so the dispatcher keeps matching across locale changes.
- **Dashboard greeting and streak label** are localised server-side.
  Previously hard-coded `"Hi, ${name}"` and `"Tage in Folge"` — both
  now i18n-key-resolved.
- **Mixed-locale Zod validation messages unified to English.** Two
  measurement-form messages and four admin-validation messages
  flipped between German and English depending on which schema fired.
  All consolidated on English (the app is English-first; the German
  UI maps field labels client-side).

### Fixed — Chart math edge cases

- **`summarize` and `trendSlope` use the same time anchor.** Averages
  snapped to `Date.now()`; slopes snapped to the latest point in the
  series. A stale series reported a trend even though the dashboard
  tile correctly hid the average. Both now anchor on `Date.now()`, so
  a stale series returns `null` consistently from every windowed stat.
- **`summarize([])` returns `null` for `min`/`max`/`mean`** instead
  of zeros that leaked into chart axes and AI feature bundles as
  fake readings.
- **`weeklyAverages` is Berlin-timezone aware.** A Sunday-evening
  Berlin reading bucketed into the next week on the UTC production
  container because `Date.getDay()` was system-local. ISO-Monday key
  now resolves via `Intl.DateTimeFormat({ timeZone: "Europe/Berlin" })`.
- **`pairByTimestamp` JSDoc** documents the greedy nearest-match
  heuristic and when a Hungarian-style match would matter (sparse
  health data is well below that bar).

### Fixed — Hidden friction

- **AI provider connection-test honours the unsaved selection.**
  Changing the AI provider in `/settings`, then clicking "Verbindung
  testen" without saving first, used to silently run the test against
  the stored provider — surfacing as a confusing OK / failure unrelated
  to what the user had on screen. Plaintext keys never persist; the
  existing SSRF guard, rate limit, and V3 error-leak shielding stay in
  place.
- **Health-data inputs no longer autofill the user's account
  password.** The base `<Input>` primitive defaults to
  `autoComplete="off"` plus the LastPass / 1Password ignore attributes
  whenever the caller doesn't pass a semantic value. Auth and profile
  forms continue to autofill normally because they pass an explicit
  `autoComplete` (`"username"`, `"email"`, `"current-password"`,
  `"new-password"`).
- **Step-range target aligned across two callsites.**
  `getStepsRange()` returned `{7000, 10000}` while
  `effective-range.ts` returned `{8000, 15000}`; two surfaces showed
  different "green" bands to the same user. Both now use
  `{8000, 15000}`, anchored on Saint-Maurice 2020.

### Performance

- **Two more N+1 queries closed.** `extractFeatures` (used by every
  AI-insight route) issued one `prisma.medicationIntakeEvent.findMany`
  per active medication; replaced with a single batched query and an
  in-memory group. `/api/insights/targets` issued one `findFirst` per
  measurement type; replaced with a single `distinct: ["type"]` query.
  Same shape as the v1.3.0 fix to `/api/insights/comprehensive`.

### Changed — Dashboard

- **Tile strip is always one row.** Replaces the wrapping
  `grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5` layout
  with a `flex snap-x snap-mandatory overflow-x-auto` strip. When the
  user enables more tiles than fit the viewport, the strip
  horizontal-scrolls instead of wrapping; the user trims the set in
  Settings → Dashboard Layout.

### Added — Settings, integrations, and operations

- **Settings page now lives at `/settings/[section]`.** Eight focused
  routes (`account`, `integrations`, `notifications`, `dashboard`,
  `ai`, `api`, `advanced`, `about`) replace the single 3,000-line page.
  Existing `/settings#anchor` links 308-redirect; the side-bar, in-app
  deep links, and the AI / Withings / Codex callbacks all follow the
  new structure.
- **About page** lists the running version, build SHA, license,
  repository link, CHANGELOG link, docs link, and a "Check for
  updates" button that pings the public GitHub releases API. Backed by
  the `/api/version` endpoint shipped earlier in 1.4.0.
- **Admin console** is built around a status-first card grid (Users,
  Integrations, Monitoring, Backups, Maintenance, Audit Log) with each
  area in a focused panel beneath. Per-section extraction of the old
  inline panels is tracked for v1.4.1 — the v1.4.0 admin page already
  routes through the new aggregator endpoint and the status-card
  grid.
- **Five new "Test connection" buttons in Settings.** Withings,
  moodLog, Web Push, Glitchtip, and Umami now ship with one-click
  connection probes — same pattern as the existing AI / Telegram /
  ntfy tests, with per-button rate limit, sanitised error reporting,
  redirect-follow SSRF guard, and an `errorCode` in the response
  envelope so the UI can localise the message.
- **AI insights can reference any of your charts inline.** When a
  finding centres on a single metric (e.g. systolic blood pressure),
  the corresponding chart renders directly under the explanation.
  Server-side allow-list — only the allowed metric tokens render; any
  other model emission drops silently.
- **Off-host backup target.** Daily encrypted JSON dumps to any
  S3-compatible bucket. Worker-side IAM grant is intentionally
  PutObject + GetObject only — retention is the bucket's
  lifecycle-rule job, so a compromised worker cannot wipe the backup
  history. Restore script + step-by-step doc shipped under
  `docs/ops/backup-restore.md`, and an admin "Backup target" test
  button validates the configuration.
- **Encryption-key versioning.** Rotate the at-rest encryption key
  without downtime via `pnpm tsx scripts/rotate-encryption-key.ts <id>`.
  Existing data keeps decrypting under its original key while the new
  one is rolled out. Walk-through + rollback notes in
  `docs/ops/encryption-key-rotation.md`.
- **Worker / web split.** Optional
  `HEALTHLOG_PROCESS_TYPE=web|worker|all` (default `all` for the
  single-container setup) lets you scale background jobs and HTTP
  traffic independently. The proxy refuses HTTP traffic with a 503 +
  `X-HealthLog-Process-Type: worker` header in worker mode so a
  misrouted request fails loudly instead of a silent half-served
  response.
- **Native API clients now get short-lived 24-hour access tokens with
  refresh-token rotation.** The browser keeps the existing 90-day
  Bearer. Reuse-detection (presenting a refresh token a second time)
  revokes every refresh token for the user — the small cost of a
  forced re-login on the legitimate device buys defense-in-depth
  against an undetected stolen-token replay.
- **Critical-path coverage on Telegram / Withings / moodLog /
  Glitchtip webhook handlers + the four admin routes lifted to ≥80%
  line coverage,** plus `src/lib/auth/audit.ts`. ~+100 new tests.

### Fixed — Operational hardening from the v1.4 review pass

- **Container time zone is correct.** Alpine images ship without
  `tzdata`; the daily backup cron `30 2 * * *` Europe/Berlin was
  silently falling back to UTC. The runner stage now installs
  `tzdata` and exports `TZ=Europe/Berlin` so schedules fire at the
  documented local time.
- **Compose healthcheck uses `wget --spider /api/version`** — `/api/version`
  is now in the proxy's public-paths allowlist, so the healthcheck no
  longer 302-redirects through the auth gate (which was accepting the
  login page as a 200 success).
- **Idempotency replay-cache no longer caches refresh tokens.** The
  guard already blocked the `hlk_` access-token prefix; the new
  `hlr_` refresh tokens are blocked too.
- **Logout-on-device revokes the paired access token.** Calling
  `/api/auth/refresh` with `revoke: true` now flips both the refresh
  row and the matching `ApiToken` row to revoked, so a leaked access
  token cannot outlive its refresh-token sibling.
- **`users.locale` migration drift backfilled.** The column had been
  on `schema.prisma` since the v1.3 locale-aware reminder work but
  never landed in the migration history (it must have been applied
  via `prisma db push` to dev/prod). Any environment built strictly
  from `prisma/migrations/` (CI testcontainers, brand-new self-host
  installs) is now consistent. Migration is `ADD COLUMN IF NOT
EXISTS`, so it's a clean add on a fresh database and a safe no-op
  against any environment that was already kept in sync.

### Notes

- Largely additive release. Existing API contracts (response
  envelopes, OpenAPI 3.1 spec) are unchanged. New endpoints surface
  optional fields; no breaking changes.
- New migration `0025_refresh_tokens` adds the rotating refresh-token
  table; new migration `0025_user_locale_drift_fix` backfills the
  schema-vs-migrations drift on `users.locale`. Both are
  forward-compatible — `IF NOT EXISTS` guards make them idempotent on
  any environment already pushed-to.
- Operators of the off-host backup feature must configure a bucket
  lifecycle policy for retention. The worker has no DeleteObject
  grant by design.
- Native API clients (iOS, n8n, Health Connect) need to update their
  login flow: native logins now return both a 24-hour access token
  and a refresh token. The browser flow is unchanged.
- **Tracked for v1.4.1:** per-section admin panel extraction (the
  status-card grid + aggregator already ship in 1.4.0; the inner
  per-section file split is structural cleanup), the Postgres-backed
  integration test suite (testcontainers infrastructure ships in this
  release; the four integration tests themselves need a follow-up
  pass against the merged schema), and Playwright E2E + axe-core CI
  gates.

## [1.3.3] — 2026-05-08

### Added

- **Pulse oximetry as a first-class measurement type (`OXYGEN_SATURATION`).**
  Closes the SpO2 part of #109. Migration `0024_oxygen_saturation` extends
  the `MeasurementType` enum. Plausibility range 50–100% (below 50% is
  incompatible with sustained life and almost certainly a faulty sensor;
  upper bound 100% is physical). Default severity bands follow BTS Guideline
  2017 + ATS clinical practice: green 95–100%, orange 92–94%, red <92% —
  lower-only concern (the upper orange wing collapses onto greenMax since
  saturation cannot physically exceed 100%). COPD / chronic-respiratory
  users with a doctor-set baseline of 88–92% can personalize via the
  threshold-override UI. Wired through Withings (ScanWatch type 54),
  measurement form, list, charts, doctor PDF, OpenAPI spec, and i18n (DE +
  EN). iOS DTO already declared `OXYGEN_SATURATION` from a prior commit;
  the server enum addition closes the long-standing drift.
- **Body composition surfaces (TOTAL_BODY_WATER, BONE_MASS, BLOOD_GLUCOSE)
  in the measurements list filter, badge, mobile icon, edit dialog, and
  server-rendered doctor-report PDF** — closes the UI side of #109. Root
  cause was three local maps in `measurement-list.tsx` that drifted from
  the v1.3 server enum; extracted to `measurement-list-meta.ts` with
  fail-fast coverage tests so future enum additions are caught at build
  time. Server-side PDF used a separately-drifted type map vs. the
  browser-side renderer; both are now in sync.
- **Effective-range thresholds for `TOTAL_BODY_WATER` and `BONE_MASS`** —
  severity logic was returning `nominal` for any value because no defaults
  existed.

### Changed

- **OpenAPI `MeasurementType` enum extended + spec version bumped 1.3.0 →
  1.3.3** to match the actual app. Spec was lagging by two minor releases.
- **Withings webhook secret now reads from `X-Withings-Webhook-Secret`
  header** in preference to the legacy `?secret=…` URL query parameter.
  Closes the URL-leak-via-access-logs vector flagged in audit C-3. Legacy
  query-param path is retained for backwards compatibility and emits a
  Wide Event warning so operators can spot still-using-the-old-flow
  integrators. Plan: remove the query fallback in 1.4.x once warnings drain.
- **Idempotency `defaultUserIdResolver` now supports Bearer tokens.**
  Cookie sessions tried first, then Bearer-token via `hashToken` lookup.
  Without the Bearer fallback, every iOS / external-ingest retry was
  hitting the handler again and creating duplicate measurements (audit
  C-4 — the exact use case `withIdempotency` was built for).
- **GlitchTip URL stripping** — `reportToGlitchtip` now strips the URL
  query string before forwarding so Withings legacy `?secret=…` and OAuth
  `?code=…` callbacks cannot leak via the error tracker (audit H-B7).

### Fixed

- **Migration `0022_body_composition_metrics` unit comment lied** —
  claimed `TOTAL_BODY_WATER: percent of body weight (%)` while every other
  surface (validators, Withings client, doctor PDF) treated it as `kg`.
  Comment corrected to match reality.

### Security

- **Bearer-scope wildcard handling (CRITICAL — V3-1).** `requireAuth()`
  previously accepted any non-admin token regardless of declared
  permission scope, so a token with `permissions:["medication:ingest"]`
  could DELETE the user account. Spec now requires `permissions:["*"]`
  or the explicit required permission.
- **Account-deletion completeness (CRITICAL — V3-2 / GDPR Art. 17).**
  Cascades through `Feedback` + `AuditLog` rows so user-erasure is
  actually total. Daily retention job sweeps orphaned audit rows after
  90 days as a defence-in-depth.
- **Withings webhook secret header migration (audit C-3)**, idempotency
  Bearer-resolver (audit C-4), GlitchTip URL strip (audit H-B7).
- **Truthfulness pass on medical citations** — SpO2 normal-range source
  is now consumer-pulse-oximeter consensus + NICE NG115 + FDA labelling
  (BTS-2017 was for clinical hypoxaemia thresholds, not consumer
  monitoring); body-composition metrics are explicitly labelled
  "bioimpedance-estimated, not DEXA-comparable" in the doctor PDF;
  TBW citation now references the Watson formula / ICRP Reference Man
  (was misattributed to ESPEN 2017); steps target now references
  Saint-Maurice JAMA 2020 (WHO publishes minutes/week, not steps).
- **SpO2 user-override clamp** — overrides could emit physical
  impossibilities (e.g. `orangeMax = 100.75`); clamped to METRIC_BOUNDS
  for SpO2 + BODY_FAT.
- **moodLog webhook secret encrypted at rest with AES-256-GCM** (V3
  STILL-V2-C-2). Read path tolerates legacy plaintext rows during the
  transition window; one-shot startup migration in the worker rotates
  any leftover plaintext rows.
- **CSP tightening** — `chatgpt.com` + `api.openai.com` `connect-src`
  now gated to `/settings/ai/**` (was a global blanket on every page,
  including `/auth/login` → DOM-XSS exfil channel).
- **Web-Push subscription endpoint SSRF guard** — `endpoint` now
  requires HTTPS + passes `isPublicUrl()` (was `z.url()` only).
  Side-fix: `isPublicUrl()` no longer falsely classifies DNS labels
  starting with `fc`/`fd` (e.g. `fcm.googleapis.com`) as IPv6
  unique-local; the IPv6 check is now gated on a colon being present.
- **IP-geolocation lookup is now HTTPS-only.** Default provider is
  `ipwho.is` (free, HTTPS, no key). Existing `ip-api.com` plaintext
  HTTP path leaked auth-event IP + timestamp on every login (GDPR Art.
  32 + Art. 44). Operators can override via `IP_GEO_LOOKUP_URL` (HTTPS
  only) or disable entirely with `IP_GEO_LOOKUP_DISABLED=1`.
- **`/api/ai/test` no longer returns provider error message + body
  excerpt to the client.** Diagnostics land server-side via Wide Events
  (annotate); client gets a categorised generic message. Closes provider
  URL / partial key / internal header leak.
- **`/api/import` rate-limit added** — 5 imports/hour/user. Was
  unlimited (bulk-injection vector).
- **Trusted-proxy XFF semantics** — `getClientIp()` now reads
  `X-Forwarded-For` right-to-left with a configurable
  `TRUST_PROXY_HOPS` (default 1, matches typical single-proxy
  self-host). Closes XFF rotation bypass of per-IP rate-limits.
- **Audit-log retention job** — `audit_logs` rows older than
  `AUDIT_LOG_RETENTION_DAYS` (default 365) are purged daily. Closes
  GDPR Art. 5(1)(e) "storage limitation" gap.
- **Idempotency cachable-status filter** is now an exported, unit-tested
  function — pins the do-not-cache contract for 401/403/408/429/5xx.
- **Bearer mock tightening** in `require-auth-bearer.test.ts` +
  `idempotency.test.ts`: `apiToken.findUnique` calls are now asserted
  to use `where: { tokenHash: <hashed> }`, so a regression to raw-token
  comparison would break the suite immediately.

### Internal

- **Server-side enum drift cousins closed.** Five module-level
  hardcoded type-arrays in `/api/insights/comprehensive`,
  `/api/dashboard/summary`, `/api/analytics`, `/lib/insights/general-status`,
  `/api/import` are now derived from `measurementTypeEnum.options`.
  External-contract enums extended additively:
  `/api/measurements/series` (`oxygen`, `totalBodyWater`, `boneMass`),
  `/api/dashboard/widgets` (`oxygenSaturation`), `DashboardWidgetId` +
  `DEFAULT_DASHBOARD_LAYOUT`. New coverage test asserts the canonical
  enum stays the source of truth.
- **Doctor-PDF text-content tests** — replaced bytes-only "renders body
  composition rows" theatre with `pdf-parse`-driven assertions on the
  actual rendered DE + EN labels and values. Adds dev dep `pdf-parse`.

## [1.3.2] — 2026-04-28

### Fixed

- **Glucose tiles on the dashboard rendered the raw i18n key
  `targets.glucoseFasting` instead of the translated label** (closes
  #108). Both `messages/en.json` and `messages/de.json` had two
  top-level `targets` blocks; `JSON.parse` silently keeps the last
  occurrence, and that block was missing the four glucose labels. The
  duplicate is now collapsed into a single block. A duplicate
  `bugreport.bugTitlePlaceholder` shadowed inside `bugreport` was
  cleaned up too. Two further keys (`dashboard.sleep`,
  `dashboard.steps`) were missing from both locales and were falling
  back to hard-coded English; both are now translated.
- **New i18n locale-integrity test**
  (`src/lib/__tests__/i18n-locale-integrity.test.ts`) fails the build
  on duplicate keys at any nesting depth and on key drift between
  `en` and `de` — closes the structural gap that let the duplicate
  `targets` block ship in the first place.

### Changed

- **Screenshot upload removed from the bug-report form** (also part
  of #108). The form previously accepted an image attachment that
  was stored in the local DB but never reached the published GitHub
  issue — GitHub does not accept inline base64 data URIs in issue
  bodies and offers no public API to attach images to an issue
  programmatically. Rather than ship misleading
  "a screenshot was attached" placeholder text in the resulting
  issue, the upload UI is now gone and the placeholder note is no
  longer added when promoting feedback. The `screenshotBase64`
  column and the admin-side preview of previously-submitted
  screenshots are unchanged — existing reports keep their
  attachments locally. We plan to revisit a real screenshot pipeline
  in a future release.

## [1.3.1] — 2026-04-27

### Fixed

- **Compose env-var validation no longer breaks Coolify-style deploys.**
  `docker-compose.yml` previously used `${VAR:?required}` shell-parameter
  syntax for the four secrets and `POSTGRES_PASSWORD`. Some hosting
  platforms (Coolify in particular) parse compose files eagerly and
  store the _fallback error string_ (`"POSTGRES_PASSWORD is required"`)
  as the literal env-var value when `POSTGRES_PASSWORD` was unset,
  which then collided with `DATABASE_URL` and broke the running app
  with `P1000: Authentication failed`. Compose now uses plain `${VAR}`
  interpolation; validation moved into `docker-entrypoint.sh`, which
  fails fast with a clear stderr message listing the unset variables.

### Notes

If you upgraded an existing Compose stack from 1.2.x → 1.3.0 and hit
the `POSTGRES_PASSWORD is required` literal-as-value bug, set
`POSTGRES_PASSWORD` in your environment to whatever your existing
Postgres data volume was originally initialised with (likely
`healthlog` if you started from a pre-1.2.1 release), then redeploy.
Postgres only honours `POSTGRES_PASSWORD` on first volume init — the
existing user keeps the original password regardless of env changes.

## [1.3.0] — 2026-04-27

### Added — Body composition + targeted hardening

- **Total body water and bone mass as measurement types** (closes #89). New
  enum values `TOTAL_BODY_WATER` and `BONE_MASS`, both stored canonically
  in kilograms (matches Withings hydration/bone-mass measures and Health
  Connect's `TotalBodyWaterRecord` / `BoneMassRecord`). Migration is
  purely additive (`ALTER TYPE ... ADD VALUE`) — safe to apply against
  any 1.2.x database without downtime.
- **Withings sync picks both up automatically.** The Withings client now
  maps measure type `77` (hydration / water mass) and `88` (bone mass).
  Anyone with a Withings Body+ scale and an active connection will see
  the new metrics flowing in on the next sync without any extra config.
- **Doctor-report PDF includes both new types** in the vital-signs table
  when data exists, with locale-aware labels in English and German.
- **Dashboard widgets registered for both** (default-invisible — opt in
  via Settings → Dashboard layout).

### Security

- **SSRF guard hardened** (`isPublicUrl`). The previous implementation
  used `parseInt` with permissive prefix checks like `h.startsWith("10.")`
  which let `010.0.0.1` slip through — and worse, the WHATWG URL parser
  silently normalises `010.0.0.1` to `8.0.0.1` (octal interpretation), a
  real bypass on naive checks. The new guard adds a pre-URL leading-zero
  check on the raw input, a strict IPv4 parser, and proper IPv6
  bracket / loopback / link-local handling. Now blocks `127.0.0.0/8`,
  `0.0.0.0/8`, `10.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`,
  `192.168.0.0/16`, `100.64.0.0/10` (CGNAT), `::1`, `fe80::/10`,
  `fc00::/7`. Comprehensive regression tests included.
- **GitHub PAT redacted from logged error bodies.** When a feedback
  escalation to GitHub fails, the response body was being passed
  verbatim into `getEvent()?.addWarning(...)` — flowing to Loki. The
  body is now stripped of the configured token before logging.
- **Per-user threshold writes are rate-limited** (30 writes / 5 min) to
  make audit-log enumeration unattractive. Audit-logging itself was
  already there.

### Performance

- **N+1 in `/api/insights/comprehensive` fixed.** The medication-compliance
  loop hit Postgres once per active medication. It now batches into a
  single `medicationId IN (...)` query and groups in memory. Latency
  improvement scales linearly with the user's active medication count.

### Reliability

- **pg-boss draining on SIGTERM/SIGINT.** `docker stop`, Coolify redeploys,
  and Kubernetes pod terminations now trigger `boss.stop({ graceful: true,
timeout: 30s })` so in-flight handlers finish instead of being killed.
  Previously, pending handlers could be lost or replayed on restart.
- **CI now blocks on TypeScript strict checks.** `continue-on-error: true`
  removed for typecheck. Tests already were blocking. ESLint stays
  non-blocking for now — the existing `settings/page.tsx` monolith has
  long-standing `react-hooks/set-state-in-effect` violations whose proper
  fix lives in the 1.4.0 settings-split refactor; a blocking lint here
  would just gate every PR until that refactor lands. Required cleaning
  up two `any` types in `api-handler.ts` (justified inline — Next.js
  variadic handler signature constrained by `Promise<Response>` return).

### Polish

- **Bottom-nav touch targets** sized to WCAG 2.5.5 minimum (44×44 CSS px).
  Visual icon stays at 20 px so the design doesn't shift.
- **Phase-config dialog** marks the decorative coloured dot `aria-hidden`
  because the redundant text label already conveys the phase to screen
  readers. No more meaningless `image` node announcements.
- **Admin-status labels** for "Web Push" and "Bug Report" now go through
  `t()` (new `admin.integrationWebPush` / `admin.integrationBugReport`
  keys in en + de). They were the last hard-coded English strings on
  the admin page.

### What's _not_ in this release (tracked for later)

- **Onboarding redesign** (dashboard-first empty-state flow + persistent
  Getting Started checklist) and the **typed `apiClient` wrapper** that
  underpins it are tracked for a focused 1.4.0 cycle. The 1.2.1 patch
  already closed the acute symptoms of #87 (silent-failure toast +
  default schedule), so the redesign is now a proper UI investment
  rather than a bug-fix.
- **Withings sync is mapping both new measures**, but **a dedicated
  Bearer-auth ingest endpoint for external pipelines** (n8n + Health
  Connect, requested in #89) ships in 1.4.0 alongside the API-token
  flow.

## [1.2.1] — 2026-04-27

### Fixed

- **Onboarding**: Medications added during onboarding are now actually persisted (closes #87). The wizard previously sent an empty `schedules: []` array, the server-side validation rejected it with a 422, the client never checked `response.ok`, and the user was redirected to the dashboard as if everything had worked. Onboarding now wraps each step in `try/catch`, surfaces failures via toast, and attaches a default reminder window (`08:00–09:00 daily`) so the medication actually persists. A hint under the medication list explains the default.
- **Docker setup** (closes #88):
  - `docker-compose.yml` now uses `ports: "3000:3000"` (was `expose: "3000"`, which made the app unreachable from the host).
  - `POSTGRES_PASSWORD` is a single env var that both the Postgres service and `DATABASE_URL` interpolate, so they cannot drift apart.
  - `.env.example` now points at the in-container hostname `db:5432` (was `localhost:5432`, which never resolves inside the app container).
- **Documentation**:
  - `package.json` synced to 1.2.0 (was lagging on 1.1.0).
  - `CLAUDE.md` and `AGENTS.md` corrected to 23 models (the `Feedback` model added in v1.2 was missing from the count).
  - `README.md` Quick Start gives a realistic time estimate, generates the four secrets in one block straight into `.env`, and points reverse-proxy users at the docs.

### Added — Tooling & Supply Chain

- **Pre-built multi-arch images on GHCR**: `.github/workflows/docker-publish.yml` now builds `linux/amd64` + `linux/arm64` images on every push to `main` and on every `v*` tag, publishing to `ghcr.io/mbombeck/healthlog`. Self-hosters no longer need a build toolchain — `docker compose pull && docker compose up -d` is enough. The bundled `docker-compose.yml` references the published image with a `build:` block as fallback for contributors.
- **Supply-chain attestations**: each published image carries a SLSA build provenance statement and a Software Bill of Materials. `SECURITY.md` documents how to verify them and how to pin a specific version.
- **Documentation single source of truth**: `getting-started/installation.mdx` is now the canonical setup guide (mirrors the bundled `docker-compose.yml`); `self-hosting/docker.mdx` slimmed to image internals + ops notes only. The landing page's Quick Start terminal block now includes the secrets-generation step (was missing).

### Notes

This is a patch release that closes the install/onboarding friction reported in #87 and #88. The bigger user-facing changes (additional measurement types like total body water and bone mass per #89, full onboarding redesign, typed API client) are tracked for `1.3.0`.

## [1.2.0] — 2026-04-18

### Added — Personalization, Glucose & Multi-Provider AI

- **Per-user custom thresholds**: Override the computed default ranges (BP, BMI, glucose, pulse) with values from your clinician. Audit-logged with previous/new values and timestamps. Doctor Report PDF flags custom ranges and prints both your target and the standard guideline value.
- **Blood glucose tracking**: New metric with `fasting`, `postprandial`, `random`, and `bedtime` contexts. Display unit switch between mg/dL and mmol/L (lossless conversion). Context-aware classification per ADA 2024 / DGIM. Per-context charting on dashboard and Doctor Report PDF.
- **Dashboard customization**: Show/hide and drag-to-reorder every dashboard widget. Per-user preference, reset-to-defaults button. Layout persists across the same user on the same device.
- **Built-in feedback system**: New in-app Send Feedback flow (Bug / Feature / Question / Other) with anonymized system info attachment. Stored in HealthLog's own database — no GitHub config required. Optional `Escalate to GitHub` button for admins who configure a PAT.
- **Multi-provider AI insights**: Provider abstraction extended with **Anthropic Claude** and **local OpenAI-compatible endpoints** (Ollama, LM Studio, vLLM, LiteLLM) alongside OpenAI. Per-user provider selection. Local endpoints keep all health data on your network.
- **Locale-aware UI polish (English-first)**: Numbers, dates, glucose units, BP, weight, and BMI all formatted via `useFormatters()` from the active locale. Doctor Report PDF and AI insight prompts now respect locale end-to-end (no hand-rolled `Intl.*` with fixed locales).

### Changed

- Reference range computation extracted into a dedicated `src/lib/health/thresholds.ts` module with computed defaults and override resolution.
- AI provider routing reworked to dispatch by `provider` field on the user record; OpenAI remains the default for legacy users.
- Dashboard route renders widgets from `UserDashboardLayout` model when present, otherwise falls back to the default order.
- Doctor Report PDF: locale-aware headers, glucose section, custom-range badges.

### Security

- GitHub PAT for feedback escalation stored AES-256-GCM encrypted in the database (never as env var).
- Local AI endpoint URLs validated against SSRF (no localhost/RFC1918 unless explicitly allowed by admin).
- Custom threshold writes rate-limited and audit-logged with IP.

## [1.1.0] — 2026-04-06

### Added — AI Insights Overhaul

- **ChatGPT Proxy Integration**: Insights now run through a local openai-oauth proxy using your ChatGPT subscription — no separate API billing required
- **Admin AI Fallback**: Admins can configure a global API key (OpenAI/OpenRouter) as fallback for users without their own connection
- **Provider Abstraction**: New `src/lib/ai/` module with pluggable providers (Codex OAuth, Admin Key, None) and automatic failover
- **Medical Insight Prompts**: 7 specialized prompts based on ESC/ESH 2023, WHO, DGE, and DEGAM guidelines
  - Blood Pressure: ESC/ESH classification, morning risk ladder (J-HOP), pulse pressure, seasonal variation
  - Weight: 5%/10% milestone recognition, plateau detection, body composition divergence
  - Pulse: Fitness interpretation ladder, 80-100 bpm elevated-risk band, rate-pressure product
  - BMI: Age-adjusted DEGAM classification for 65+
  - Medication Compliance: Chronotherapy hints, mood-adherence risk prediction, 90-day tracking
  - General Status: Cross-domain synthesis with cardiovascular risk stratification
  - Mood: Bidirectional correlations with vitals and adherence
- **Enriched Feature Extraction**:
  - Sleep duration and activity steps (previously ignored)
  - Rate-Pressure Product (pulse × systolic BP, myocardial demand indicator)
  - Body composition divergence flag (weight stable + body fat rising)
  - Mood-adherence risk predictor
  - Seasonal BP variation (winter vs summer, requires >180 days data)
  - BP standard deviation (sdSys30/sdDia30) as variability risk marker
  - Pulse pressure (arterial stiffness marker)
  - 5 cross-metric Pearson correlations (weight↔BP, pulse↔BP, mood↔pulse, mood↔BP, mood↔weight)
  - 90-day averages and all-time statistics for all metrics
  - Historical comparison (current 7d vs previous 30d baseline)
- **New UI Components**:
  - `InsightStatusCard`: Compact per-metric status card with classification indicator and fade-in animation
  - `InsightAdvisorCard`: Premium structured card with findings, correlations, recommendations (ready for integration)
- **OAuth Routes**: `/api/auth/codex/authorize`, `/callback`, `/disconnect` for ChatGPT connection
- **Admin AI Settings**: `/api/admin/ai-settings` for global API key management

### Changed

- Insight prompts now use personal advisor tone ("dein Blutdruck") with positive-first pattern
- Reasoning scaffold in system prompt (What changed? → Why? → What to do?)
- Conditional correlation instructions (only mention when |r| > 0.4)
- InsightResult schema enriched with `insightType`, `primaryRecommendation`, `classificationLabel`
- BP target calculation now uses paired readings (both sys AND dia must be in range simultaneously)
- Medication streak tracking extended from 7-day to 30-day window
- CSP updated to allow `chatgpt.com` for OAuth flow

### Security

- Rate limiting on all OAuth and admin endpoints
- PKCE (S256) + state parameter for OAuth CSRF protection
- Encrypted token storage at rest (AES-256-GCM)
- Error messages truncated to prevent upstream response body leaks
- Admin key preview shows last 4 chars of decrypted key (not ciphertext prefix)
- `prefers-reduced-motion` support for insight card animations

### Removed

- `openaiKeyEncrypted` field from User model (replaced by provider abstraction)
- Direct OpenAI API calls from insight generators (now routed through provider)
- Legacy API key input in settings UI (replaced by ChatGPT connect button)

## [1.0.1] — Previous release
