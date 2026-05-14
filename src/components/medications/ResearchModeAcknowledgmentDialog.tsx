"use client";

/**
 * v1.4.25 W19c-Frontend — Research-mode MDR acknowledgment dialog.
 *
 * Opt-in gate in front of the GLP-1 drug-level chart. The chart paints
 * a unit-less Bateman PK curve over the user's logged intakes (research
 * §2.3 / §9.6.7). Because a "drug-level" surface is the brightest EU
 * MDR Class IIa edge in HealthLog's surface area (research §11 + §12.4),
 * the chart never paints until the user has explicitly read and
 * acknowledged the disclaimer below. The acknowledgment record is
 * server-stamped with `RESEARCH_MODE_DISCLAIMER_VERSION`; if the copy
 * changes the user re-acknowledges before the chart unhides.
 *
 * The dialog is rendered controlled by the Settings toggle and the
 * "re-prompt" banner (commit 3 of this phase). It accepts:
 *   - `open` / `onOpenChange` for full external control
 *   - `currentDisclaimerVersion` — the server's authoritative version
 *     string. Acknowledgment posts THIS value, not the imported
 *     constant — server redeploys that bump the constant must be
 *     reflected without a client reload (W19c-Backend phase report).
 *   - `onAcknowledged()` — fires after a successful 200; the caller
 *     re-fetches the research-mode state and renders the toggle in
 *     the new state.
 *
 * Copy direction (Marc-Voice, English, no AI/phase/wave mentions):
 *   - "What this is" — single-paragraph framing: the chart is an
 *     estimate from EMA-published population PK.
 *   - "What this isn't" — explicit boundary: not a measurement, not
 *     personalised, not medical advice.
 *   - "Why it's an estimate" — population PK + IIV; per-patient
 *     variation is large.
 *   - "MDR boundary" — cite EU 2017/745 and MDCG 2021-24 verbatim.
 *   - "Citations" — EMA EPAR + Schneck/Urva 2024 (ASCPT psp4.13099).
 *
 * Toast surface uses sonner (the project convention) so the user gets
 * a transient confirmation on either success or rejection.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, BookOpenCheck, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

export interface ResearchModeAcknowledgmentDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /**
   * The version string from `GET /api/auth/me/research-mode`. The
   * server compares it byte-for-byte against the current constant; a
   * stale value forces a 400 from the API which we surface as an
   * error toast and keep the dialog open. Pass `null` while the
   * GET is in flight; the Acknowledge CTA stays disabled.
   */
  currentDisclaimerVersion: string | null;
  /**
   * Fires after the POST returns 200. Caller invalidates the
   * `research-mode` query so the toggle reflects the new state.
   */
  onAcknowledged?: () => void;
}

export function ResearchModeAcknowledgmentDialog({
  open,
  onOpenChange,
  currentDisclaimerVersion,
  onAcknowledged,
}: ResearchModeAcknowledgmentDialogProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (version: string) => {
      const res = await fetch("/api/auth/me/research-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true, version }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code =
          typeof json?.error === "string"
            ? json.error
            : `http-${res.status}`;
        throw new Error(code);
      }
      return json?.data ?? null;
    },
    onSuccess: () => {
      setErrorMessage(null);
      toast.success(t("medications.researchMode.dialog.successToast"));
      queryClient.invalidateQueries({ queryKey: ["research-mode"] });
      onAcknowledged?.();
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      // The 400 stale-version path is the only one we surface
      // explicitly — every other failure mode (401, 429, 500, network)
      // collapses to a generic error so the dialog stays open but the
      // user knows the acknowledgment didn't persist.
      const code = err instanceof Error ? err.message : "unknown";
      const isStale = code === "research-mode.version.stale";
      const message = isStale
        ? t("medications.researchMode.dialog.staleVersionToast")
        : t("medications.researchMode.dialog.errorToast");
      setErrorMessage(message);
      toast.error(message);
    },
  });

  function handleAcknowledge() {
    if (!currentDisclaimerVersion) return;
    mutation.mutate(currentDisclaimerVersion);
  }

  function handleCancel() {
    setErrorMessage(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="research-mode-acknowledgment-dialog"
        className="flex max-h-[90vh] flex-col sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpenCheck className="text-dracula-purple h-5 w-5 shrink-0" />
            {t("medications.researchMode.dialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("medications.researchMode.dialog.intro")}
          </DialogDescription>
        </DialogHeader>

        {/* Only the body scrolls; header + footer stay pinned so the
            Acknowledge / Cancel CTAs are always reachable without
            scrolling on small viewports (the previous markup scrolled
            the entire DialogContent, pushing the footer below the
            fold on iPhone-class heights). */}
        <div className="-mr-2 flex-1 space-y-4 overflow-y-auto pr-2 text-sm">
          <section
            aria-labelledby="research-mode-what-it-is"
            data-slot="research-mode-what-it-is"
          >
            <h3
              id="research-mode-what-it-is"
              className="text-foreground font-medium"
            >
              {t("medications.researchMode.dialog.whatItIsHeader")}
            </h3>
            <p className="text-muted-foreground mt-1">
              {t("medications.researchMode.dialog.whatItIs")}
            </p>
          </section>

          <section
            aria-labelledby="research-mode-what-it-isnt"
            data-slot="research-mode-what-it-isnt"
          >
            <h3
              id="research-mode-what-it-isnt"
              className="text-foreground font-medium"
            >
              {t("medications.researchMode.dialog.whatItIsntHeader")}
            </h3>
            <p className="text-muted-foreground mt-1">
              {t("medications.researchMode.dialog.whatItIsnt")}
            </p>
          </section>

          <section
            aria-labelledby="research-mode-why-estimate"
            data-slot="research-mode-why-estimate"
          >
            <h3
              id="research-mode-why-estimate"
              className="text-foreground font-medium"
            >
              {t("medications.researchMode.dialog.whyEstimateHeader")}
            </h3>
            <p className="text-muted-foreground mt-1">
              {t("medications.researchMode.dialog.whyEstimate")}
            </p>
          </section>

          <section
            aria-labelledby="research-mode-mdr"
            data-slot="research-mode-mdr-boundary"
            className="bg-warning/10 border-warning/30 rounded-md border-l-4 px-3 py-2"
          >
            <h3
              id="research-mode-mdr"
              className="text-foreground flex items-center gap-2 font-medium"
            >
              <AlertTriangle
                className="text-warning h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              {t("medications.researchMode.dialog.mdrBoundaryHeader")}
            </h3>
            <p className="text-foreground/85 mt-1">
              {t("medications.researchMode.dialog.mdrBoundary")}
            </p>
          </section>

          <section
            aria-labelledby="research-mode-citations"
            data-slot="research-mode-citations"
          >
            <h3
              id="research-mode-citations"
              className="text-foreground font-medium"
            >
              {t("medications.researchMode.dialog.citationsHeader")}
            </h3>
            <p className="text-muted-foreground mt-1">
              {t("medications.researchMode.dialog.citations")}
            </p>
          </section>

          {currentDisclaimerVersion && (
            <p
              className="text-muted-foreground text-xs italic"
              data-slot="research-mode-version"
            >
              {t("medications.researchMode.dialog.versionLine", {
                version: currentDisclaimerVersion,
              })}
            </p>
          )}

          {errorMessage && (
            <p
              role="alert"
              className="text-destructive text-sm"
              data-slot="research-mode-error"
            >
              {errorMessage}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={mutation.isPending}
            data-slot="research-mode-cancel"
          >
            {t("medications.researchMode.dialog.cancelCta")}
          </Button>
          <Button
            onClick={handleAcknowledge}
            disabled={mutation.isPending || !currentDisclaimerVersion}
            data-slot="research-mode-acknowledge"
          >
            {mutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {t("medications.researchMode.dialog.acknowledgeCta")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
