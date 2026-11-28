"use client";

import { useState } from "react";

import { Loader2 } from "lucide-react";

import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Button } from "@/components/ui/button";
import { InjectionSitePicker } from "@/components/medications/injection-site-picker";
import {
  effectiveAllowedSites,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";
import { useTranslations } from "@/lib/i18n/context";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * v1.8.5 — post-dose injection-site capture.
 *
 * Shown after a taken dose for a medication with
 * `deliveryForm === "INJECTION"` and `trackInjectionSites === true`. The
 * capture is OPTIONAL and always skippable — closing or "skip" records
 * no site, the dose stays logged regardless. The picker is constrained
 * to the medication's effective allowed set (per-medication allowed sites
 * minus the user's global exclusion), and the rotation suggestion runs
 * within that set.
 */
interface LogInjectionSiteDialogProps {
  open: boolean;
  medicationName: string;
  /** Per-medication allowed / preferred sites ([] = no restriction). */
  allowedInjectionSites: ReadonlyArray<InjectionSiteKey>;
  /** User-level global exclusion deny-list. */
  globalExcludedInjectionSites: ReadonlyArray<InjectionSiteKey>;
  /** Recent rotation history (most recent first) for the dashed-ring hint. */
  history: ReadonlyArray<InjectionSiteKey>;
  /**
   * Submit the chosen site (the parent PATCHes it onto the intake). The
   * handler may be async; the dialog stays open with a pending state until
   * it resolves and rejects (throws) on failure so the dialog can keep the
   * user's selection rather than dismissing optimistically.
   */
  onConfirm: (site: InjectionSiteKey) => void | Promise<void>;
  /** Dismiss without recording a site (the dose stays taken). */
  onSkip: () => void;
}

export function LogInjectionSiteDialog({
  open,
  medicationName,
  allowedInjectionSites,
  globalExcludedInjectionSites,
  history,
  onConfirm,
  onSkip,
}: LogInjectionSiteDialogProps) {
  const { t } = useTranslations();
  const [selected, setSelected] = useState<InjectionSiteKey | null>(null);
  // v1.11.5 — the dialog used to dismiss optimistically the instant the
  // confirm fired, before the PATCH resolved and with no pending state.
  // It now stays open and disabled until the parent's handler settles; the
  // parent throws on failure so a rejected PATCH keeps the dialog (and the
  // chosen site) in place.
  const [submitting, setSubmitting] = useState(false);

  const allowed = effectiveAllowedSites(
    allowedInjectionSites,
    globalExcludedInjectionSites,
  );

  async function handleConfirm() {
    if (selected === null || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(selected);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(next) => {
        // Hold the dialog while the PATCH is in flight so a backdrop tap /
        // Esc can't dismiss mid-request.
        if (submitting) return;
        if (!next) onSkip();
      }}
      title={t("medications.logInjectionSiteTitle")}
      description={t("medications.logInjectionSiteDescription", {
        name: medicationName,
      })}
      footer={
        <>
          <Button variant="outline" onClick={onSkip} disabled={submitting}>
            {t("medications.logInjectionSiteSkip")}
          </Button>
          <Button
            disabled={selected === null || submitting}
            aria-busy={submitting || undefined}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("medications.logInjectionSiteConfirm")}
          </Button>
        </>
      }
    >
      {allowed.length === 0 ? (
        <EmptyState
          variant="plain"
          title={t("medications.logInjectionSiteNoneAvailable")}
        />
      ) : (
        <>
          <InjectionSitePicker
            value={selected}
            history={history}
            allowed={allowed}
            onChange={setSelected}
          />
          {/* Marker legend — explains the two body-map annotations so the
                dashed primary ring and the amber ring read at a glance. The
                swatches mirror the picker's own marker strokes exactly. */}
          <ul
            className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs"
            aria-label={t("medications.injectionSiteLegendAriaLabel")}
          >
            <li className="flex items-center gap-1.5">
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              >
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="none"
                  className="stroke-primary"
                  strokeWidth="1.6"
                  strokeDasharray="3 3"
                />
              </svg>
              {t("medications.injectionSiteLegendRecommended")}
            </li>
            <li className="flex items-center gap-1.5">
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              >
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="none"
                  className="stroke-[var(--warning)]"
                  strokeWidth="1.8"
                />
              </svg>
              {t("medications.injectionSiteLegendLastUsed")}
            </li>
          </ul>
        </>
      )}
    </ResponsiveSheet>
  );
}
