"use client";

import {
  Activity,
  Eye,
  Heart,
  HeartPulse,
  Pill,
  Scale,
  Smile,
} from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import type {
  CoachScope,
  CoachScopeSource,
  CoachScopeWindow,
} from "@/lib/ai/coach/types";

/**
 * v1.4.20 phase B2b — "What I can see" rail.
 *
 * Right-column companion in the Coach drawer. Lists the data sources
 * the assistant draws on so the user can build trust in the
 * provenance.
 *
 * v1.4.20.1 — controls promoted from a static legend to a real scope
 * picker:
 *   - per-source checkboxes (BP / Weight / Pulse / Mood / Compliance)
 *     so the user can include/exclude a source from the next Coach
 *     turn
 *   - a window selector (last 7 / 30 / 90 days, all time) feeding
 *     `buildCoachSnapshot`'s timeline window
 * Scope state lives in the parent drawer so `useSendCoachMessage`
 * can pass it through to the route on each send. The rail itself
 * stays presentational — it reads the current scope and emits an
 * `onScopeChange` whenever the user toggles a control. No
 * conversation-level persistence in v1.4.20.1; the rail resets to
 * "all sources, last 30 days" each time the drawer mounts fresh.
 */

const ALL_SOURCES: ReadonlyArray<CoachScopeSource> = [
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
];

const DEFAULT_WINDOW: CoachScopeWindow = "last30days";

/**
 * Default scope used by the drawer's initial mount. Exported so the
 * parent can seed its own state without re-deriving the same values.
 */
export const DEFAULT_COACH_SCOPE: Required<
  Pick<CoachScope, "sources" | "window">
> = {
  sources: [...ALL_SOURCES],
  window: DEFAULT_WINDOW,
};

export interface SourcesRailProps {
  className?: string;
  /**
   * Current scope. When omitted the rail paints with the all-source
   * last-30-days defaults — useful in storyboards / unit tests that
   * just want to see the legend.
   */
  scope?: CoachScope;
  /**
   * Fired when the user toggles a checkbox or changes the window.
   * The parent merges the change into its scope state. When omitted
   * the controls still render but stay read-only — keeps the legend
   * surface stable for callers that don't yet wire scope through.
   */
  onScopeChange?: (next: {
    sources: CoachScopeSource[];
    window: CoachScopeWindow;
  }) => void;
}

interface SourceRow {
  key: CoachScopeSource;
  metricKey: string;
  Icon: React.ComponentType<{ className?: string }>;
  accentClass: string;
}

const ROWS: SourceRow[] = [
  {
    key: "bp",
    metricKey: "insights.coach.metric.bp",
    Icon: HeartPulse,
    accentClass: "text-dracula-purple",
  },
  {
    key: "weight",
    metricKey: "insights.coach.metric.weight",
    Icon: Scale,
    accentClass: "text-dracula-cyan",
  },
  {
    key: "pulse",
    metricKey: "insights.coach.metric.pulse",
    Icon: Heart,
    accentClass: "text-dracula-pink",
  },
  {
    key: "mood",
    metricKey: "insights.coach.metric.mood",
    Icon: Smile,
    accentClass: "text-dracula-green",
  },
  {
    key: "compliance",
    metricKey: "insights.coach.metric.compliance",
    Icon: Pill,
    accentClass: "text-dracula-orange",
  },
];

const WINDOW_OPTIONS: ReadonlyArray<CoachScopeWindow> = [
  "last7days",
  "last30days",
  "last90days",
  "allTime",
];

export function SourcesRail({
  className,
  scope,
  onScopeChange,
}: SourcesRailProps) {
  const { t } = useTranslations();

  const activeSources = new Set<CoachScopeSource>(
    scope?.sources && scope.sources.length > 0
      ? scope.sources
      : DEFAULT_COACH_SCOPE.sources,
  );
  const activeWindow: CoachScopeWindow = scope?.window ?? DEFAULT_WINDOW;
  const interactive = !!onScopeChange;

  function toggleSource(key: CoachScopeSource) {
    if (!onScopeChange) return;
    const next = new Set(activeSources);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onScopeChange({ sources: Array.from(next), window: activeWindow });
  }

  function setWindow(next: CoachScopeWindow) {
    if (!onScopeChange) return;
    onScopeChange({
      sources: Array.from(activeSources),
      window: next,
    });
  }

  return (
    <div
      data-slot="coach-sources-rail"
      className={cn("flex h-full min-h-0 flex-col gap-3 p-3", className)}
    >
      <div className="flex items-center gap-1.5 px-1">
        <Eye className="text-muted-foreground size-3.5" aria-hidden="true" />
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {t("insights.coach.sourcesTitle")}
        </span>
      </div>

      {/* Window selector — every row below is filtered to the picked
          window when the next Coach message goes out. 36px touch
          target on the trigger so the rail stays mobile-friendly when
          it surfaces inside the side-tray on `<xl`. */}
      <div data-slot="coach-sources-window" className="flex flex-col gap-1">
        <label
          htmlFor="coach-sources-window-select"
          className="text-muted-foreground px-1 text-[10px] font-medium tracking-wide uppercase"
        >
          {t("insights.coach.windowLabel")}
        </label>
        <Select
          value={activeWindow}
          onValueChange={(v) => setWindow(v as CoachScopeWindow)}
          disabled={!interactive}
        >
          <SelectTrigger
            id="coach-sources-window-select"
            data-slot="coach-sources-window-trigger"
            size="default"
            className="h-9 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_OPTIONS.map((w) => (
              <SelectItem key={w} value={w} className="text-xs">
                {t(`insights.coach.window.${w}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ul
        data-slot="coach-sources-list"
        className="flex flex-1 flex-col gap-1.5"
      >
        {ROWS.map((row) => {
          const checked = activeSources.has(row.key);
          const checkboxId = `coach-sources-toggle-${row.key}`;
          return (
            <li
              key={row.key}
              data-slot="coach-sources-row"
              data-source={row.key}
              data-active={checked ? "true" : "false"}
              className={cn(
                "border-border/60 bg-muted/30 flex items-center gap-2",
                "rounded-md border px-2.5",
                // 36px target so a finger tap reliably lands on the
                // checkbox on mobile (the side-tray surface).
                "min-h-9 py-1.5",
                !checked && "opacity-60",
              )}
            >
              {/* v1.4.27 R3d MB4 / CF-40 — swap the raw HTML checkbox
                  for the shadcn `<Checkbox>` primitive so the rail
                  ships a real focus ring, a proper keyboard contract
                  (Space toggles, Tab moves), and a touch-friendly
                  hit target on the side-tray surface. The wrapping
                  `<label htmlFor={checkboxId}>` below still acts as
                  the row-wide tap target on mobile. */}
              <Checkbox
                id={checkboxId}
                checked={checked}
                disabled={!interactive}
                onCheckedChange={() => toggleSource(row.key)}
                data-slot="coach-sources-checkbox"
                aria-label={t(row.metricKey)}
                className="cursor-pointer"
              />
              <row.Icon
                className={cn("size-3.5", row.accentClass)}
                aria-hidden="true"
              />
              <label
                htmlFor={checkboxId}
                className={cn(
                  "text-foreground flex-1 cursor-pointer text-xs font-medium",
                  !interactive && "cursor-default",
                )}
              >
                {t(row.metricKey)}
              </label>
              {/* Fresh / stale indicator — v1.4.20 was a static dot
                  with no real freshness state behind it (v1.4.21 plugs
                  in <IntegrationStatusPill>). aria-hidden so SR users
                  don't hear "Fresh" five times in a row for what is
                  actually a placeholder. */}
              <span
                aria-hidden="true"
                className="bg-dracula-green size-1.5 rounded-full"
              />
            </li>
          );
        })}
      </ul>
      {/* v1.4.22 B4: the rail's footer now carries the medical
          disclaimer (relocated from below the composer). The
          source-picker section above stands on its own as the rail's
          primary content — users see the disclaimer once, in a calm
          place, instead of every time they look at the input. */}
      <div
        data-slot="coach-sources-disclaimer"
        className="border-border/50 mt-auto flex items-start gap-2 border-t pt-3"
      >
        <Activity
          aria-hidden="true"
          className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
        />
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {t("insights.coach.composerDisclaimer")}
        </p>
      </div>
    </div>
  );
}
