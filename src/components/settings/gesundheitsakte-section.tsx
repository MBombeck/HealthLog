"use client";

/**
 * v1.18.0 (S5) — Settings → Gesundheitsakte (health record).
 *
 * The full health-record export is a distinct concept — a complete,
 * clinician-ready record (PDF + FHIR R4 + a combined zip package) — and earns
 * its own top-level settings home rather than sharing the page with the
 * generic CSV / JSON data-out paths.
 *
 * The `doctorReport` module governs the data layer, not the Settings
 * entry-point: as of v1.18.6.1 the nav entry always shows (the health record
 * is a flagship export capability and should never silently vanish from
 * Settings). The server-side `/api/export/health-record` route is the hard
 * enforcement — it refuses with a 403 `module.disabled` envelope when the
 * account has opted out, so a disabled doctor-report surface cannot be
 * reached over a Bearer token either.
 *
 * v1.25.7 — the clinician share-link surface (formerly the standalone
 * "Freigabe" section) folds in here as a labelled "Sharing" group below the
 * export panel: a time-boxed read-only link is a sharing face of the SAME
 * health record. `/settings/sharing` 301-redirects to
 * `/settings/gesundheitsakte#sharing`. The backing model, the
 * `/api/share-links` routes, and the public `/c/[token]` view are unchanged.
 */

import { Share2 } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { HealthRecordExportPanel } from "@/components/settings/report-selection/selection-panel";
import { SectionHeading } from "@/components/ui/section-heading";
import { SharingSection } from "@/components/settings/sharing-section";

export function GesundheitsakteSection() {
  const { t } = useTranslations();

  // v1.18.6 (W9) — the visible page heading + subtitle come from the shared
  // `<SettingsSectionFrame>` in the route; the export panel is the primary
  // surface, with the share-links group sequenced below it.
  return (
    <div className="space-y-10">
      <HealthRecordExportPanel />

      <section id="sharing" className="scroll-mt-28 space-y-4">
        <SectionHeading
          // The module tour's "export" stop (the doctor report) anchors here.
          tourId="export-hero"
          icon={Share2}
          title={t("settings.sections.sharing.title")}
          subtitle={t("settings.sections.sharing.subtitle")}
        />
        <SharingSection />
      </section>
    </div>
  );
}
