"use client";

/**
 * v1.4.37 W7a — Settings → Export Arztbericht hero card.
 *
 * The doctor-report PDF is HealthLog's flagship export — the artefact a
 * user actually carries into a doctor's appointment. The v1.4.16 phase
 * B7 layout treated it as one of five equal cards in the grid, which
 * undersold the feature. Marc 2026-05-17:
 *
 *   "Können wir unter Einstellungen > Export den Arztbericht als Hero
 *    Card machen?"
 *
 * This component lifts the doctor-report card out of the grid and
 * paints it with the same `hero-gradient + glow-purple` visual treatment
 * as the Insights hero strip (`src/components/insights/hero-strip.tsx`),
 * so the surface feels consistent with the rest of the app. The CTA
 * routes through the existing `<DoctorReportDialog>` + `/api/doctor-
 * report` flow — only the framing changed.
 *
 * Layout:
 *
 *   ┌─ hero ────────────────────────────────────────────┐
 *   │  [icon] eyebrow                                   │
 *   │  H2 title (settings.sections.export.cards.        │
 *   │            doctorReport.title)                    │
 *   │  one-line value statement                         │
 *   │  ─────                                            │
 *   │  [Configure & generate]  PDF · printable          │
 *   └───────────────────────────────────────────────────┘
 *
 * Mobile-first: at < sm the CTA stacks below the value statement (the
 * action row is `flex-wrap`), the hero pads down to `px-4 py-5`, and
 * the title clamps to a single line.
 *
 * a11y:
 *   - The CTA button clears the 44 px touch floor (`min-h-11`).
 *   - `focus-visible:ring` ships via the default `<Button>` variant.
 *   - The CTA is `aria-describedby={valueStatementId}` so a screen
 *     reader announces the value statement alongside the action.
 *   - The hero's `<h2>` slots beneath the page-level `<h1>` so the
 *     outline reads h1 (Export) → h2 (Arztbericht hero) → h2
 *     (Weitere Export-Optionen) → h2 (each remaining card).
 */

import { useEffect, useId, useState } from "react";
import { Loader2, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DoctorReportDialog,
  type DoctorReportSubmitPayload,
} from "@/components/doctor-report/doctor-report-dialog";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

export function ArztberichtHeroCard() {
  const { t, locale } = useTranslations();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [defaultPracticeName, setDefaultPracticeName] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const valueStatementId = useId();

  // Pre-fill the practice name from the user profile so the dialog opens
  // ready-to-submit. Best-effort: if the request fails, the dialog still
  // works without a pre-fill — mirrors the legacy `<DoctorReportCard>`.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json) return;
        const name = json?.data?.lastReportPracticeName;
        if (typeof name === "string") setDefaultPracticeName(name);
      })
      .catch(() => {
        // ignore — pre-fill is a UX nicety
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(payload: DoctorReportSubmitPayload) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/doctor-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          startDate: payload.startDate,
          endDate: payload.endDate,
          practiceName: payload.practiceName,
          sections: payload.sections,
        }),
      });
      if (!res.ok) {
        setError(`${res.status}`);
        return;
      }
      const json = await res.json();
      const { generateDoctorReportPDF } =
        await import("@/lib/doctor-report-pdf");
      const doc = generateDoctorReportPDF(json.data, { t, locale });
      const fileSlug = locale === "de" ? "gesundheitsbericht" : "health-report";
      doc.save(`${fileSlug}-${new Date().toISOString().slice(0, 10)}.pdf`);
      if (payload.practiceName) setDefaultPracticeName(payload.practiceName);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="export-hero-doctor-report"
      aria-labelledby="export-hero-doctor-report-title"
      className={cn(
        "hero-gradient glow-purple animate-insight-in",
        // `isolate` traps the purple glow inside the hero so the
        // shadow doesn't leak through the cards below — same trick
        // the Insights `<HeroStrip>` uses.
        "relative isolate overflow-hidden rounded-xl px-4 py-5 sm:px-6 sm:py-6",
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Stethoscope
              className="text-dracula-purple h-5 w-5 shrink-0"
              aria-hidden="true"
            />
            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("settings.sections.export.hero.eyebrow")}
            </span>
          </div>
          <h2
            id="export-hero-doctor-report-title"
            className="text-2xl leading-tight font-semibold tracking-tight sm:text-[28px]"
          >
            {t("settings.sections.export.cards.doctorReport.title")}
          </h2>
          <p
            id={valueStatementId}
            data-testid="export-hero-doctor-report-value"
            className="text-muted-foreground max-w-2xl text-sm leading-relaxed"
          >
            {t("settings.sections.export.hero.valueStatement")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-4">
          <Button
            data-testid="export-hero-doctor-report-action"
            variant="default"
            // `min-h-11` (44 px) is the WCAG 2.5.5 touch-target floor;
            // we override the default `<Button>` height on mobile and
            // fall back to the compact `sm:h-10` on pointer devices.
            className="h-11 px-5 text-sm font-medium sm:h-10"
            onClick={() => setOpen(true)}
            disabled={busy}
            aria-describedby={valueStatementId}
          >
            {busy && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("settings.sections.export.hero.cta")}
          </Button>
          <span className="text-muted-foreground text-xs">
            {t("settings.sections.export.hero.formatHint")}
          </span>
        </div>

        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
      </div>

      <DoctorReportDialog
        open={open}
        onOpenChange={setOpen}
        defaultPracticeName={defaultPracticeName}
        onSubmit={handleSubmit}
      />
    </section>
  );
}
