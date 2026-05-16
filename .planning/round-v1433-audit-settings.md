# v1.4.33 Settings UX Audit

Scope: Every route under `/settings/[section]`, every component in
`src/components/settings/`, and the German + English locale bundles. Goal
is the same one the maintainer keeps returning to: Settings should feel
like one product, not a stack of historical extractions. v1.4.32 closed
a long polish run but the Settings surface still drifts in two ways —
mechanical (one card has `p-5`, another has `p-6`; one action row uses
`flex flex-wrap`, the next uses `flex`; one button shows the IANA zone
inline, another doesn't) and editorial (the same word — "Kanal",
"Konfiguriert", "Gespeichert", "Aktiv" — shows up four times on a single
screen). The maintainer's report calls out both, and a wider read
confirms the same two patterns repeating across surfaces he did not
single out.

This document is read-only. Nothing was modified.

---

## 1. Executive Summary

Severity tally:

- **Critical**: 0
- **High**: 6
- **Medium**: 9
- **Low**: 7

Top five wins for v1.4.33 (highest ROI per minute of patch time):

1. Wrap the MoodLog action row (`Sync starten · Voll-Sync · Trennen`) —
   single-class change, kills the maintainer-reported overflow.
2. Replace the parenthesised timezone in the "Browser-Zeitzone
   übernehmen" button with an aria-only suffix — gives the toggle a
   short, single-line German label and lets the picker + button heights
   match.
3. Strip `lastSuccess`, `lastFailure`, `consecutiveFailures`,
   `disabledReason` from the Kanalzuverlässigkeit body whenever the pill
   in the badge already conveys the state. The block currently double-
   states everything the pill renders.
4. Normalise `<DateInput>` so its on-mobile height equals
   `<Input>`/`<NativeSelect>` (the native `type="date"` chrome on iOS
   Safari + Android Chrome puffs the field). Single-line CSS fix
   (`appearance-none`+ `min-h-10`).
5. Drop the in-card Telegram redundancy: today the card title is
   "Telegram-Benachrichtigungen", the description repeats
   "Telegram-…-per Telegram", and the status badge says
   "Konfiguriert · Deaktiviert" plus the chip strip says "Aktiv".
   Pick one — the pill — and remove the rest.

---

## 2. Maintainer-Reported Issues

### 2.1 HIGH — Konto: date-of-birth field is broader and taller than its siblings

- **File / line**: `src/components/ui/date-input.tsx:20-23` plus
  `src/components/settings/account-section.tsx:418-423`.
- **Current behaviour**: `<DateInput>` is a thin wrapper that returns
  `<Input type="date" lang={locale} />`. `<Input>` (`input.tsx:70`)
  applies `h-10 w-full`. On mobile Safari + Android Chrome the native
  date picker chrome inside `type="date"` adds intrinsic padding that
  Tailwind's `h-10` cannot shrink — the calendar glyph + iOS minimum
  font-size enforce a taller box than the sibling `<Input>` and
  `<NativeSelect>` (the gender + height + language fields beside it).
  Width drift is the same root cause: iOS gives `type="date"` a wider
  intrinsic min-width than text fields.
- **Proposed fix**: in `date-input.tsx`, opt into appearance-none and
  pin the height/box-sizing explicitly:
  - `className: "appearance-none min-h-10 h-10 [&::-webkit-date-and-time-value]:min-h-[1.5em]"`.
  - Add the same to `<DateTimeInput>` for parity. The two are paired
    siblings and the bug repeats on the datetime field at
    `/measurements/new`.
- **Verify**: take a mobile screenshot of `/settings/account` — DOB,
  Gender, Größe, Sprache cells should be one rhythm in two paired rows.

### 2.2 HIGH — Settings → Zeitzone: button label too long, row heights don't match

- **File / line**: `src/components/settings/timezone-picker.tsx:118-120`,
  `messages/de.json:1642`, `messages/en.json:1642`.
- **Current copy (DE)**: `"Browser-Zeitzone übernehmen ({tz})"` renders
  on a 393 CSS px viewport as "Browser-Zeitzone übernehmen
  (Europe/Berlin)". With a `size="sm"` button this overflows two lines,
  forcing the button taller than the adjacent select.
- **Current copy (EN)**: "Use browser timezone ({tz})" — same issue.
- **Layout**: the row is `flex flex-col gap-3 sm:flex-row sm:items-center`,
  so on `<sm` the button is its own row and height mismatch matters less,
  but on `sm+` (where the maintainer also reports it) the button sits next
  to the IANA select and the two `h-10` controls drift apart whenever the
  button wraps to two lines.
- **Proposed fix (preferred)**: drop the `(${tz})` segment from the
  visible label — IANA is already shown in the select beside the button.
  Keep `tz` in the `aria-label` so screen-reader users still hear the
  exact zone the click will apply. The button is identity ("Browser-
  Zeitzone übernehmen"); the select is value ("Europe/Berlin").
- **Alternative**: if the maintainer wants the zone visible, render it
  on a dedicated muted line below the picker block ("Browser meldet
  Europe/Berlin") so the action button stays single-line.
- **Locale fix**: rename the key
  `settings.timezoneDetect` → `settings.timezoneDetect.label`
  ("Browser-Zeitzone übernehmen") + `settings.timezoneDetect.aria`
  ("Browser-Zeitzone Europe/Berlin übernehmen") to keep the
  accessibility tree intact.

### 2.3 HIGH — Settings → Integrations: viewport sometimes broken, odd scroll

- **File / line**:
  `src/components/settings/integrations-section.tsx:780-805` (Mood Log
  webhook-secret input + copy button), `:821-891` (Mood Log action row).
- **Current behaviour**: two `flex gap-2` rows (no `flex-wrap`) inside
  the Mood Log card.
  - Line 780: `<Input value={status.webhookSecret} readOnly>` + Copy
    button. The webhook secret is a long hex string; the input doesn't
    truncate; Mobile Safari + Chrome let the input push past the card
    boundary, triggering a body horizontal scroll.
  - Line 821: `Sync starten | Voll-Sync | Trennen` — three `size="sm"`
    buttons (~120 px each) + two 8 px gaps = ~376 px. A 393 px viewport
    minus the 24 px `p-6` card padding leaves 345 px. The row overflows
    by ~30 px. **This is the "Trennen overflow" the maintainer reported
    in 2.4 below — same root cause.**
- **Proposed fix**:
  - Line 780: change to
    `<div className="flex flex-col gap-2 sm:flex-row sm:gap-2">` and
    add `font-mono text-xs break-all` to the input. Or render the
    secret as a `<code>` block instead of an editable input — it is
    read-only anyway and `Input` is the wrong primitive for an
    immutable token.
  - Line 821: change to `flex flex-wrap items-start gap-2` and adopt
    the `[&>*]:min-w-[10rem] sm:[&>*]:min-w-0` pattern already in use
    one card up at line 482. That matches the Withings card and clears
    the overflow without making the desktop layout look different.

### 2.4 HIGH — MoodLog: "Trennen" button overflows the tile on mobile

Confirmed as the line-821 row above. The single fix in 2.3 closes both
findings.

### 2.5 MEDIUM — Settings tiles overall feel inconsistent

Pattern audit of the 11 settings sections shows the following drifts —
none of them critical individually, all of them visible when comparing
two cards side-by-side:

| Card | Padding | Header pattern | Status surface |
|---|---|---|---|
| AccountSection / Profile | `p-6` | `mb-4 flex items-center gap-2` | none |
| AccountSection / Password | `p-6` | `flex flex-col gap-3 sm:flex-row sm:justify-between` | none |
| AccountSection / Tour | `p-6` | `flex flex-col gap-3 sm:flex-row sm:justify-between` | none |
| IntegrationsSection / Withings | `p-6` | `flex flex-wrap items-start justify-between` | `<IntegrationStatusPill>` |
| IntegrationsSection / Mood Log | `p-6` | same | same |
| NotificationsSection / Telegram | `p-6` | `flex flex-wrap items-start justify-between` | two `<Badge>` (configured + enabled), NOT the pill |
| NotificationsSection / ntfy | `p-6` | same | two `<Badge>` (configured + enabled), NOT the pill |
| NotificationsSection / WebPush | `p-6` | same | two `<Badge>` (configured + active), NOT the pill |
| NotificationsSection / Kanalzuverlässigkeit | `p-6` | `mb-4` header + nested `<dl>` per row | embedded badge per row |
| Export | `p-5` | `flex items-start justify-between` + format chip | none |
| Sources | `p-6` | `flex flex-col gap-2 sm:flex-row sm:justify-between` | none |
| API tokens / endpoints | `p-6` | `flex flex-wrap items-start justify-between` | two `<Badge>` (configured + last-used) |
| Advanced / Research | `p-6` | `mb-4 flex items-center gap-2` | inline switch |

Observations:

- **Export uses `p-5`** while every other card uses `p-6`. Single-token
  drift. Promote Export to `p-6` so the grid rhythm matches the rest of
  Settings; Export's card-as-grid-tile layout doesn't justify the
  smaller pad.
- **Status surface drift**: Integrations cards moved to a single
  `<IntegrationStatusPill>` in v1.4.19. Notifications cards
  (Telegram/ntfy/WebPush) still ship the legacy "Konfiguriert" +
  "Aktiviert" badge pair. The two surfaces should converge — either
  promote the pill to Notifications or demote Integrations back to two
  badges. Recommendation: extend the pill, because the pill carries
  relative-time ("Verbunden · vor 12 min") and the Notifications cards
  could finally show "last successful send" inline without re-painting
  the redundant `<dl>` underneath (see 2.6).
- **Header pattern drift**: 5 different `flex-*` combinations for what
  should be the same card header (icon + title left, status surface
  right, description below). Recommendation: extract a tiny
  `<SettingsCardHeader>` primitive that owns the contract — same icon
  pad, same title size, same status slot. The export-section already
  has the right idea in `<ExportCardShell>` (`export-section.tsx:112`).

### 2.6 HIGH — Settings → Kanalzuverlässigkeit: copy is redundant

- **File / line**: `src/components/settings/notification-status-card.tsx:141-170` plus
  `messages/de.json:1510-1513` ("Zustellung pro Kanal und die
  Live-Übersicht der Kanalzuverlässigkeit für jeden konfigurierten Kanal.")
  and `messages/de.json:1950-1952`
  (`title: "Kanalzuverlässigkeit"`, `description: "Live-Status jedes
  Benachrichtigungskanals — …"`).
- **The redundancy is layered**:
  1. The section header at `/settings/notifications` says
     "Zustellung pro Kanal und die Live-Übersicht der
     Kanalzuverlässigkeit für jeden konfigurierten Kanal." — the word
     "Kanal" appears 3× in one sentence.
  2. The first card on the same page is titled "Kanalzuverlässigkeit"
     with description "Live-Status jedes Benachrichtigungskanals —
     …". Both say the same thing.
  3. Inside each channel row, the status pill says "Aktiv" *and* the
     `<dl>` lists "Letzter erfolgreicher Versand: 14.05.2026 09:42",
     "Letzter Fehler: …", "Fehler in Folge: …", "Grund: …". When a
     channel is healthy (the common case) only the last-success matters
     — the others are empty branches the user has to read past.
- **Proposed fix**:
  1. Tighten the section description to one short sentence:
     `"Live-Übersicht aller konfigurierten Kanäle."` Mirror in EN:
     `"Live overview of every configured channel."`
  2. Rename the first card from "Kanalzuverlässigkeit" → "Zustellstatus"
     so the page header + card don't both anchor on "Kanal".
  3. Compress the per-row body when state is `active`: show pill +
     relative-time only (`"Aktiv · vor 12 min"`) — drop the full
     datetime line. Keep the `<dl>` for `auto_disabled`,
     `sending_paused`, `manually_disabled` since those states need the
     "why".
- **Locale changes**: drop the long
  `settings.notificationStatus.description` (line 1952) — the section
  description above already sets context.

### 2.7 MEDIUM — Settings → Telegram-Nachrichten: same redundancy pattern

- **File / line**: `src/components/settings/telegram-card.tsx:107-134`,
  `messages/de.json:1677-1678`.
- **Current rendering on the page**: the card header reads "Telegram-
  Benachrichtigungen" (`settings.telegram`) + the description reads
  "Erhalte Erinnerungen bei vergessenen Medikamenten-Einnahmen per
  Telegram." ("Telegram" twice in the same card header).
- **In parallel** the top-right of the card paints either
  `Aktiv` (single badge) or `Konfiguriert · Deaktiviert` (pair badge).
  That's the third "what is the state of this channel" surface for the
  same fact: the Kanalzuverlässigkeit card above already showed it, the
  card header now repeats it.
- **Proposed fix**:
  1. Rename the card title to plain "Telegram" — the section is
     "Benachrichtigungen", so saying "Benachrichtigungen" again is
     wasted shelf space.
  2. Shorten the description: "Medikamenten-Erinnerungen per Bot."
  3. If 2.6 lands and the Kanalzuverlässigkeit pill becomes the single
     status surface, **delete the in-card `<Badge>` pair entirely**
     (`telegram-card.tsx:114-131`). The pill in the
     Kanalzuverlässigkeit row above already says "Aktiv · vor X min".
- **Apply the same fix** to `ntfy-card.tsx:109-120` and
  `web-push-card.tsx:165-176` — exact same redundancy.

---

## 3. Additional Findings

### 3.1 HIGH — Settings has two competing "status" vocabularies

The codebase mixes two grammars for "this thing is on":

- `common.active` ("Aktiv"), `common.enabled` ("Aktiviert"),
  `common.disabled` ("Deaktiviert") at `messages/de.json:16-19`.
- `settings.configured` ("Konfiguriert") at `messages/de.json:1819`,
  `webPushActive` ("Aktiv") at `:1707`, plus integration pill states
  `Verbunden / Fehler / Nicht verbunden` at `:1845-1847`.

The Telegram card renders both ("Konfiguriert · Deaktiviert"), which is
the German equivalent of saying "ready to be turned on, currently turned
off". Pick one verb, drop the other. The pill already encodes both bits
(green + "Verbunden · vor X min" vs grey outline + "Nicht verbunden")
so the binary "Konfiguriert / Aktiv" can be retired.

### 3.2 MEDIUM — Settings shell mobile chip strip lists 11 items

`settings-shell.tsx:152-182` renders an 11-item horizontal scroll chip
strip on every settings page. On a 393 px viewport the right four chips
are below the fold; users have to swipe horizontally. The Insights tab
strip solved the same shape with `data-[active]` pinning + bulk-edit
hidden behind a "More" menu. Not urgent for v1.4.33 but worth a backlog
ticket — and a candidate for a "Frequently used" cluster (Account,
Integrations, Notifications, AI) plus an overflow menu for the rest.

### 3.3 MEDIUM — Account / Passkey list breaks at exactly `md` (768px)

`account-section.tsx:736-895`: passkey list renders a desktop table at
`md+` and a mobile card list at `<md`. The breakpoint is `md` (768 px).
Tablets (iPad mini portrait = 768 px) land right at the inflection and
flip-flop between layouts on rotation. Recommendation: bump the
breakpoint to `lg` for this surface specifically — passkey tables need
the wide column to read; the card list works fine on iPad portrait.

### 3.4 MEDIUM — Save buttons are inconsistently placed across forms

- AccountSection profile form: `flex justify-end` (right-aligned).
- Withings credentials form: `flex justify-end` + `w-full sm:w-auto`
  (right-aligned desktop, full-width mobile).
- Telegram form: `flex justify-end gap-2` (two buttons right-aligned).
- ntfy form: `flex justify-end gap-2`.
- Mood Log form: `flex flex-wrap items-start gap-2` (LEFT-aligned).
- API token create form: button beside input, no submit footer.

The eye sees "Speichern" in five different positions. Recommendation:
all primary save buttons right-aligned, full-width on `<sm`, secondary
"Test" buttons immediately left of save. Lift the rule into the same
`<SettingsCardHeader>` companion primitive so new sections inherit it.

### 3.5 MEDIUM — Withings + Mood Log credential forms read identically but use different label structures

- Withings: `space-y-1.5` between label and input.
- Mood Log: bare `<div>` with no label-gap rule (relies on default
  layout). Visible drift on Chromium where Mood Log's labels sit
  half a line closer to their inputs.

Fix: standardise on `space-y-1.5` everywhere the surface is a labelled
credential form.

### 3.6 LOW — Notifications page has no anchor / quick-jump for sub-cards

`/settings/notifications` stacks Kanalzuverlässigkeit → Telegram →
ntfy → Web Push vertically. The page already paints
`id="telegram" scroll-mt-28` anchors (`notifications-section.tsx:62-75`)
so deep-links work, but there's no in-page TOC. On a Pixel-5 the page
is 4 screen-heights tall. Add an inline chip strip under the H1
("Zustellstatus · Telegram · ntfy · Web Push") that hash-anchors.

### 3.7 LOW — Integrations page uses two different "card divider" treatments

`integrations-section.tsx:354-357` and `:713-716` both render an
`<hr data-testid="integration-card-divider" className="border-border/60 mt-4">`.
That's consistent — but inside each card, the divider lives *between*
the description and the body, while inside Account/Password/Tour cards
there is no divider at all. The visual rhythm reads as
"Integrations is heavier than Account, why?". Either drop the dividers
(cleaner) or add equivalent ones to Account.

### 3.8 LOW — API endpoint card title hard-codes plural even with one endpoint

`api-section.tsx:81`: title is "API-Endpoints" but the endpoints array
has exactly one entry today (POST `/api/ingest/medication`). Either
ship more endpoints or rename to "API-Endpoint". Cosmetic, but the
maintainer reads "Endpoints" and expects a list.

### 3.9 LOW — Mood Log "Voll-Sync" trigger uses same copy as confirm action

`integrations-section.tsx:837` (trigger) and `:852` (dialog confirm)
both render `{t("settings.moodLogFullSync")}` = "Voll-Sync". The
maintainer's pattern across the codebase is verb-noun for triggers
("Sync starten") and a more explicit verb for confirms ("Vollständig
synchronisieren"). Withings already does it right at lines 504 + 519
(`withingsFullSync` → `withingsSynchronize`). Add
`settings.moodLogFullSyncConfirm` = "Vollständig synchronisieren"
and wire it into the dialog action.

### 3.10 LOW — `dl/dt/dn` markup inside Kanalzuverlässigkeit is semantically right but visually heavy

`notification-status-card.tsx:209-263`: each row paints up to five
`<div><dt>:</dt> <dd></dd></div>` rows. The colon is fixed punctuation;
on muted-foreground 11px the bullets read as a wall of text. If 2.6
above lands the volume goes down on its own; otherwise consider
flattening the active-state block to one line
("Aktiv · vor 12 min — keine Fehler") and reserving the `<dl>` for the
unhealthy states.

### 3.11 LOW — `<Switch>` + `<Label>` pairs use four different layouts

- Telegram: `flex items-center gap-3` (label after switch).
- ntfy: `flex items-center justify-between` (label before switch).
- Advanced (Research): inline switch in card header.
- Settings → Web Push: button instead of switch.

Pick one. The de-facto winner is "label left, switch right, justified" —
matches every toggle on `/settings/dashboard`.

---

## 4. Locale String Redundancy

### 4.1 Duplicate keys for the same surface

| Concept | DE key A | DE key B | Recommended single key |
|---|---|---|---|
| "Gespeichert" | `common.saved` (line 12) | `settings.saved` (line 1888) | `common.saved` |
| "Konfiguriert" | `settings.configured` (1819) | `admin.…configured` (2068) | namespace-scoped is fine, but de-dup the surface that renders both |
| "Aktiv" | `common.active` (16) | `webPushActive` (1707), `tokenActive` (1862), `admin.…active` (2879) | adopt `common.active` everywhere except where status-specific copy matters |
| "Token-Name" | `tokenNamePlaceholder` (1856) | implicit | nothing to fix; flagged because it's the only token field without a top-level label key |

### 4.2 Verbose section descriptions to compress

- `settings.sections.notifications.description` (1512): 13 words, 3 ×
  "Kanal". Recommendation: "Live-Übersicht aller konfigurierten Kanäle."
- `settings.notificationStatus.description` (1952): 21 words. Tucks the
  Auto-disabled definition inside the surface description; move that
  definition to the badge tooltip instead.
- `settings.telegramDescription` (1678): "Telegram" twice. Recommend
  "Medikamenten-Erinnerungen per Bot."
- `settings.moodLogDescription` (1891): "moodLog" twice — "Stimmungs-
  daten aus moodLog importieren". Recommend "Stimmungsdaten aus dem
  moodLog-Dienst übernehmen." (or simpler: "Stimmungseinträge
  übernehmen.").

### 4.3 Inconsistent disconnect / trennen wording

- `settings.withingsDisconnect` (line 1827): "Trennen"
- `settings.moodLogDisconnect` (1902): "Trennen"
- `settings.codexDisconnected` etc.: "getrennt"
- Notifications has no "trennen" — uses Switch toggling instead.

`common.disconnect` would consolidate the trigger copy; the dialog
title strings ("Withings trennen?", "moodLog trennen?") stay
integration-specific.

### 4.4 EN parity holds

`messages/en.json` mirrors the DE bundle 1:1 on every key inspected in
this audit. Any redundancy fix needs to land in both files in the same
commit. The i18n parity test
(`src/components/settings/__tests__/sections-i18n-parity.test.ts`)
should catch any one-side drop.

---

## 5. Punch List (ordered by severity)

### High

1. **DOB field height/width** — `src/components/ui/date-input.tsx`, scope
   = single component change. Effect: every `<DateInput>` callsite
   (settings, measurements/new, admin user editor).
2. **Timezone button label** — `messages/{de,en}.json` key restructure
   + `src/components/settings/timezone-picker.tsx:118-121`.
3. **MoodLog action row + webhook input overflow** —
   `src/components/settings/integrations-section.tsx:780-805` and
   `:821`.
4. **Kanalzuverlässigkeit redundancy** —
   `src/components/settings/notification-status-card.tsx` rendering of
   active-state rows + `messages/{de,en}.json:1510-1513,1950-1952`.
5. **Telegram card redundancy** —
   `src/components/settings/telegram-card.tsx:107-134`,
   `messages/{de,en}.json:1677-1678`, parity in `ntfy-card.tsx` and
   `web-push-card.tsx`.
6. **Status vocabulary unification** — locale only; refactor
   `Konfiguriert · Deaktiviert` → single pill across Telegram, ntfy,
   Web Push.

### Medium

7. **Tile padding parity (Export `p-5` → `p-6`)** —
   `src/components/settings/export-section.tsx:125`.
8. **Header pattern primitive** — extract `<SettingsCardHeader>` into
   `src/components/settings/_card-header.tsx`; collapse 5 variants in
   `integrations-section.tsx`, `notification-status-card.tsx`,
   `telegram-card.tsx`, `ntfy-card.tsx`, `web-push-card.tsx`,
   `account-section.tsx`, `api-section.tsx`.
9. **Save-button placement contract** — formalise right-aligned
   primary + secondary order; fix Mood Log left-alignment outlier at
   `integrations-section.tsx:756`.
10. **Account passkey breakpoint** — `account-section.tsx:736` flip
    `md:` → `lg:` for the table-vs-cards switch.
11. **Settings shell chip strip overflow** —
    `src/components/settings/settings-shell.tsx:152-182`; cluster +
    overflow menu, not in v1.4.33 scope necessarily.
12. **Credential form label spacing** — `space-y-1.5` everywhere in
    Withings + Mood Log + Telegram + ntfy forms.
13. **Native select / input height parity** — re-verify post-DOB-fix
    that every row on `/settings/account` aligns at exactly 40 px.
14. **Section description compression** — 4 strings flagged in 4.2.
15. **Notification anchor strip** — small in-page TOC on
    `/settings/notifications`.

### Low

16. **Integrations card dividers** — drop or apply consistently across
    the whole settings surface.
17. **API endpoint singular/plural** — title + i18n key.
18. **Mood Log Voll-Sync dialog confirm copy** — add
    `moodLogFullSyncConfirm` in locale + wire at line 852.
19. **Kanalzuverlässigkeit `<dl>` flattening** — secondary to (4).
20. **Switch + label layout drift** — pick one pattern.
21. **`common.disconnect` consolidation** — locale key.
22. **EN parity audit** — gate via the existing parity test.

---

## Closing Note

The maintainer's read — "feels not fully thought-through" — is accurate
and the diagnosis is convergence drift across an 11-section surface
that was historically extracted card-by-card. Three structural moves
unlock most of the polish in one round:

1. One `<SettingsCardHeader>` primitive that every card consumes,
   carrying the icon, title, optional pill slot, and description with a
   fixed pad rhythm.
2. One status surface — the `<IntegrationStatusPill>` already used by
   Integrations — promoted to Notifications so Telegram/ntfy/Web Push
   stop double-stating "Konfiguriert · Aktiviert" alongside the
   Kanalzuverlässigkeit pill.
3. One copy pass that drops repeated nouns ("Kanal" ×3,
   "Telegram" ×2, "moodLog" ×2) and consolidates the
   "Aktiv/Konfiguriert/Verbunden/Aktiviert" thicket into one vocabulary.

Everything in §3 falls out for free once those three land.
