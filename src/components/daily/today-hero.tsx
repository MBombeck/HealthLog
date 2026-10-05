"use client";

/**
 * S2 — the Today hero, the promoted day's read on the dashboard.
 *
 * MARC SIGN-OFF (2026-07-16, decision 1): Today is the dashboard hero
 * promoted to the default read, with the dense tile grid demoted below
 * it on the SAME page — no new nav destination. This band mounts above
 * the existing tile strip and renders the S1 `DailyDigest` DTO verbatim;
 * it recomputes nothing (server-authoritative parity) and fetches no
 * fresh AI (the caller's hook GETs the already-cached digest route).
 *
 * Composition (plan §2.1, top→bottom, all shipped primitives):
 *   - the day's read: the health `ScoreRing` (`flat`, md) with its
 *     server-computed band and an honest provisional/final face — a null
 *     score paints the ring's own provisional state, never a zero;
 *   - v1.29.1 (Marc, live-use): the v1.29.0 selected-score-ring cluster is
 *     removed from the web hero — it read as uneven and wasted tile space.
 *     The health `ScoreRing` is the hero's only ring now. The score-ring
 *     SELECTION contract stays server-side (`selectedScoreRings` on the
 *     snapshot still feeds iOS); the web hero simply stops rendering it;
 *   - the briefing lead in plain language (via `ProseBlocks`, no markdown)
 *     with a "read the full briefing" affordance, plus the top signal's
 *     present-tense headline + delta when the digest carries one;
 *   - the freshness note: when `sleepPending`, a calm muted "last night's
 *     sleep not yet in" line — it never blocks the hero (plan §2.4);
 *   - the worth-a-look rail: the digest's `PriorityItem[]` as `PriorityCard`s
 *     (S1's one rail primitive), only when non-empty. When the digest is
 *     all-clear, a first-class muted "nothing needs your attention" line
 *     stands in its place — not an alarming empty card.
 *
 * Every `PriorityItem` action carries an `href` (dose.log → /medications,
 * sync.reconnect → /settings/integrations, checkup.view → /checkups), so
 * `PriorityCard` wires each tap as a `<Link>` to its existing destination
 * by construction; S2 invents no new backend action.
 *
 * Configurable primary content: the `hero` field on the dashboard layout
 * blob (server-persisted, Settings → Dashboard) chooses what this card
 * leads with. `"score"` keeps the composition above verbatim;
 * `"reminders"` promotes the worth-a-look rail into the hero slot — the
 * rail (or the calm all-clear line) becomes the card's content and the
 * score composition yields entirely. The empty-account degrade and the
 * freshness note are shared by both modes.
 */
import Link from "next/link";
import { Moon } from "lucide-react";

import { ScoreRing } from "@/components/insights/derived/score-ring";
import type { ScoreBand } from "@/components/insights/derived/band-tokens";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { PriorityCard } from "@/components/daily/priority-card";
import { useCoachCheckinAction } from "@/hooks/use-coach-checkin";
import { usePriorityItemDismiss } from "@/hooks/use-priority-item-dismiss";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { pluralKey } from "@/lib/i18n/plural";
import { MAX_TODAY_FACTS_NARROW as TODAY_FACTS_NARROW } from "@/lib/daily/today-overview";
import type { DailyDigest } from "@/lib/daily/digest";
import type { HeroPrimaryContent } from "@/lib/dashboard-layout";
import {
  COACH_CHECKIN_KEEP_INTENT,
  COACH_CHECKIN_LETGO_INTENT,
} from "@/lib/daily/coach-checkin-intents";

/** Format the server-computed score delta as a signed, muted chip string. */
function formatDelta(
  delta: number,
  t: ReturnType<typeof useTranslations>["t"],
) {
  const rounded = Math.round(delta);
  if (rounded === 0) return t("daily.today.deltaFlat");
  const signed = rounded > 0 ? `+${rounded}` : `${rounded}`;
  return t("daily.today.deltaVsBaseline", { delta: signed });
}

/** Lowercase letters and digits only, for a wording-insensitive compare. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether `lead` already says what `headline` says. */
function restates(lead: string, headline: string): boolean {
  const h = normalise(headline);
  return h.length > 0 && normalise(lead).includes(h);
}

export function TodayHero({
  digest,
  renderFilteredAllClear = false,
  primaryContent = "score",
}: {
  digest: DailyDigest;
  renderFilteredAllClear?: boolean;
  /** Server-persisted hero choice from the dashboard layout blob. */
  primaryContent?: HeroPrimaryContent;
}) {
  const { t, locale } = useTranslations();
  // The hero is deliberately NOT mount-gated (v1.30.9: it is the LCP element
  // and paints from the server-dehydrated digest on both the SSR and the
  // hydration render), so nothing in it may differ between those two passes.
  // The one thing that did — the removed arrival chip's wall-clock time — was
  // the reason a mount gate lived here at all.
  const { keep, letGo } = useCoachCheckinAction();
  const dismissItem = usePriorityItemDismiss();
  // The rail's two mutating affordances — dismissing an observation and
  // answering a coach check-in — are neither of them an admitted create, so
  // they ask for the caller's own record and are absent under every grant. Both write
  // through routes that resolve the CALLER (`POST /api/daily/digest/dismiss`,
  // `PATCH /api/coach/plans/[id]`), which under a switch means a 403 rather
  // than a stray row; the control still goes, because an affordance the
  // server is on record refusing should not be on the page.
  const { inSharedRecord } = useRecordCapabilities();
  const ownRecord = !inSharedRecord;

  // The coach check-in card's keep / let-go intents carry the plan id after the
  // ":" (a closed two-intent allowlist); adjust is an href handled by the card
  // as a <Link>, so it never lands here. Every other rail kind is pure
  // navigation (dose / sync / preventive), so their taps never call this.
  const handleAction = (intent: string) => {
    const keepPrefix = `${COACH_CHECKIN_KEEP_INTENT}:`;
    const letGoPrefix = `${COACH_CHECKIN_LETGO_INTENT}:`;
    if (intent.startsWith(keepPrefix)) {
      keep.mutate(intent.slice(keepPrefix.length));
    } else if (intent.startsWith(letGoPrefix)) {
      letGo.mutate(intent.slice(letGoPrefix.length));
    }
  };

  const hasScore = digest.score !== null;
  const hasItems = digest.worthALook.length > 0;
  // `?? []` / `?? null` below: the service worker's offline data cache can
  // still hand back a digest written before the overview fields existed, and
  // a missing list must read as "no facts", not as a crash.
  const facts = digest.today ?? [];
  const hasFacts = facts.length > 0;
  // The lead is resolved on the server (`digest.lead`): the reaction line or
  // a briefing sentence with content while AI text is available, otherwise a
  // deterministic sentence about the day's strongest signal. Greetings and a
  // sentence that only repeats the ring's number never reach it, so the hero
  // renders it verbatim and decides nothing about it. A digest the service
  // worker cached before the field existed has no `lead` at all; it falls
  // back to the lines that version led with.
  const lead =
    digest.lead === undefined
      ? (digest.reactionLine ?? digest.briefingLead ?? null)
      : (digest.lead?.text ?? null);
  const topSignal = digest.topSignal;
  // The briefing's top signal rides under an AI lead as its supporting line,
  // and only with what the lead does not already say: a headline the lead
  // restates is dropped and its delta, when there is one, stands alone.
  const signalLine =
    topSignal && lead && digest.lead?.source !== "signal"
      ? restates(lead, topSignal.headline)
        ? topSignal.delta
          ? { headline: null, delta: topSignal.delta }
          : null
        : { headline: topSignal.headline, delta: topSignal.delta }
      : null;
  // A score-only digest with nothing else to say has no narrative content for
  // the leading column. Keeping the full md ring in that two-column shell left
  // a blank column beside a 168 px dial and pushed the all-clear read below
  // it, so that case keeps its compact composition: the all-clear copy leads
  // and a smaller version of the SAME score ring stays the one numeric face.
  // This branch depends only on the server-delivered digest, so SSR and
  // hydration choose it identically.
  const compactAllClear = !lead && !signalLine && !hasItems && !hasFacts;

  // How long the number has held, read off the stored daily scores on the
  // server. Said only when no delta is: a moved score is described by its
  // delta, a still one by its duration, never both under one ring.
  const deltaShown =
    digest.score !== null &&
    digest.score.delta !== null &&
    digest.score.deltaReason === null;
  const steadyWeeks = digest.score?.steadyWeeks ?? null;
  const steadyLine =
    !deltaShown && steadyWeeks !== null
      ? t(pluralKey("daily.today.steadyWeeks", steadyWeeks, locale), {
          count: steadyWeeks,
        })
      : null;

  // v1.38 — what the ring's number rests on, when that is less than the
  // breadth the score recommends. The hero renders the number and nothing
  // else, so without this line a one-area score is indistinguishable here
  // from a full one. Said only below the recommendation: at `full` the
  // fraction would read "3 of 3" (or worse, "4 of 3" — the block counts
  // domains, the recommendation caps at three), and a line every account
  // carries stops being a label. The areas themselves are named on the
  // insights card, one tap away through the ring; this is scope, not a
  // warning, and the ring keeps its size and band colour at every tier.
  const scoreBasis = digest.score?.scoreBasis ?? null;
  const basisLine =
    scoreBasis && scoreBasis.tier !== "full"
      ? t("insights.healthScore.basis", {
          count: scoreBasis.domains,
          recommended: scoreBasis.recommended,
        })
      : null;

  // Calm degrade (plan §3): a genuinely empty account — no score, no rail
  // items, no cached briefing lead and no reaction line — surfaces nothing
  // here. The tile strip below carries its own "add your first reading" empty
  // state, so a second alarming empty card on the hero would be noise. The
  // all-clear state (score present, nothing needs attention) is handled inline
  // below.
  //
  // A fresh arrival used to count as content on its own, back when the
  // "just in" chip was the thing it kept on screen. With the chip gone it
  // no longer earns a hero: an arrival-only digest reaches the compact
  // all-clear composition, which would tell someone with no readings at
  // all that everything is clear — a claim about their health made from
  // nothing, and made only on the days something happened to sync. The
  // arrival still rides the DTO and still feeds the morning line.
  //
  // A filtered layout is the one explicit exception: its empty digest means
  // "the hidden canonical candidates are quiet here", so retain all-clear.
  if (!renderFilteredAllClear && !hasScore && !hasItems && !hasFacts && !lead) {
    return null;
  }

  // Shared fragments — identical markup in every composition, so the
  // "score" and "reminders" modes cannot drift apart on either surface.
  const sleepPendingNote = digest.sleepPending ? (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <p
        data-slot="today-hero-sleep-pending"
        className="flex items-center gap-1.5"
      >
        <Moon className="size-3.5 shrink-0" aria-hidden="true" />
        {t("daily.today.sleepPending")}
      </p>
    </div>
  ) : null;

  /* Worth-a-look rail — S1's `PriorityCard`s, bounded 0–3. */
  const rail = hasItems ? (
    <div className="space-y-2" data-slot="today-hero-rail">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t("daily.today.worthALook")}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {digest.worthALook.map((item, i) => (
          <PriorityCard
            key={`${item.kind}-${i}`}
            item={item}
            onAction={ownRecord ? handleAction : undefined}
            onDismiss={
              ownRecord ? (itemKey) => dismissItem.mutate(itemKey) : undefined
            }
            actionsPending={
              item.kind === "coach_checkin" &&
              (keep.isPending || letGo.isPending)
            }
          />
        ))}
      </div>
    </div>
  ) : null;

  /* The Today overview — up to five statements about the day, resolved on the
     server in priority order. A phone shows the first four: the fifth is
     hidden below `md` rather than dropped, so the list a wide screen reads is
     the same list, one line longer. Each line opens the page it belongs to.
     The block never asks for anything; the rail below is the one place on the
     hero that may. */
  const todayBlock = hasFacts ? (
    <div className="space-y-2" data-slot="today-hero-today">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t("daily.today.heading")}
      </h2>
      <ul className="flex flex-col md:grid md:grid-cols-2 md:gap-x-6 md:gap-y-3 xl:grid-cols-3">
        {facts.map((fact, i) => (
          <li
            key={fact.kind}
            data-slot="today-hero-fact"
            data-kind={fact.kind}
            className={cn(
              "min-w-0",
              i >= TODAY_FACTS_NARROW && "hidden md:block",
            )}
          >
            <Link
              href={fact.href}
              className="focus-visible:ring-ring/50 hover:bg-muted/50 -mx-1.5 flex items-baseline justify-between gap-3 rounded-md px-1.5 py-1 focus-visible:ring-2 focus-visible:outline-none md:flex-col md:items-start md:justify-start md:gap-0.5"
            >
              <span className="text-muted-foreground shrink-0 text-sm md:text-xs">
                {fact.label}
              </span>
              <span className="text-foreground min-w-0 text-right text-sm font-medium md:text-left">
                {fact.value}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  const heroShellClassName = cn(
    // The tile strip's surface plus the ONE sanctioned Today atmosphere:
    // `.today-hero-wash` leans a faint `--primary` mix over the theme
    // `--card` toward the ring corner (the `.wellness-tile` color-mix
    // pattern, softer than the insights hero) so the promoted day's read
    // carries a quiet identity without a banner gradient or glow.
    "bg-card today-hero-wash border-border relative isolate overflow-hidden rounded-xl border",
    "p-4 md:p-6",
  );

  // Reminders-first composition — the rail IS the hero. The score
  // composition yields the slot entirely (the ring keeps its home on
  // /insights); an empty rail degrades to the same calm all-clear line
  // the score mode uses, never an empty card.
  if (primaryContent === "reminders") {
    return (
      <section
        data-slot="today-hero"
        data-phase={digest.phase}
        data-layout="reminders"
        className={heroShellClassName}
      >
        <div className="flex flex-col gap-3 md:gap-4">
          {todayBlock}
          {rail ??
            (hasFacts ? null : (
              <p
                data-slot="today-hero-all-clear"
                className="text-muted-foreground text-sm"
              >
                {t("daily.today.allClear")}
              </p>
            ))}
          {sleepPendingNote}
        </div>
      </section>
    );
  }

  return (
    <section
      data-slot="today-hero"
      data-phase={digest.phase}
      data-layout={compactAllClear ? "compact-all-clear" : "narrative"}
      className={heroShellClassName}
    >
      {/* v1.29.1 — tightened after the v1.29.0 ring cluster was removed: the
          hero read as half-empty (short lead → gap → rail). Compact section
          gaps let the worth-a-look rail sit close under the lead so the card
          reads filled, not padded out. */}
      <div className="flex flex-col gap-3 md:gap-4">
        {/* The day's read — the numeric face on the trailing edge, the
            narrative lead leading. On md+ the lead sits flush-top with the
            score ring (items-start) rather than floating centred beside it. */}
        <div
          className={cn(
            "flex gap-4",
            compactAllClear
              ? "flex-row items-center justify-between"
              : "flex-col md:flex-row md:items-start md:justify-between md:gap-6",
          )}
        >
          <div className="min-w-0 flex-1 space-y-3">
            {/* Hero numeric face: the read leads large in the foreground
                token, calm and legible — the day's read, not a slogan. */}
            {lead || signalLine ? (
              <div className="space-y-2">
                {lead ? (
                  <div
                    data-slot="today-hero-lead"
                    data-source={digest.lead?.source}
                    className="text-foreground text-lg leading-snug font-semibold tracking-tight sm:text-xl"
                  >
                    <ProseBlocks text={lead} strip linkify={false} />
                  </div>
                ) : null}
                {/* Top signal — present-tense headline + optional delta, one
                    muted step down so it supports the lead without
                    competing. */}
                {signalLine ? (
                  <p
                    data-slot="today-hero-signal"
                    className="text-muted-foreground text-sm"
                  >
                    {signalLine.headline}
                    {signalLine.headline && signalLine.delta ? " · " : null}
                    {signalLine.delta}
                  </p>
                ) : null}
              </div>
            ) : null}
            {todayBlock}
            {compactAllClear ? (
              <p
                data-slot="today-hero-all-clear"
                className="text-muted-foreground text-sm"
              >
                {t("daily.today.allClear")}
              </p>
            ) : null}

            {/* In the compact fallback the quiet freshness tier belongs next
                to the smaller ring. That uses the otherwise-empty leading
                space and avoids adding a second row below the dial. */}
            {compactAllClear ? sleepPendingNote : null}
          </div>

          {/* Health score ring — `flat` (no sweep/bloom), server-computed
              band. A null score paints the ring's honest provisional face
              at the same footprint, so the column never collapses. */}
          <div className="flex shrink-0 flex-col items-center gap-1 md:items-end">
            <div data-slot="today-hero-score">
              {/* The ring opens the Insights overview — the destination the
                  health-score card owns — matching the cluster rings' tap
                  behaviour, so every hero ring is a door, not a poster. */}
              <Link
                href="/insights"
                aria-label={t("daily.today.ringLink", {
                  metric: t("daily.today.scoreLabel"),
                })}
                className="focus-visible:ring-ring/50 block rounded-full focus-visible:ring-2 focus-visible:outline-none"
              >
                <ScoreRing
                  score={digest.score?.value ?? null}
                  band={
                    digest.score ? (digest.score.band as ScoreBand) : undefined
                  }
                  size={compactAllClear ? "sm" : "md"}
                  flat
                  label={t("daily.today.scoreLabel")}
                />
              </Link>
            </div>
            {deltaShown && digest.score?.delta != null ? (
              <span
                data-slot="today-hero-score-delta"
                className="text-muted-foreground text-xs tabular-nums"
              >
                {formatDelta(digest.score.delta, t)}
              </span>
            ) : null}
            {steadyLine ? (
              <span
                data-slot="today-hero-score-steady"
                className="text-muted-foreground text-xs"
              >
                {steadyLine}
              </span>
            ) : null}
            {basisLine ? (
              <span
                data-slot="today-hero-score-basis"
                className="text-muted-foreground max-w-[11rem] text-center text-xs text-balance md:text-right"
              >
                {basisLine}
              </span>
            ) : null}
          </div>
        </div>

        {/* Meta row — the hero's quiet tier (UI-STANDARDS §text: `text-xs
            text-muted-foreground` is the meta floor; never an accent, never an
            opacity modifier). Freshness note (plan §2.4) — provisional day,
            last night's sleep not yet folded in. Muted, non-blocking,
            refreshes in place when the morning job lands. */}
        {!compactAllClear ? sleepPendingNote : null}

        {/* Worth-a-look rail — S1's `PriorityCard`s, bounded 0–3. When the
            digest is all-clear, a first-class muted line stands in for the
            rail (calm inversion of an alarm), never an empty card. */}
        {/* The all-clear sentence only ever stands in for an empty card
            (the compact composition above). Once a lead or facts carry the
            day, an empty rail simply is not drawn. */}
        {rail ??
          (!compactAllClear && !hasFacts && !lead ? (
            <p
              data-slot="today-hero-all-clear"
              className="text-muted-foreground text-sm"
            >
              {t("daily.today.allClear")}
            </p>
          ) : null)}
      </div>
    </section>
  );
}
