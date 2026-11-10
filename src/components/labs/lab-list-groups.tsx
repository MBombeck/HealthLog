"use client";

/**
 * The categories of the labs list: which markers sit under which header, the
 * header itself, and which categories are open.
 *
 * Everything about a category comes from the server (`categories` on
 * `GET /api/labs/overview`): its members, label, order, counts and status,
 * which describe the full category. When no effective list filters are
 * active, this module renders those server category counts and status;
 * when filters narrow the visible rows, it summarizes the visible subset
 * client-side.
 */
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { ScorePill } from "@/components/ui/score-pill";
import { TagChip } from "@/components/ui/tag-chip";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { priorityReferenceRangeStatus } from "@/lib/labs/reference-range";
import type { ModuleGroupsOpen } from "@/lib/module-list-prefs";
import { cn } from "@/lib/utils";

import type { MarkerRow } from "./lab-list-rows";
import type { LabOverviewCategoryDto } from "./types";

export interface MarkerGroup {
  category: LabOverviewCategoryDto;
  rows: MarkerRow[];
}

/**
 * The rows under each category, in the order the rows already have (the
 * person's sort applies inside a category); the categories keep the server
 * order. A category none of whose rows is present drops out.
 */
export function groupMarkerRows(
  rows: readonly MarkerRow[],
  categories: readonly LabOverviewCategoryDto[],
): MarkerGroup[] {
  const categoryOf = new Map<string, string>();
  for (const category of categories) {
    for (const key of category.markerKeys) categoryOf.set(key, category.key);
  }
  const byCategory = new Map<string, MarkerRow[]>();
  for (const row of rows) {
    const key = categoryOf.get(row.key);
    if (key === undefined) continue;
    const list = byCategory.get(key) ?? [];
    list.push(row);
    byCategory.set(key, list);
  }
  return categories
    .map((category) => ({
      category,
      rows: byCategory.get(category.key) ?? [],
    }))
    .filter((group) => group.rows.length > 0);
}

const STORAGE_KEY = "healthlog:labs-groups-open";

interface StoredOpen {
  /** The `groupsOpen` choice the toggles were made under. */
  mode: ModuleGroupsOpen;
  open: Record<string, boolean>;
}

export function readStoredOpen(
  mode: ModuleGroupsOpen,
): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<StoredOpen>;
    if (parsed.mode !== mode || typeof parsed.open !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed.open ?? {})) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeStoredOpen(
  mode: ModuleGroupsOpen,
  open: Record<string, boolean>,
): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode, open } satisfies StoredOpen),
    );
  } catch {
    // Storage unavailable: the toggle still holds for this page.
  }
}

function openByDefault(
  mode: ModuleGroupsOpen,
  status: LabOverviewCategoryDto["status"],
): boolean {
  if (mode === "expanded") return true;
  if (mode === "collapsed") return false;
  // Consumers supply category.status for unfiltered categories, or the
  // summarised status for filtered groups.
  return status === "above" || status === "below";
}

/**
 * Which categories are open. The `groupsOpen` choice sets the start; a
 * category the person opened or closed by hand stays so in this browser
 * (keyed by the opaque category key, never by its label) until the choice
 * itself changes. Storage is read only after hydration and may be missing.
 */
export function useGroupsOpen(mode: ModuleGroupsOpen): {
  isOpen: (
    category: LabOverviewCategoryDto,
    status: LabOverviewCategoryDto["status"],
  ) => boolean;
  toggle: (
    category: LabOverviewCategoryDto,
    status: LabOverviewCategoryDto["status"],
  ) => void;
} {
  const mounted = useMounted();
  const stored = useMemo(
    () => (mounted ? readStoredOpen(mode) : {}),
    [mounted, mode],
  );
  const [toggled, setToggled] = useState<StoredOpen>({ mode, open: {} });
  const own = toggled.mode === mode ? toggled.open : {};

  const isOpen = (
    category: LabOverviewCategoryDto,
    status: LabOverviewCategoryDto["status"],
  ) =>
    own[category.key] ??
    stored[category.key] ??
    openByDefault(mode, status);

  const toggle = (
    category: LabOverviewCategoryDto,
    status: LabOverviewCategoryDto["status"],
  ) => {
    const next = {
      ...stored,
      ...own,
      [category.key]: !isOpen(category, status),
    };
    setToggled({ mode, open: next });
    writeStoredOpen(mode, next);
  };
  return { isOpen, toggle };
}

export interface LabGroupSummary {
  counts: LabOverviewCategoryDto["counts"];
  status: LabOverviewCategoryDto["status"];
}

/** Summarise counts and overall status for a list of rows. */
export function summariseGroupRows(rows: readonly MarkerRow[]): LabGroupSummary {
  const counts = { inRange: 0, below: 0, above: 0, unknown: 0 };
  for (const row of rows) {
    const s = row.latest.rangeStatus;
    if (s === "in-range") counts.inRange += 1;
    else if (s === "below") counts.below += 1;
    else if (s === "above") counts.above += 1;
    else counts.unknown += 1;
  }
  const status = priorityReferenceRangeStatus(counts);
  return { counts, status };
}

/**
 * Group-status semantics:
 * When filters or search are active, the group summary (both the count badge
 * and the range status pill, e.g. "All in range" or "X of Y outside range")
 * describes only the visible rows currently matching the filters in this
 * group, rather than unfiltered server category totals.
 */
function GroupStatus({
  counts,
  status,
}: {
  counts: LabOverviewCategoryDto["counts"];
  status: LabOverviewCategoryDto["status"];
}) {
  const { t, tCount } = useTranslations();
  if (status === "unknown") return null;
  if (status === "in-range") {
    return <ScorePill tone="neutral">{t("labs.groups.allInRange")}</ScorePill>;
  }
  return (
    <ScorePill tone={status === "above" ? "warning" : "info"}>
      {tCount("labs.groups.outsideCount", counts.above + counts.below, {
        total: counts.inRange + counts.below + counts.above + counts.unknown,
      })}
    </ScorePill>
  );
}

/**
 * A category header: a heading around one disclosure button holding the
 * chevron, the label, the member count and the status, so the status is part
 * of what the button announces. No region role: a list can carry more than a
 * handful of categories.
 */
export function LabGroupHeader({
  category,
  rows,
  open,
  onToggle,
  panelId,
  className,
  isFiltered = false,
  status: statusProp,
  summary: summaryProp,
}: {
  category: LabOverviewCategoryDto;
  rows: readonly MarkerRow[];
  open: boolean;
  onToggle: () => void;
  panelId: string;
  className?: string;
  isFiltered?: boolean;
  status?: LabOverviewCategoryDto["status"];
  summary?: LabGroupSummary;
}) {
  const { counts, status } = useMemo(() => {
    if (isFiltered) {
      const summary = summaryProp ?? summariseGroupRows(rows);
      return {
        counts: summary.counts,
        status: statusProp ?? summary.status,
      };
    }
    const { inRange, below, above, unknown } = category.counts;
    return {
      counts: { inRange, below, above, unknown },
      status: statusProp ?? category.status,
    };
  }, [category, rows, isFiltered, statusProp, summaryProp]);

  return (
    <h2 className={cn("min-w-0", className)}>
      <button
        type="button"
        data-slot="lab-list-group"
        data-category={category.key}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="focus-visible:ring-ring/50 flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-[3px] sm:min-h-9"
      >
        <ChevronDown
          aria-hidden
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
        />
        <span className="text-muted-foreground min-w-0 truncate text-xs font-medium tracking-wide uppercase">
          {category.label}
        </span>
        <TagChip className="shrink-0 tabular-nums">
          {rows.length}
        </TagChip>
        <span className="ml-auto shrink-0">
          <GroupStatus counts={counts} status={status} />
        </span>
      </button>
    </h2>
  );
}
