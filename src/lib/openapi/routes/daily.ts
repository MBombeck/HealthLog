/**
 * OpenAPI route module — the unified daily digest (P3).
 *
 * GET /api/daily/digest returns the `DailyDigest` DTO the Today surface, the
 * daily push, and a future iOS widget all consume. It is a pure read of
 * already-cached data (nightly briefing lift + dashboard-snapshot ingredients
 * + two light deterministic reads) — no provider call, no warm-on-mount. No
 * module or AI gate; its AI parts follow their capabilities. Part of the
 * OpenAPI route table; aggregated in `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { ARRIVAL_KINDS } from "@/lib/arrivals/types";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { DAILY_ASK_KINDS, DAILY_ASK_TIERS } from "@/lib/daily/asks";
import {
  MAX_TODAY_FACTS,
  MAX_TODAY_FACTS_NARROW,
  TODAY_FACT_KINDS,
  TODAY_LEAD_SOURCES,
} from "@/lib/daily/today-overview";
import {
  MAX_CARD_LINES,
  MORNING_CARD_KINDS,
  MORNING_CARD_TITLE_KEYS,
  MORNING_LEAD_KEYS,
} from "@/lib/daily/morning";
import { dismissPriorityItemSchema } from "@/lib/validations/daily";
import { dataEnvelope, recordRefusal, stdResponses } from "./shared";
import {
  HEALTH_SCORE_BAND_DESCRIPTION,
  HEALTH_SCORE_NUMBER_BAND_DESCRIPTION,
  healthScoreBasis,
} from "./insights/schemas";
import { aiCapabilityState } from "./profile";

const priorityItemSchema = z
  .object({
    kind: z
      .enum([...PRIORITY_ITEM_KINDS])
      .describe(
        "Closed rail-item kind. `sync_issue` covers a connection that needs a reconnect or a resume (action intent `sync.reconnect`) and, since 1.50, a source that has gone quiet by the SYNC_STALLED rule (one line in `title`, no `body`, action intent `sync.reconnect` with labelKey `daily.action.openSource` and href `/settings/integrations#<source>`). Both lines share the intent on purpose: it is the token every shipped app routes to the integrations screen, so an older build that does not know the label key still gets a working button under its generic label. Tell the two apart by `status` (`warning` for a reconnect, `info` for a quiet source) or by `labelKey`, never by the intent.",
      ),
    itemKey: z
      .string()
      .optional()
      .describe(
        "Stable identity of the row, namespaced `<kind>:...`. Since v1.49.1 every row carries one (a dose row `dose_window:<medicationId>:<dueAt>`, so two dose rows that read alike stay apart); key rows on it, never on kind and title. Only the observational kinds (milestone / ecg_new_recording / tension_window / same_time_baseline) can be dismissed with it; offer dismiss by kind, not by the key's presence. Optional in the schema because rows from a release before v1.49.1 lack it on the actionable kinds.",
      ),
    title: z.string().describe("Localised headline (resolved server-side)."),
    body: z
      .string()
      .optional()
      .describe("Grounded one-liner, rendered as plain text."),
    status: z
      .enum(["success", "warning", "info", "destructive"])
      .optional()
      .describe("Semantic status wash — meaning, not decoration."),
    actions: z
      .array(
        z.object({
          labelKey: z.string().describe("i18n key, resolved client-side."),
          intent: z.string().describe("Stable action token."),
          href: z.string().optional().describe("Deep-link when navigational."),
        }),
      )
      .max(3)
      .describe("1–3 one-tap actions."),
    moduleKey: z
      .string()
      .optional()
      .describe("Provenance of the gate that admitted the item."),
  })
  .meta({
    id: "DailyPriorityItem",
    description:
      "One 'worth a look' rail item. The single model every daily-value consumer reads; the start page renders the rows `asks` selects.",
  });

const dailyAskSchema = z
  .object({
    kind: z
      .enum([...DAILY_ASK_KINDS])
      .describe(
        "What is asked. `dose_window`, `coach_checkin`, `preventive_care`, `upcoming_visit` and `sync_issue` (a reconnect only, never a quiet source) are the rail's own kinds; `emergency_wallet` offers the reader's emergency card for Apple Wallet once (`itemKey` `emergency_wallet:offer`, follows the `feature_offer` switch, feature `daily.ask-emergency-wallet`); `push_relay` and `server_setup` are the admin question the admin start page asks (only on a browser session on the admin's own record, never on a Bearer request).",
      ),
    tier: z
      .enum([...DAILY_ASK_TIERS])
      .describe(
        "Why it is asked, in the order asks are ranked: `safety` (a dose past its on-time window), `decision` (a question only the reader can answer: the admin question, a coach check-in), `due` (a dose takeable now, check-ups due now, a visit today or tomorrow, a source whose sign-in expired or was refused and that has delivered nothing for a day, and last a feature offer such as `emergency_wallet`).",
      ),
    itemKey: z
      .string()
      .describe(
        "Stable identity, namespaced `<kind>:...`; the rail item's own key for the rail kinds.",
      ),
    title: z
      .string()
      .describe(
        "The thing asked about, one line: a medication's name, a check-up, who a visit is with, a source, the coach plan's text, or the admin question (`Push relay?`, `This server`). Localised on the server; what the server words itself is at most 14 characters. A name the person typed can be longer; a client cuts only the title, with an ellipsis, and keeps the full text as its accessible name.",
      ),
    body: z
      .string()
      .nullable()
      .describe(
        "The title's state, one short line, never a sentence: `Overdue 8:00 AM` (a dose past its time, `tier: safety`), `Due 8:00 AM`, `Check-up due`, `Visit today` / `Visit tomorrow`, `Disconnected` (a sign-in to renew), `Check-in due`, `Not set up`, `Encrypted` (the relay question). Times are on the reader's own clock and hour cycle; a time that would break the budget is left out (`Overdue`). At most 16 characters in every language, so it fits one line beside the icon and the button pair on a 360 px phone; a client shows it on one line and never wraps or cuts it. Null only from an older server.",
      ),
    subject: z
      .string()
      .nullable()
      .describe(
        "The name of what is asked about (a dose's medication), for an action's confirmation; null otherwise.",
      ),
    actions: z
      .array(
        z.object({
          labelKey: z.string().describe("i18n key, resolved client-side."),
          intent: z
            .string()
            .describe(
              "Stable action token. Beside the rail's tokens: `dose.snooze:<medicationId>` (the medication's own snooze, `POST /api/medications/intake` with status `snoozed`), `relay.yes` / `relay.no` (the relay question), `admin.setup.open` (with `href`), `ask.later:<dismissKey>` (sets the ask aside until the next local day: `POST /api/daily/digest/dismiss` with that key, `ask-later:<YYYY-MM-DD>:<itemKey>`; for `emergency_wallet` the key is `emergency_wallet:offer`, which names no day and sets the offer aside for good), `emergency_wallet.add` (with `href` the card's Wallet section: the web opens the card's Wallet section, the app its own add flow). Labels are the short verbs under `daily.action.*`. A consent row (`push_relay`) carries exactly No and Yes, never a later.",
            ),
          href: z.string().optional().describe("Deep-link when navigational."),
        }),
      )
      .length(2)
      .describe("Exactly two actions; the first is the primary one."),
    learnMore: z
      .object({
        labelKey: z.string().describe("i18n key, resolved client-side."),
        href: z.string().describe("Documentation page."),
      })
      .nullable()
      .describe(
        "A link set at the end of `body`, or null. Null on every ask since the compact layout (`daily.asks-compact`): the line has no room for it.",
      ),
  })
  .meta({
    id: "DailyAsk",
    description:
      "One row of the start page's ask card. The policy is the server's (`resolveDailyAsks`): only what needs an action today and is time-relevant, never an observation; a running snooze, a dismissed notice and Rest mode (check-ups, coach check-in) hold it back; ranked safety, then decision, then due, in the digest's order inside a tier.",
  });

const todayFactSchema = z
  .object({
    kind: z.enum([...TODAY_FACT_KINDS]).describe("Closed fact kind."),
    label: z.string().describe("Localised label (resolved server-side)."),
    value: z.string().describe("Localised value (resolved server-side)."),
    href: z.string().describe("The page the fact belongs to."),
    moduleKey: z
      .string()
      .optional()
      .describe("The module that admitted the fact; absent for core data."),
  })
  .meta({
    id: "DailyTodayFact",
    description:
      "One statement about the day on the Today overview. A fact never asks the reader to do anything; the rail is the only place that does.",
  });

export const dailyDigestResponse = z
  .object({
    generatedAt: z.string().describe("ISO-8601 instant the digest was read."),
    phase: z
      .enum(["provisional", "final"])
      .describe("Freshness lifecycle — 'final' once last night's sleep is in."),
    sleepPending: z
      .boolean()
      .describe("Sleep tracked but last night not yet recorded."),
    score: z
      .object({
        value: z.number(),
        band: z.string().describe(HEALTH_SCORE_BAND_DESCRIPTION),
        numberBand: z
          .string()
          .optional()
          .describe(HEALTH_SCORE_NUMBER_BAND_DESCRIPTION),
        delta: z.number().nullable(),
        configured: z
          .boolean()
          .optional()
          .describe(
            "True when the account's own recipe narrows the score's composition below what its defaults would resolve to today. Resolved on the server and carried straight from the dashboard snapshot; the configuration itself never rides this wire. Optional so older cached digests without the field stay valid.",
          ),
        // The score's identity fields have ridden this wire since the
        // digest first carried a score, but the object is
        // `additionalProperties: false` and never declared them — a
        // generated strict decoder would have rejected the real payload.
        // Declared here rather than left standing beside a new field
        // that documents itself correctly.
        deltaReason: z
          .string()
          .nullable()
          .optional()
          .describe("Why a delta was suppressed; null when it was not."),
        scoreVersion: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Algorithm version that produced the value."),
        composition: z
          .array(z.string())
          .optional()
          .describe("Registry-ordered pillar ids the value was composed of."),
        scoreBasis: healthScoreBasis
          .optional()
          .describe(
            "What the value rests on. Since v1.38 a score is produced from one or two areas of health as well as three, so this is what distinguishes a narrow score from a broad one. Optional so older cached digests without the field stay valid.",
          ),
        steadyWeeks: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe(
            "Whole weeks the score has held where it is (same band, within two points, computed the same way), read off the stored daily scores. Null when it has not held for two weeks, when the stored record does not reach today, or when the score on screen differs from the newest stored day in value, band, algorithm version or composition. Shown in place of a delta, never beside one.",
          ),
        steadyAtLeast: z
          .boolean()
          .optional()
          .describe(
            'True when the run reaches back past everything the read covered (120 days): `steadyWeeks` is then a lower bound, said as "at least", and the run\'s start is unknown. Absent on older cached digests.',
          ),
        bandSetter: z
          .string()
          .nullable()
          .optional()
          .describe(
            "The counted pillar whose band is worse than the number's own (`numberBand`), null when none is. Exactly then `band` is worse than `numberBand`.",
          ),
        bandSetterBand: z
          .enum(["yellow", "red"])
          .nullable()
          .optional()
          .describe(
            "That pillar's own band. A sentence about the day uses the worse of this and `numberBand`, which is `band`.",
          ),
        bandSetterLine: z
          .string()
          .nullable()
          .optional()
          .describe(
            "The line naming that pillar, worded in the response language. Shown under the score wherever the score is shown; null when there is no setter.",
          ),
        shortLabel: z
          .string()
          .optional()
          .describe(
            'The score\'s short name for a tile, from the score registry and worded in the response language ("Gesundheit", "Health"). Render it as is. Absent on older cached digests. Feature key `daily.scores-short-labels`.',
          ),
      })
      .nullable()
      .describe(
        "Health score + band + week-over-week delta, plus whether the account authored the composition and how broad the set behind it is; null when none.",
      ),
    topSignal: z
      .object({
        sourceMetric: z.string(),
        tone: z.enum(["good", "watch", "info"]),
        headline: z.string(),
        nudge: z.string(),
        delta: z.string().nullable(),
      })
      .nullable()
      .describe(
        "Clinical-priority top signal, lifted from the cached briefing. Null while the `briefing` capability is unavailable.",
      ),
    briefingLead: z
      .string()
      .nullable()
      .describe(
        "The first sentence of the cached briefing paragraph that says something: a greeting or a sentence that only repeats the score is skipped. Null while the `briefing` capability is unavailable or when no sentence qualifies; `line` then falls to its deterministic floor.",
      ),
    lead: z
      .object({
        text: z.string(),
        source: z
          .enum([...TODAY_LEAD_SOURCES])
          .describe(
            "`reaction` and `briefing` are cached model text; `signal` is the deterministic sentence about the day's strongest signal.",
          ),
        language: z
          .string()
          .nullable()
          .describe(
            "v1.48.0 — the language `text` is in (a shipped locale code such as `en` or `pt-BR`), or null when the stored text predates the tag. A `reaction` lead is never in another language than `languages.response`.",
          ),
      })
      .nullable()
      .describe(
        "The Today hero's lead line, resolved: the reaction line or a briefing sentence while their capabilities are available, otherwise a deterministic sentence about the day's strongest signal (a vital outside its personal range, an unusual night, vitals in range, last night). Null when there is nothing to say. When the deterministic sentence is built from a fact, that fact is left out of `today`. Additive since v1.40.",
      ),
    signalLine: z
      .object({
        headline: z
          .string()
          .nullable()
          .describe(
            "The top signal's headline, or null when the lead already talks about its metric.",
          ),
        delta: z
          .string()
          .nullable()
          .describe("The top signal's delta, when it has one."),
        language: z
          .string()
          .nullable()
          .describe(
            "v1.48.0 — the briefing's language, as `languages.briefing`.",
          ),
      })
      .nullable()
      .describe(
        "The muted line under an AI lead, decided on the server so every client shows the same one: the top signal minus what the lead already says. Null under a deterministic lead, without a top signal, or when the lead already says everything the signal would. Additive since v1.40.3.",
      ),
    today: z
      .array(todayFactSchema)
      .max(MAX_TODAY_FACTS)
      .describe(
        `The Today overview: up to ${MAX_TODAY_FACTS} statements about the day in priority order (Rest Mode, medications taken today counted against every dose scheduled for the local day (since v1.48.2; v1.48.0 and v1.48.1 counted only the doses due so far), or, before the first is due with nothing taken, when the next dose is (since v1.48.0), an appointment today or tomorrow that is not already on the rail, last night's sleep, vitals against their personal range, cycle day), never padded. A fact about a switched-off module is absent. A narrow surface shows the first ${MAX_TODAY_FACTS_NARROW}. Additive since v1.40.`,
      ),
    restMode: z
      .object({
        day: z
          .number()
          .int()
          .positive()
          .describe("1-based day of the episode on the reader's calendar."),
      })
      .nullable()
      .describe(
        "Rest Mode: present while an illness episode that is not chronic ongoing (acute, recurring or flare) is active and the illness module is on, else null. A chronic ongoing condition alone never sets it; `day` counts from the earliest onset among the episodes that do. Additive since v1.40.",
      ),
    line: z
      .string()
      .describe(
        "Push / lock-screen line: cached-AI lead with a deterministic floor. Carries no number (no reading, dose or score), since it is shown on a locked phone; the in-app `lead` keeps its figures.",
      ),
    worthALook: z
      .array(priorityItemSchema)
      .describe("Bounded 0–3 rail items, never padded."),
    asks: z
      .array(dailyAskSchema)
      .describe(
        `What the start page asks today, in order, never padded. The rules keep it short and empty on most days, and then no ask card is shown. Render every row as delivered; do not re-rank, fold, drop or add rows. Every row has exactly two actions, the primary first. Additive since 1.50.`,
      ),
    justIn: z
      .object({
        kind: z
          .enum([...ARRIVAL_KINDS])
          .describe("Closed arrival kind that landed."),
        at: z
          .string()
          .describe(
            "ISO-8601 instant of the newest sample. NEVER pre-formatted server-side — the client formats it in its own locale and timezone.",
          ),
      })
      .nullable()
      .describe(
        "The day's newest data arrival while it is still news (under three hours old), else null. Additive since v1.31.0.",
      ),
    reactionLine: z
      .string()
      .nullable()
      .describe(
        "One-sentence generated reaction to that arrival, standing for the rest of the local day. Null whenever no line was generated (no provider, no consent, budget exhausted, or generation failed), and whenever the `reactionLines` capability is unavailable, however recent the stored line — consumers fall back to `briefingLead` / `line`. Additive since v1.31.0.",
      ),
    ai: z
      .object({
        briefing: aiCapabilityState,
        coach: aiCapabilityState,
        reactionLines: aiCapabilityState,
      })
      .describe(
        "The three AI capabilities the digest carries text or a card for: `briefing` (the lead and top signal), `coach` (the Coach check-in card, which opens the Coach) and `reactionLines` (the reaction line). Everything else in the digest is data.",
      ),
    languages: z
      .object({
        response: z
          .string()
          .describe(
            "The language of every text the server words itself on this request: `today`, `worthALook`, a `signal` lead and a deterministic `line`. On a Bearer request it is the app's `Accept-Language` when that names a shipped language, otherwise the account's language; in a browser, the locale cookie or the account's language.",
          ),
        briefing: z
          .string()
          .nullable()
          .describe(
            "The language of the stored briefing texts (`briefingLead`, `topSignal`, `signalLine`, a `briefing` lead). A briefing written in another language than `response` is not served at all; null when none is served or it predates the tag.",
          ),
        reaction: z
          .string()
          .nullable()
          .describe(
            "The language `reactionLine` is written in: the account's language, which it was generated in. When it differs from `response`, the lead does not use it; the app may show its own wording instead.",
          ),
      })
      .describe(
        "v1.48.0 — which language each text is in, so a client can tell stored model text in another language from text worded for this request. Model text is generated once per account, not per request.",
      ),
  })
  .meta({
    id: "DailyDigest",
    description:
      "The one data spine of the daily-value system — composed from already-cached data, never a fresh AI call. Consumed by the Today surface, the daily push, and a future iOS widget.",
  });

/** A device's own score, under its vendor's name and on its vendor's scale. */
export const deviceSourceValueSchema = z
  .object({
    source: z
      .string()
      .describe("The row's `MeasurementSource` (WHOOP, OURA, POLAR, ...)."),
    label: z
      .string()
      .describe(
        'The vendor\'s own name for the score, resolved server-side ("WHOOP Recovery", "Polar Nightly Recharge", "Oura sleep score").',
      ),
    value: z.number().describe("The value on the vendor's own scale."),
    scaleMax: z
      .number()
      .describe(
        "The top of that scale: 100, or 6 for Polar Nightly Recharge, which is stored rescaled and shown back on its own 1 to 6 scale.",
      ),
    measuredAt: z.string().describe("ISO-8601 instant of the row."),
  })
  .meta({
    id: "DeviceSourceValue",
    description:
      "A score a device computed, shown under its own name. It carries no HealthLog band: the vendor's thresholds are not ours to colour.",
  });

const morningRingSchema = z
  .object({
    score: z
      .number()
      .int()
      .nullable()
      .describe("0 to 100; null when the value is not fresh."),
    band: z
      .enum(["green", "yellow", "red"])
      .nullable()
      .describe("Null when not fresh, and in Rest mode."),
    fresh: z
      .boolean()
      .describe(
        "Every counted input is from the reader's local today and the night is last night. Not fresh means no number, no band and no sentence about the score.",
      ),
    asOfDay: z
      .string()
      .nullable()
      .describe("The local day (YYYY-MM-DD) the value rests on."),
  })
  .meta({ id: "DailyMorningRing" });

const morningScoreSchema = z
  .object({
    shortLabel: z
      .string()
      .describe(
        'The score\'s short name for the tile, from the score registry and worded in the response language ("Schlafscore", "Bereitschaft"). Render it as is. Feature key `daily.scores-short-labels`.',
      ),
    ring: morningRingSchema.describe(
      "The ring as the cards carry it: no number when not fresh.",
    ),
    line: z
      .string()
      .nullable()
      .describe(
        "One line beside the ring, worded on the server: the night's time asleep, the heaviest pull on readiness, or when the last value was.",
      ),
    href: z.string().describe("The score's own page."),
  })
  .meta({ id: "DailyMorningScore" });

const morningCardTitleKey = z
  .enum(Object.values(MORNING_CARD_TITLE_KEYS))
  .describe(
    "Closed set of title message keys: `daily.morningCard.title.night` (Last night), `daily.morningCard.title.todayDifferent` (Different today), `daily.morningCard.title.toDo` (To do today). Glossary terms.",
  );

const morningCardSchema = z
  .object({
    kind: z
      .enum([...MORNING_CARD_KINDS])
      .describe(
        "`night`: last night (sleep score ring only for last night, duration against the usual, the device's own sleep score). `today_different`: readiness, or the values outside their usual range today when there are any.",
      ),
    titleKey: morningCardTitleKey,
    title: z
      .string()
      .describe("The title worded in the response language (`lead.language`)."),
    ring: morningRingSchema
      .nullable()
      .describe(
        "The card's score ring; null when the card shows values instead.",
      ),
    lines: z
      .array(
        z.object({
          text: z.string().describe("Localised, resolved server-side."),
          href: z
            .string()
            .nullable()
            .describe(
              "The page of the metric the line names (a vital, the sleep score, readiness, a readiness contributor), or the Insights page when that metric has no page of its own. Null when the line names no metric (the night not in yet).",
            ),
        }),
      )
      .max(MAX_CARD_LINES)
      .describe(`Up to ${MAX_CARD_LINES} short lines, never padded.`),
    sourceValues: z
      .array(deviceSourceValueSchema)
      .describe("Device scores of the local today, newest per source."),
    href: z.string().describe("Where the card leads."),
  })
  .meta({ id: "DailyMorningCard" });

export const dailyMorningResponse = z
  .object({
    lead: z
      .object({
        rank: z
          .number()
          .int()
          .min(0)
          .max(MORNING_LEAD_KEYS.length - 1)
          .describe(
            "The rule that chose the sentence; 0 wins over 1 and so on.",
          ),
        key: z
          .enum([...MORNING_LEAD_KEYS])
          .describe(
            "The rule by name: floor (a confirmed safety floor in the last 24 hours), rest_mode, coincident (two or more independent signals outside their usual range: blood pressure counts once, resting heart rate and pulse once, weight and glucose never), vital_outside, sleep_pending, source_quiet (first and second quiet day only), readiness (fresh, yellow or red), night_notable, in_range (today's values counted and all in range, or an ordinary night; while the Health score flags a pillar, its `band` below green, that pillar is named instead and the day is never called in range), planned, nothing.",
          ),
        text: z
          .string()
          .describe(
            "One sentence, a finding and never advice, worded on the server from the day's own readings. No model text.",
          ),
        language: z.string().describe("The language `text` is in."),
      })
      .describe("The morning sentence."),
    cards: z
      .array(morningCardSchema)
      .max(MORNING_CARD_KINDS.length)
      .describe(
        "Night first, then what is different today; a card without content is absent. The third card of the morning ('to do today') is `DailyDigest.worthALook` as delivered, with the digest's medications and cycle facts from `today`.",
      ),
    scores: z
      .object({
        sleep: morningScoreSchema
          .nullable()
          .describe(
            "Last night's sleep score: fresh only for last night. Null when the sleep module is off or no sleep reaches this record.",
          ),
        readiness: morningScoreSchema
          .nullable()
          .describe(
            "Today's readiness: fresh only when every input is from today. Null when the recovery module is off or there is none.",
          ),
      })
      .describe(
        "The start page's score tiles beside the Health score (`DailyDigest.score`). A tile whose score is null is not shown. Additive since 1.50.",
      ),
    toDo: z
      .object({ titleKey: morningCardTitleKey, title: z.string() })
      .describe(
        "The title of the third card, which the morning does not carry: clients build it from the digest's rows.",
      ),
    generatedAt: z.string().describe("ISO-8601 instant the morning was read."),
  })
  .meta({
    id: "DailyMorning",
    description:
      "The morning read on the start page: one true sentence chosen by fixed rules and up to two cards. Data, never model text; no module or AI gate. The third card, 'To do today', is built by the client from `GET /api/daily/digest`: the medications fact and the cycle day from `today`, and the rows of `worthALook`. It replaces the separate 'Worth a look' list wherever the morning is shown, so those rows are never rendered twice. Every text is worded on the server in one language: on a Bearer request the `Accept-Language` when it names a shipped language, otherwise the account's language; in a browser, the locale cookie or the account's language. `lead.language` names it.",
  });

export const dailyPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/daily/digest": {
    get: {
      tags: ["Insights"],
      summary: "The unified daily digest",
      description:
        "Assembles the day's read from already-cached data: the nightly briefing lifted read-only from the insights cache, the dashboard-snapshot health score / meds-today / sleep freshness, plus deterministic integration-status, Vorsorge and visit reads for the 'worth a look' rail. The rail's `preventive_care` item covers every check-up due today or overdue and names up to three of them; `upcoming_visit` items cover every planned visit on the local today (also once it has started, until the day ends) in one item, and the next day with a visit inside the next 48 hours in a second. A due check-up and today's visits always keep a place within the three-item cap. No provider call, no warm-on-mount. No module gate and no AI gate: the digest is data, and the `insights` module is the AI analysis opt-out. Its AI parts follow their capabilities, published in `ai`. Cookie or Bearer auth.",
      responses: {
        "200": {
          description: "The daily digest.",
          content: {
            "application/json": {
              schema: dataEnvelope(dailyDigestResponse, "DailyDigestEnvelope"),
            },
          },
        },
        ...recordRefusal(),
        ...stdResponses,
      },
    },
  },
  "/api/daily/morning": {
    get: {
      tags: ["Insights"],
      summary: "The morning read",
      description:
        "One sentence about the day, chosen by fixed rules from the day's own readings, and up to two cards (last night, what is different today). Readiness and the sleep score appear only when fresh: a value resting on older readings carries no number, no band and no sentence. Device scores carry their vendor's name and scale and no band. No provider call, no module gate, no AI gate. Same scope as `/api/daily/digest`. Cookie or Bearer auth; a Bearer request's `Accept-Language` words the texts.",
      responses: {
        "200": {
          description: "The morning read.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dailyMorningResponse,
                "DailyMorningEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(),
        ...stdResponses,
      },
    },
  },
  "/api/daily/digest/dismiss": {
    post: {
      tags: ["Insights"],
      summary: "Dismiss a Today rail item",
      description:
        '"Dismiss / mark seen" for the Today rail\'s OBSERVATIONAL PriorityItem kinds only — milestone, ecg_new_recording, tension_window. The ACTIONABLE kinds (dose_window, sync_issue, preventive_care, coach_checkin) are structurally unreachable: itemKey must be namespaced under one of the three dismissible kinds or the request 422s before any lookup runs. Persisted server-side so the dismissal survives reload / a second device; an upsert, so a repeat dismiss of the same instance is a no-op. No module gate. Cookie or Bearer auth.',
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: dismissPriorityItemSchema },
        },
      },
      responses: {
        "200": {
          description: "The item is dismissed (idempotent).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ dismissed: z.literal(true) }),
                "DismissPriorityItemEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
