"use client";

import { useState } from "react";
import { Eye, Loader2, Target } from "lucide-react";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachPrefs, useSaveCoachPrefs } from "@/hooks/use-coach-prefs";
import { CLUSTER_SOURCES } from "@/lib/ai/coach/clusters";
import {
  COACH_HISTORY_WINDOWS,
  HISTORY_REACH_DAYS,
  lookbackText,
} from "@/lib/ai/coach/history-reach";
import {
  DEFAULT_COACH_CLUSTERS,
  coachDataClusterEnum,
  type CoachDataCluster,
  type CoachDefaultWindow,
  type CoachPrefs,
} from "@/lib/validations/coach-prefs";

/**
 * v1.7.2 — "What I can see" rail, backed by the persisted Coach prefs.
 *
 * The rail and the settings-cog sheet now drive the SAME persisted
 * `coachPrefsJson` row: the cluster toggles write `dataClusters` and the
 * window picker writes `defaultWindow` through
 * `PUT /api/auth/me/coach-prefs`. There is no ephemeral per-conversation
 * scope any more — what the rail shows is exactly what the chat route
 * ships to the model (the snapshot builder expands the saved clusters
 * when the request carries no explicit `scope.sources`). A toggle here
 * persists immediately and the cog reflects it on its next open, and
 * vice-versa.
 *
 * The rail is self-contained: it reads `useCoachPrefs` and writes via
 * `useSaveCoachPrefs`, so callers mount it with no props. The cluster
 * member count beneath each label spells out the scope so the user can
 * see how much data each toggle pulls in.
 */
const CLUSTER_OPTIONS: ReadonlyArray<CoachDataCluster> =
  coachDataClusterEnum.options;

/**
 * The lookback options, narrowest first. The choice is a limit
 * the server enforces on every Coach read (`history-reach.ts`), so the text
 * under the picker says what is read, with the numbers the readers use.
 */
const WINDOW_OPTIONS = COACH_HISTORY_WINDOWS;

export interface SourcesRailProps {
  className?: string;
  /**
   * v1.21.2 (A2) — the human label of the metric the current conversation
   * was launched scoped to, or null for a generic (all-source) open. When
   * set, the rail surfaces a small "the Coach is already on <metric>" line
   * above the persisted-cluster toggles so the active narrowing is VISIBLE
   * on the drawer surface (the page surface shows it in the hero). The
   * persisted clusters below still describe what the Coach can otherwise
   * see — the scope line names where this conversation actually started.
   */
  activeScopeLabel?: string | null;
}

export function SourcesRail({ className, activeScopeLabel }: SourcesRailProps) {
  const { t, tCount } = useTranslations();

  const { data: prefs } = useCoachPrefs();
  const save = useSaveCoachPrefs();

  // The persisted set drives the switches: `undefined` (never picked) →
  // legacy defaults, otherwise the explicit array (including the empty
  // "everything off" state). Track the cluster being written so its
  // switch shows a tiny spinner instead of the whole rail freezing.
  const enabledClusters = new Set<CoachDataCluster>(
    prefs?.dataClusters ?? DEFAULT_COACH_CLUSTERS,
  );
  const activeWindow: CoachDefaultWindow = prefs?.defaultWindow ?? "allTime";
  const activeText = lookbackText(activeWindow);
  const bounded = HISTORY_REACH_DAYS[activeWindow] !== null;
  const [pending, setPending] = useState<CoachDataCluster | "window" | null>(
    null,
  );

  function persist(next: CoachPrefs, marker: CoachDataCluster | "window") {
    setPending(marker);
    save.mutate(next, {
      onSettled: () => setPending(null),
      // v1.16.4 — a failed save used to revert the switch silently once the
      // spinner cleared; a toast names the rejection.
      onError: () => toast.error(t("insights.coach.prefsSaveError")),
    });
  }

  function toggleCluster(cluster: CoachDataCluster, next: boolean) {
    if (!prefs) return;
    const current = prefs.dataClusters ?? Array.from(DEFAULT_COACH_CLUSTERS);
    const dataClusters = next
      ? Array.from(new Set([...current, cluster]))
      : current.filter((c) => c !== cluster);
    persist({ ...prefs, dataClusters }, cluster);
  }

  function setWindow(next: CoachDefaultWindow) {
    if (!prefs) return;
    persist({ ...prefs, defaultWindow: next }, "window");
  }

  return (
    <div
      data-slot="coach-sources-rail"
      // v1.16.1 — `min-w-0` + `overflow-x-hidden` pin the rail to its
      // column width: the switch rows used to push past the 280/320 px
      // container and paint a horizontal scrollbar under the rail.
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-x-hidden p-3.5",
        className,
      )}
    >
      <h3
        data-slot="coach-sources-rail-heading"
        // No horizontal inset — the heading sits flush with the row
        // boxes below it (headings and their content share one left
        // edge across the Coach surfaces). v1.18.1 (W-COACH-UI C1/C4) —
        // typography matched to the history-rail heading so the two rails
        // read as one family.
        className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase"
      >
        <Eye className="text-muted-foreground size-3.5" aria-hidden="true" />
        {t("insights.coach.sourcesTitle")}
      </h3>

      {/* v1.21.2 (A2) — the visible launch scope for this conversation. Only
          rendered when the Coach was opened narrowed to a metric; a generic
          open omits it entirely so the rail is unchanged for the default
          all-source case. */}
      {activeScopeLabel ? (
        <div
          data-slot="coach-sources-active-scope"
          className="border-primary/30 bg-primary/5 text-foreground flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium"
        >
          <Target
            className="text-primary size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">
            {t("insights.coach.scope.prefix", { metric: activeScopeLabel })}
          </span>
        </div>
      ) : null}

      {/* Lookback limit — persists to `coachPrefs.defaultWindow`. The line
          under the picker states what the Coach reads at this setting, with
          the numbers the server readers use. */}
      <div data-slot="coach-sources-window" className="flex flex-col gap-1">
        <label
          htmlFor="coach-sources-window-select"
          className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
        >
          {t("insights.coach.lookback.label")}
        </label>
        <Select
          value={activeWindow}
          onValueChange={(v) => setWindow(v as CoachDefaultWindow)}
          disabled={!prefs}
        >
          <SelectTrigger
            id="coach-sources-window-select"
            data-slot="coach-sources-window-trigger"
            size="default"
            className="h-9 text-sm"
            aria-describedby="coach-sources-window-detail"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_OPTIONS.map((w) => (
              <SelectItem key={w} value={w} className="text-sm">
                {t(
                  `insights.coach.lookback.option.${w}`,
                  lookbackText(w).optionParams,
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p
          id="coach-sources-window-detail"
          data-slot="coach-sources-window-detail"
          className="text-muted-foreground text-xs leading-snug"
        >
          {t(
            `insights.coach.lookback.${activeText.detailKey}`,
            activeText.detailParams,
          )}
          {bounded ? ` ${t("insights.coach.lookback.note")}` : null}
        </p>
      </div>

      {/* Persisted cluster toggles — the same set the settings cog
          edits. Toggling writes `dataClusters` immediately; the member
          count hint shows the scope each cluster pulls in. */}
      <ul
        data-slot="coach-sources-list"
        className="flex flex-1 flex-col gap-1.5 overflow-y-auto"
      >
        {CLUSTER_OPTIONS.map((cluster) => {
          const checked = enabledClusters.has(cluster);
          const switchId = `coach-sources-cluster-${cluster}`;
          const memberCount = CLUSTER_SOURCES[cluster].length;
          return (
            <li
              key={cluster}
              data-slot="coach-sources-row"
              data-source={cluster}
              data-active={checked ? "true" : "false"}
              // A switched-off row is told apart by its frame (dashed, no
              // fill) and its switch, never by fading the text: opacity over
              // muted text fell below WCAG AA in both themes.
              className={cn(
                "flex items-center gap-2.5 rounded-lg border px-3",
                "min-h-11 py-2",
                checked
                  ? "border-border/60 bg-muted/30"
                  : "border-border border-dashed bg-transparent",
              )}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <label
                  htmlFor={switchId}
                  className="text-foreground cursor-pointer text-sm font-medium"
                >
                  {t(`insights.coach.cluster.${cluster}.label`)}
                </label>
                <span className="text-muted-foreground text-xs leading-snug">
                  {tCount("insights.coach.sourcesMemberCount", memberCount)}
                </span>
              </div>
              {pending === cluster ? (
                <Loader2
                  className="text-muted-foreground size-4 shrink-0 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Switch
                  id={switchId}
                  data-slot="coach-sources-checkbox"
                  checked={checked}
                  disabled={!prefs || pending !== null}
                  onCheckedChange={(next) => toggleCluster(cluster, next)}
                  aria-label={t(`insights.coach.cluster.${cluster}.label`)}
                  className="cursor-pointer"
                />
              )}
            </li>
          );
        })}
      </ul>
      {/* v1.12.0 — the clinical-decisions disclaimer used to render
          here AND at the bottom of the message thread. DISC-01
          (v1.18.6) dropped both per-page copies in favour of the
          one-time onboarding acknowledgment
          (`onboarding.disclaimer.acknowledge`); the guard stack
          (system prompt, prose-grounding check, outbound refusal)
          carries the real non-diagnostic boundary. The rail renders
          no disclaimer of its own. */}
    </div>
  );
}
