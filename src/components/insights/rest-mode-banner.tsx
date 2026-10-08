"use client";

import { HeartPulse } from "lucide-react";

import {
  DAY_LINK_SLOT,
  DayLinkStated,
  withDayLinkSlot,
} from "@/components/day/day-link";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { RestModeAnnotation } from "@/lib/analytics/score/types";

/**
 * v1.18.1 — calm, neutral Rest Mode indicator.
 *
 * Rest Mode is the server-authoritative "an illness/condition episode is
 * active" context (`@/lib/illness/rest-mode`). When it is active the score,
 * recovery, and streak surfaces are FRAMED — never penalised — and iOS already
 * mirrors the annotation verbatim. The web surfaces (dashboard score card,
 * recovery insight) previously read the score with no on-screen explanation,
 * so a self-hoster saw their number behave differently with no cue. This
 * banner closes that web↔iOS parity gap.
 *
 * Contract (mirrors the audit's "value-free" requirement):
 *   - renders nothing when `annotation` is null or inactive (the common case);
 *   - never surfaces a decrypted note, an episode label, or any health value —
 *     the only data shown is the onset DATE (a calendar anchor, not a reading);
 *   - carries NO colour tint (a tinted "you're unwell" banner would alarm, not
 *     reassure) — it wears the same neutral bordered card the trend-annotation
 *     primitive uses so it reads as one of the calm insight surfaces.
 *
 * Pure presentational: the caller resolves `annotation` from the
 * server-authoritative score payload and passes it in.
 */
export function RestModeBanner({
  annotation,
}: {
  annotation: RestModeAnnotation | null | undefined;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  if (!annotation || !annotation.active) return null;

  // The onset date is a calendar anchor, not a health value. Format it through
  // the user's locale formatter when present; fall back to the value-free body
  // when the score payload carried no onset (e.g. a condition with no recorded
  // start).
  const since = annotation.since;
  const sinceLabel =
    since && !Number.isNaN(Date.parse(since))
      ? fmt.date(new Date(since))
      : null;

  return (
    <div
      data-slot="rest-mode-banner"
      role="status"
      className="border-border/60 bg-card/40 flex items-start gap-2 rounded-md border p-3"
    >
      <HeartPulse
        className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-foreground text-sm font-medium">
          {t("insights.restMode.title")}
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {/* v1.42 — the onset date opens the day the episode began. */}
          {sinceLabel && since
            ? withDayLinkSlot(
                t("insights.restMode.bodySince", { since: DAY_LINK_SLOT }),
                <DayLinkStated at={since} size="xs">
                  {sinceLabel}
                </DayLinkStated>,
              )
            : t("insights.restMode.body")}
        </p>
      </div>
    </div>
  );
}
