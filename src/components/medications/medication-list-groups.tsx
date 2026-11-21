"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { TagChip } from "@/components/ui/tag-chip";
import { useMounted } from "@/hooks/use-mounted";
import { cn } from "@/lib/utils";
import {
  sortMedicationCategoriesByDefault,
  type MedicationGroupsOpen,
} from "@/lib/medication-list-layout";
import { applyCategoryOrder } from "@/lib/settings/module-list-layout";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";
import { MEDICATION_CATEGORY_VALUES } from "@/lib/medications/category-values";
import type { DoseStatus } from "@/lib/analytics/compliance/dose-status";
import type { MedicationComplianceSummaryEntry } from "@/lib/queries/use-medication-compliance-summary";

export interface MedicationGroupCategory {
  key: string;
  label: string;
}

export interface MedicationGroup<T> {
  category: MedicationGroupCategory;
  medications: T[];
  section?: "active" | "inactive";
}

/**
 * The current dose status of each medication, from the batched compliance
 * rows. A medication without a row counts as upcoming.
 */
export function buildDoseStatusById(
  rows:
    | readonly Pick<
        MedicationComplianceSummaryEntry,
        "medicationId" | "complianceDisplay"
      >[]
    | null
    | undefined,
): Map<string, DoseStatus> {
  return new Map(
    (rows ?? []).map((row) => [
      row.medicationId,
      row.complianceDisplay?.currentDose.status ?? "upcoming",
    ]),
  );
}

export function getGroupKey<T>(group: MedicationGroup<T>): string {
  return group.section
    ? `${group.section}:${group.category.key}`
    : group.category.key;
}

/**
 * Group medications by category, respecting the user's categoryOrder,
 * omitting empty groups, and preserving medication order within each group.
 */
export function groupMedications<
  T extends {
    id: string;
    category: string;
    categoryLabel?: string | null;
  },
>(
  medications: readonly T[],
  categoryOrder: readonly string[] | null | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
  customCategories?: readonly { key: string; label: string }[],
  section?: "active" | "inactive",
  locale?: string,
): MedicationGroup<T>[] {
  const customMap = new Map<string, string>();
  for (const c of customCategories ?? []) {
    customMap.set(c.key, c.label);
  }

  const byCategory = new Map<string, T[]>();
  for (const med of medications) {
    const list = byCategory.get(med.category) ?? [];
    list.push(med);
    byCategory.set(med.category, list);
  }

  // Determine all known categories to order
  const categoryKeys = new Set<string>([
    ...MEDICATION_CATEGORY_VALUES,
    ...(customCategories ?? []).map((c) => c.key),
    ...byCategory.keys(),
  ]);

  const allCategories: MedicationGroupCategory[] = [];
  for (const key of categoryKeys) {
    const customLabel = customMap.get(key);
    // Find a med in this category with categoryLabel if any
    const medWithLabel = byCategory.get(key)?.find((m) => m.categoryLabel);
    const label =
      customLabel ??
      medWithLabel?.categoryLabel ??
      getMedicationCategoryLabel(key, t);
    allCategories.push({ key, label });
  }

  const defaultOrdered = sortMedicationCategoriesByDefault(
    allCategories,
    locale,
  );
  const orderedCategories = applyCategoryOrder(
    defaultOrdered,
    categoryOrder ?? [],
    "OTHER",
  );

  return orderedCategories
    .map((category) => ({
      category,
      section,
      medications: byCategory.get(category.key) ?? [],
    }))
    .filter((group) => group.medications.length > 0);
}

const STORAGE_KEY = "healthlog:medications-groups-open";

interface StoredOpen {
  mode: MedicationGroupsOpen;
  open: Record<string, boolean>;
}

export function readStoredOpen(
  mode: MedicationGroupsOpen,
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
  mode: MedicationGroupsOpen,
  open: Record<string, boolean>,
): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode, open } satisfies StoredOpen),
    );
  } catch {
    // Storage unavailable
  }
}

export function isMedicationDue<
  T extends {
    id?: string;
    active?: boolean;
    asNeeded?: boolean;
    pausedAt?: string | null;
    trackIntake?: boolean;
    intakeActionable?: boolean;
    nextDueOverdue?: boolean;
    nextDueAt?: string | null;
    doseStatus?: DoseStatus;
  },
>(
  med: T,
  options?: {
    doseStatusById?: ReadonlyMap<string, DoseStatus>;
    now?: Date;
  },
): boolean {
  if (
    med.active === false ||
    med.asNeeded === true ||
    med.pausedAt != null ||
    med.trackIntake === false ||
    med.intakeActionable === false
  ) {
    return false;
  }

  const doseStatus =
    med.doseStatus ??
    (med.id ? options?.doseStatusById?.get(med.id) : undefined);

  if (doseStatus) {
    return (
      doseStatus === "on_time_window" ||
      doseStatus === "overdue" ||
      doseStatus === "missed"
    );
  }

  if (med.nextDueOverdue) {
    return true;
  }

  if (med.nextDueAt) {
    const nowMs = (options?.now ?? new Date()).getTime();
    const dueMs = new Date(med.nextDueAt).getTime();
    return Number.isFinite(dueMs) && dueMs <= nowMs;
  }

  return false;
}

export function openByDefault<
  T extends {
    id?: string;
    active?: boolean;
    asNeeded?: boolean;
    pausedAt?: string | null;
    trackIntake?: boolean;
    intakeActionable?: boolean;
    nextDueOverdue?: boolean;
    nextDueAt?: string | null;
    doseStatus?: DoseStatus;
  },
>(
  group: MedicationGroup<T>,
  mode: MedicationGroupsOpen,
  options?: {
    doseStatusById?: ReadonlyMap<string, DoseStatus>;
    now?: Date;
  },
): boolean {
  if (mode === "expanded") return true;
  if (mode === "collapsed") return false;
  // "flagged" / Due only: open if any medication in the group is truly due
  return group.medications.some((m) => isMedicationDue(m, options));
}

export interface UseMedicationGroupsOpenOptions {
  doseStatusById?: ReadonlyMap<string, DoseStatus>;
  now?: Date;
  highlightId?: string | null;
}

/**
 * Which categories are open. Following Labs useGroupsOpen semantics.
 * While filtering is active, every group with matching rows is open.
 */
export function useMedicationGroupsOpen<
  T extends {
    id?: string;
    active?: boolean;
    asNeeded?: boolean;
    pausedAt?: string | null;
    trackIntake?: boolean;
    intakeActionable?: boolean;
    nextDueOverdue?: boolean;
    nextDueAt?: string | null;
    doseStatus?: DoseStatus;
  },
>(
  mode: MedicationGroupsOpen = "expanded",
  filtering = false,
  options?: UseMedicationGroupsOpenOptions,
) {
  const mounted = useMounted();
  const stored = useMemo(
    () => (mounted ? readStoredOpen(mode) : {}),
    [mounted, mode],
  );
  const [toggled, setToggled] = useState<StoredOpen>({ mode, open: {} });
  const own = toggled.mode === mode ? toggled.open : {};

  const [filtered, setFiltered] = useState<{
    filtering: boolean;
    open: Record<string, boolean>;
  }>({ filtering, open: {} });

  if (filtered.filtering !== filtering) {
    setFiltered({ filtering, open: {} });
  }
  const whileFiltering = filtered.filtering === filtering ? filtered.open : {};

  const isOpen = (group: MedicationGroup<T>) => {
    const key = getGroupKey(group);
    if (filtering) {
      return whileFiltering[key] ?? true;
    }
    const hasHighlight = Boolean(
      options?.highlightId &&
      group.medications.some((m) => m.id === options.highlightId),
    );
    if (hasHighlight) {
      return true;
    }
    return own[key] ?? stored[key] ?? openByDefault(group, mode, options);
  };

  const toggle = (group: MedicationGroup<T>) => {
    const key = getGroupKey(group);
    if (filtering) {
      setFiltered({
        filtering,
        open: { ...whileFiltering, [key]: !isOpen(group) },
      });
      return;
    }
    const next = { ...stored, ...own, [key]: !isOpen(group) };
    setToggled({ mode, open: next });
    writeStoredOpen(mode, next);
  };

  return { isOpen, toggle };
}

/**
 * Header for a medication category group disclosure.
 */
export function MedicationGroupHeader({
  category,
  count,
  open,
  onToggle,
  panelId,
  className,
}: {
  category: MedicationGroupCategory;
  count: number;
  open: boolean;
  onToggle: () => void;
  panelId?: string;
  className?: string;
}) {
  return (
    <h2 className={cn("min-w-0", className)}>
      <button
        type="button"
        data-slot="medication-list-group"
        data-category={category.key}
        aria-expanded={open}
        aria-controls={panelId || undefined}
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
        <TagChip className="shrink-0 tabular-nums">{count}</TagChip>
      </button>
    </h2>
  );
}
