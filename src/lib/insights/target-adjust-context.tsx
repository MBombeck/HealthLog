"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { TargetEditSheet } from "@/components/targets/target-edit-sheet";

/**
 * Insights target-adjust context.
 *
 * The per-metric target editor (`<TargetEditSheet>`) used to be opened
 * by an "Adjust target range" link sitting inside the target reference
 * card on each Insights category page. The trigger moved up to a gear
 * button in the page header (`<SubPageShell>`), beside the Coach launch
 * icon, so the card stays a read surface and the action reads as a
 * header control.
 *
 * Because the gear lives in the header while the editable target's
 * type / range still come from the card in the page body, this context
 * bridges the two:
 *
 *   - `<TargetAdjustProvider>` is mounted by `<SubPageShell>`, owns the
 *     sheet's open state + which registered target is being edited, and
 *     renders the `<TargetEditSheet>` once a target is open.
 *   - `<MetricTargetSummary>` registers each editable target it paints
 *     (one per category page, except blood glucose which fans out to up
 *     to four per-context targets) via `register()`.
 *   - The header gear reads `canAdjust` to gate its own visibility and
 *     calls `requestAdjust()` to open the editor.
 *
 * Single-target pages open that target's sheet directly. Blood glucose
 * registers several contexts; there is no standalone targets-management
 * surface (target editing lives only on these category pages), so the
 * gear opens the first registered context — every context's threshold
 * is reachable from its own card, and the header gear is the quick path
 * into the primary one.
 */

/**
 * A target whose editor is not the threshold-range sheet: the nutrient
 * targets (an amount and a direction, `/api/nutrients/targets`) bring their
 * own sheet, and the gear only asks the registering card to open it. Same
 * gear, same sheet anatomy, a different store behind it.
 */
export interface CustomAdjustableTarget {
  /** A key unique on the page, e.g. `"NUTRIENT_TARGET"`. */
  type: string;
  /** Opens the registering card's own editor. */
  openEditor: () => void;
  /**
   * What the gear opens, as its accessible name and tooltip ("Set the daily
   * target for Protein"). Without it the gear says "Adjust target range",
   * which names neither which target nor that it is not a range.
   */
  label?: string;
}

export type AdjustableTarget = RangeAdjustableTarget | CustomAdjustableTarget;

function isCustomTarget(
  target: AdjustableTarget,
): target is CustomAdjustableTarget {
  return "openEditor" in target;
}

export interface RangeAdjustableTarget {
  /** Target type literal, e.g. `"WEIGHT"` or `"BLOOD_GLUCOSE_FASTING"`. */
  type: string;
  /** Display label for the sheet heading. */
  label: string;
  /** Display unit, already converted (e.g. mmol/L for a glucose preference). */
  unit: string;
  /** Current range seed for the editor, in the display unit. */
  range: { min: number; max: number };
  /** Diastolic range seed for blood pressure; null otherwise. */
  diastolicRange?: { min: number; max: number } | null;
}

interface TargetAdjustValue {
  /** Whether at least one editable target is registered on this page. */
  canAdjust: boolean;
  /** Register (or update) an editable target. Returns an unregister fn. */
  register: (target: AdjustableTarget) => () => void;
  /** Open the editor for the primary (first-registered) target. */
  requestAdjust: () => void;
  /** The primary target's own label for the gear, when it brings one. */
  primaryLabel: string | null;
}

const TargetAdjustContext = createContext<TargetAdjustValue | null>(null);

export function TargetAdjustProvider({ children }: { children: ReactNode }) {
  // Insertion-ordered registry: a Map keyed by target type so the same
  // card can update its seed on a repaint without duplicating, and the
  // first-registered entry stays the primary one the gear opens.
  const [targets, setTargets] = useState<ReadonlyArray<AdjustableTarget>>([]);
  // The type currently open in the sheet (null when closed).
  const [openType, setOpenType] = useState<string | null>(null);

  // Keep a ref of the latest registry so `requestAdjust` reads the
  // current primary without being recreated on every registration.
  // Synced in an effect (never during render) so the callback identity
  // stays stable across registrations.
  const targetsRef = useRef(targets);
  useEffect(() => {
    targetsRef.current = targets;
  }, [targets]);

  const register = useCallback((target: AdjustableTarget) => {
    setTargets((prev) => {
      const next = prev.filter((entry) => entry.type !== target.type);
      next.push(target);
      return next;
    });
    return () => {
      setTargets((prev) => prev.filter((entry) => entry.type !== target.type));
    };
  }, []);

  const requestAdjust = useCallback(() => {
    const primary = targetsRef.current[0];
    if (!primary) return;
    if (isCustomTarget(primary)) primary.openEditor();
    else setOpenType(primary.type);
  }, []);

  const primary = targets[0];
  const primaryLabel =
    primary && isCustomTarget(primary) ? (primary.label ?? null) : null;
  const value = useMemo<TargetAdjustValue>(
    () => ({
      canAdjust: targets.length > 0,
      register,
      requestAdjust,
      primaryLabel,
    }),
    [targets.length, register, requestAdjust, primaryLabel],
  );

  const found = targets.find((entry) => entry.type === openType);
  const openTarget = found && !isCustomTarget(found) ? found : null;

  return (
    <TargetAdjustContext.Provider value={value}>
      {children}
      {/* The sheet body lazy-mounts on `open`, so a closed page pays
          nothing. Keyed by type so switching the open target remounts a
          clean editor seeded with the right range. */}
      {openTarget ? (
        <TargetEditSheet
          key={openTarget.type}
          targetType={openTarget.type}
          targetLabel={openTarget.label}
          unit={openTarget.unit}
          initialRange={openTarget.range}
          initialDiastolicRange={openTarget.diastolicRange ?? null}
          open
          onOpenChange={(next) => {
            if (!next) setOpenType(null);
          }}
        />
      ) : null}
    </TargetAdjustContext.Provider>
  );
}

/**
 * Returns the target-adjust context, or `null` when no provider is
 * mounted (so dropping a consumer outside an Insights sub-page is a
 * no-op rather than a crash, mirroring `useCoachLaunch()`).
 */
export function useTargetAdjust(): TargetAdjustValue | null {
  return useContext(TargetAdjustContext);
}
